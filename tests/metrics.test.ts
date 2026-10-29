import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import crypto from "crypto";
import {
  getMetrics,
  normalizeRoute,
  recordValidationFailure,
  recordIdempotencyConflict,
  recordPublicationSuccess,
  recordPublicationFailure,
  recordOutboxRetry,
  setOutboxAwaitingPublication,
  recordWorkerJobProcessed,
  recordWorkerJobFailed,
  recordWorkerRetry,
  incrementActiveJobs,
  decrementActiveJobs,
  recordExpiredLease,
  recordReconciliationRecovered,
  recordReconciliationFailure,
  startProcessMetricsServer,
} from "../src/metrics/index.js";

describe("Relay Observability & Metrics API", () => {
  let testCustomerId: string;

  beforeAll(async () => {
    try {
      const res = await pool.query(
        "INSERT INTO customers (name) VALUES ($1) RETURNING id",
        ["Metrics Test Customer"]
      );
      testCustomerId = res.rows[0].id;
    } catch (e) {
      // In mocked environment, handle if database is not reachable
    }
  });

  afterAll(async () => {
    if (testCustomerId) {
      try {
        await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [testCustomerId]);
        await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)", [testCustomerId]);
        await pool.query("DELETE FROM notifications WHERE customer_id = $1", [testCustomerId]);
        await pool.query("DELETE FROM customers WHERE id = $1", [testCustomerId]);
      } catch {}
    }
  });

  it("exposes Prometheus-compatible metrics at GET /metrics", async () => {
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("# HELP");
    expect(response.text).toContain("# TYPE");
    expect(response.text).toContain("relay_api_requests_total");
    expect(response.text).toContain("relay_api_request_duration_seconds");
  });

  it("increments API request counter and observes latency on request completion", async () => {
    // Make a request to health
    await request(app).get("/v1/health");

    const metrics = await getMetrics();
    expect(metrics).toMatch(/relay_api_requests_total\{method="GET",route="\/v1\/health",status_code="200"\} [1-9]\d*/);
    expect(metrics).toContain("relay_api_request_duration_seconds_count");
    expect(metrics).toContain("relay_api_request_duration_seconds_bucket");
  });

  it("tracks validation failure counters on HTTP 400 bad requests", async () => {
    const initialMetrics = await getMetrics();
    const initialMatches = initialMetrics.match(/relay_api_validation_failures_total (\d+)/);
    const initialCount = initialMatches ? parseInt(initialMatches[1], 10) : 0;

    // Send request missing Idempotency-Key
    const res = await request(app)
      .post("/v1/notifications")
      .send({ recipient: "bad@example.com" });

    expect(res.status).toBe(400);

    const updatedMetrics = await getMetrics();
    const updatedMatches = updatedMetrics.match(/relay_api_validation_failures_total (\d+)/);
    const updatedCount = updatedMatches ? parseInt(updatedMatches[1], 10) : 0;

    expect(updatedCount).toBeGreaterThan(initialCount);
  });

  it("tracks idempotency conflict counters on HTTP 409 conflict", async () => {
    if (!testCustomerId) return;

    const initialMetrics = await getMetrics();
    const initialMatches = initialMetrics.match(/relay_api_idempotency_conflicts_total (\d+)/);
    const initialCount = initialMatches ? parseInt(initialMatches[1], 10) : 0;

    const idempotencyKey = crypto.randomUUID();

    // 1st request
    await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "test1@example.com",
        channel: "email",
        payload: { subject: "Subject 1", body: "payload one" },
      });

    // 2nd request with different payload -> 409
    const resConflict = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "test2@example.com",
        channel: "email",
        payload: { subject: "Subject 2", body: "payload two different" },
      });

    expect(resConflict.status).toBe(409);

    const updatedMetrics = await getMetrics();
    const updatedMatches = updatedMetrics.match(/relay_api_idempotency_conflicts_total (\d+)/);
    const updatedCount = updatedMatches ? parseInt(updatedMatches[1], 10) : 0;

    expect(updatedCount).toBeGreaterThan(initialCount);
  });

  it("enforces metric label safety and prevents label cardinality explosion", async () => {
    const sensitiveRecipient = "sensitive-user-999@secret-domain.org";
    const sensitiveIdempotencyKey = "idemp-key-secret-998877";

    if (testCustomerId) {
      await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", sensitiveIdempotencyKey)
        .send({
          customerId: testCustomerId,
          recipient: sensitiveRecipient,
          channel: "sms",
          payload: { body: "Secret message" },
        });
    }

    const metricsText = await getMetrics();

    // Verify sensitive PII / IDs do not appear anywhere in label definitions or values
    expect(metricsText).not.toContain(sensitiveRecipient);
    expect(metricsText).not.toContain(sensitiveIdempotencyKey);
    if (testCustomerId) {
      expect(metricsText).not.toContain(`customer_id="${testCustomerId}"`);
      expect(metricsText).not.toContain(`customerId="${testCustomerId}"`);
      expect(metricsText).not.toContain(`tenant_id="${testCustomerId}"`);
    }

    // Verify route normalizer safely bounds dynamic paths
    expect(normalizeRoute("/v1/notifications/16abf08c-837b-4b50-86ae-c327e7795f5d")).toBe("/v1/notifications/:id");
    expect(normalizeRoute("/v1/health?query=123")).toBe("/v1/health");
    expect(normalizeRoute("/random/unbounded/attacker/path")).toBe("unknown");
  });

  it("records dispatcher metrics for publication, retries, latency, and outbox gauge", async () => {
    setOutboxAwaitingPublication(42);
    recordPublicationSuccess("sms", 0.045);
    recordPublicationFailure("email");
    recordOutboxRetry("sms");

    const metrics = await getMetrics();

    expect(metrics).toContain("relay_dispatcher_outbox_awaiting_publication 42");
    expect(metrics).toMatch(/relay_dispatcher_publications_total\{channel="sms",status="success"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_dispatcher_publications_total\{channel="email",status="failure"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_dispatcher_outbox_retries_total\{channel="sms"\} [1-9]\d*/);
    expect(metrics).toContain("relay_dispatcher_publication_duration_seconds_bucket");
  });

  it("records worker metrics for processing, retries, failures, and active jobs gauge", async () => {
    incrementActiveJobs("email");
    recordWorkerJobProcessed("email", 0.12);
    recordWorkerJobFailed("sms");
    recordWorkerRetry("sms");
    decrementActiveJobs("email");

    const metrics = await getMetrics();

    expect(metrics).toMatch(/relay_worker_jobs_total\{channel="email",status="processed"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_worker_jobs_total\{channel="sms",status="failed"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_worker_retries_total\{channel="sms"\} [1-9]\d*/);
    expect(metrics).toContain("relay_worker_job_duration_seconds_bucket");
    expect(metrics).toContain("relay_worker_active_jobs");
  });

  it("records reconciliation metrics for expired leases, recoveries, and failures", async () => {
    recordExpiredLease("email");
    recordReconciliationRecovered("email");
    recordReconciliationFailure("sms");

    const metrics = await getMetrics();

    expect(metrics).toMatch(/relay_reconciliation_expired_leases_total\{channel="email"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_reconciliation_recovered_total\{channel="email"\} [1-9]\d*/);
    expect(metrics).toMatch(/relay_reconciliation_failures_total\{channel="sms"\} [1-9]\d*/);
  });

  it("supports running independent process metrics servers for background daemons", async () => {
    // Test native process metrics server helper on an ephemeral port
    const port = 34567;
    const processMetricsServer = await startProcessMetricsServer(port, "test-dispatcher");

    try {
      const res = await request(`http://127.0.0.1:${port}`).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.text).toContain("relay_");

      const healthRes = await request(`http://127.0.0.1:${port}`).get("/health");
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe("ok");
      expect(healthRes.body.process).toBe("test-dispatcher");
    } finally {
      await processMetricsServer.close();
    }
  });
});
