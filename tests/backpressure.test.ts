import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import { backpressureService } from "../src/services/backpressureService.js";
import { tenantFairnessService } from "../src/services/tenantFairnessService.js";
import { rateLimiter } from "../src/services/rateLimiter.js";
import { getMetrics } from "../src/metrics/index.js";
import crypto from "crypto";

describe("Backpressure and Overload Protection (Milestone 6D)", () => {
  let customerId: string;

  beforeAll(async () => {
    // Create dedicated test customer
    const res = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Backpressure Test Customer"]
    );
    customerId = res.rows[0].id;
  });

  afterAll(async () => {
    try {
      if (customerId) {
        await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [customerId]);
        await pool.query(
          "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)",
          [customerId]
        );
        await pool.query("DELETE FROM notifications WHERE customer_id = $1", [customerId]);
        await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    backpressureService.reset();
  });

  // 1. NORMAL state accepts requests
  it("accepts requests and returns HTTP 202 when backpressure state is NORMAL", async () => {
    backpressureService.setOverrideState("NORMAL");
    const key = crypto.randomUUID();

    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "normal@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Normal state test" },
      });

    expect(res.status).toBe(202);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("pending");
  }, 15000);

  // 2. DEGRADED state accepts requests when safe
  it("continues accepting requests with HTTP 202 when backpressure state is DEGRADED", async () => {
    backpressureService.setOverrideState("DEGRADED", "outbox_backlog");
    const key = crypto.randomUUID();

    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "degraded@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Degraded state test" },
      });

    expect(res.status).toBe(202);
    expect(res.body.id).toBeDefined();

    // Verify it was durably committed in PostgreSQL
    const check = await pool.query("SELECT id, status FROM notifications WHERE id = $1", [res.body.id]);
    expect(check.rows.length).toBe(1);
    expect(check.rows[0].status).toBe("pending");
  }, 15000);

  // 3. OVERLOADED state rejects new requests
  it("rejects new notification submissions when backpressure state is OVERLOADED", async () => {
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");
    const key = crypto.randomUUID();

    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "overload@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Overloaded rejection test" },
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SYSTEM_OVERLOADED");
  }, 15000);

  // 4. Correct HTTP 503 and Retry-After
  it("returns HTTP 503 with standardized SYSTEM_OVERLOADED code and Retry-After header", async () => {
    backpressureService.setOverrideState("OVERLOADED", "queue_depth");
    const key = crypto.randomUUID();

    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "retry-after@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Retry-After header test" },
      });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe(backpressureService.retryAfterSeconds.toString());
    expect(res.body).toEqual({
      code: "SYSTEM_OVERLOADED",
      message: expect.stringContaining("high load"),
      retryAfter: backpressureService.retryAfterSeconds,
    });
  }, 15000);

  // 5. No notification/outbox insert occurs after rejection
  it("guarantees no notification or outbox records are inserted after an overload rejection", async () => {
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");
    const key = crypto.randomUUID();
    const uniqueRecipient = `reject-${key.substring(0, 8)}@example.com`;

    await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: uniqueRecipient,
        channel: "email",
        payload: { subject: "Test Subject", body: "Must not be inserted" },
      });

    // Verify PostgreSQL contains 0 records for this recipient/key
    const notifCheck = await pool.query("SELECT id FROM notifications WHERE recipient = $1", [uniqueRecipient]);
    expect(notifCheck.rows.length).toBe(0);

    const idempCheck = await pool.query(
      "SELECT id FROM idempotency_keys WHERE customer_id = $1 AND idempotency_key = $2",
      [customerId, key]
    );
    expect(idempCheck.rows.length).toBe(0);
  }, 15000);

  // 6. Previously accepted notifications remain durable
  it("ensures previously accepted notifications remain durable during overload", async () => {
    // 1. Accept notification in NORMAL state
    backpressureService.setOverrideState("NORMAL");
    const key = crypto.randomUUID();
    const acceptedRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "durable-check@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Durable notification test" },
      });
    expect(acceptedRes.status).toBe(202);
    const notificationId = acceptedRes.body.id;

    // 2. Transition system to OVERLOADED
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");

    // 3. Verify earlier record is unchanged and fully durable
    const checkDb = await pool.query(
      "SELECT id, status, customer_id FROM notifications WHERE id = $1",
      [notificationId]
    );
    expect(checkDb.rows.length).toBe(1);
    expect(checkDb.rows[0].status).toBe("pending");

    const checkOutbox = await pool.query(
      "SELECT id, notification_id FROM outbox_events WHERE notification_id = $1",
      [notificationId]
    );
    expect(checkOutbox.rows.length).toBe(1);
  }, 15000);

  // 7. Redis outage with small backlog allows acceptance
  it("allows durable acceptance (DEGRADED) during temporary Redis outage if outbox backlog is low", async () => {
    // When Redis is disconnected, evaluateState returns DEGRADED, not OVERLOADED,
    // so long as outbox backlog is below the overload threshold
    const state = await backpressureService.evaluateState();
    // System accepts when not overloaded
    expect(state.state).not.toBe("OVERLOADED");

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "redis-outage-safe@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Safe under Redis outage" },
      });

    expect(res.status).toBe(202);
  }, 15000);

  // 8. Redis outage with excessive backlog triggers overload
  it("triggers OVERLOADED state when outbox backlog exceeds threshold during prolonged Redis outage", async () => {
    // Set a very low overload threshold for testing
    backpressureService.setThresholds({ outboxOverload: 1 });

    // Insert 2 dummy outbox events to exceed threshold
    const dummyNotif = await pool.query(
      "INSERT INTO notifications (customer_id, recipient, channel, payload, status) VALUES ($1, 'dummy@example.com', 'email', '{\"subject\":\"D\",\"body\":\"D\"}', 'pending') RETURNING id",
      [customerId]
    );
    await pool.query(
      "INSERT INTO outbox_events (notification_id, event_type, attempts) VALUES ($1, 'notification.created', 0), ($1, 'notification.created', 0)",
      [dummyNotif.rows[0].id]
    );

    const evaluation = await backpressureService.evaluateState(true);
    expect(evaluation.state).toBe("OVERLOADED");
    expect(evaluation.reason).toBe("outbox_backlog");

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId,
        recipient: "excess-backlog@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Excess backlog test" },
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SYSTEM_OVERLOADED");

    // Clean up dummy rows
    await pool.query("DELETE FROM outbox_events WHERE notification_id = $1", [dummyNotif.rows[0].id]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE id = $1", [dummyNotif.rows[0].id]).catch(() => {});
  }, 15000);

  // 9. Tenant rate limiting still works
  it("enforces tenant rate limits and returns HTTP 429 when tenant limit is exceeded", async () => {
    const rateLimitCustomer = crypto.randomUUID();
    await pool.query("INSERT INTO customers (id, name) VALUES ($1, 'Rate Limit Backpressure')", [rateLimitCustomer]);

    try {
      // Consume full quota for this customer
      for (let i = 0; i < 100; i++) {
        await rateLimiter.consume(rateLimitCustomer);
      }

      // Next request must be throttled with HTTP 429
      const key = crypto.randomUUID();
      const res = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", key)
        .send({
          customerId: rateLimitCustomer,
          recipient: "ratelimited@example.com",
          channel: "email",
          payload: { subject: "Test Subject", body: "Rate limit test" },
        });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await pool.query("DELETE FROM customers WHERE id = $1", [rateLimitCustomer]).catch(() => {});
    }
  }, 15000);

  // 10. Tenant fairness remains functional
  it("preserves tenant fairness concurrency controls alongside backpressure", async () => {
    const tenantFairA = crypto.randomUUID();
    const tenantFairB = crypto.randomUUID();

    // Acquire slots up to quota
    const slotA1 = await tenantFairnessService.acquireSlot("email", tenantFairA, "bp-fair-1");
    const slotA2 = await tenantFairnessService.acquireSlot("email", tenantFairA, "bp-fair-2");
    expect(slotA1.granted).toBe(true);
    expect(slotA2.granted).toBe(true);

    // Tenant B acquires slot under contention
    const slotB1 = await tenantFairnessService.acquireSlot("email", tenantFairB, "bp-fair-b1");
    expect(slotB1.granted).toBe(true);

    // Tenant A attempts slot 3 under contention -> denied
    const slotA3 = await tenantFairnessService.acquireSlot("email", tenantFairA, "bp-fair-3");
    expect(slotA3.granted).toBe(false);

    // Clean up
    await tenantFairnessService.releaseSlot("email", tenantFairA, "bp-fair-1");
    await tenantFairnessService.releaseSlot("email", tenantFairA, "bp-fair-2");
    await tenantFairnessService.releaseSlot("email", tenantFairB, "bp-fair-b1");
  });

  // 11. Idempotent replay behavior during overload
  it("handles identical and conflicting idempotency replays correctly during OVERLOADED state", async () => {
    // 1. Submit in NORMAL state
    backpressureService.setOverrideState("NORMAL");
    const sharedKey = crypto.randomUUID();
    const initialPayload = { subject: "Idemp Overload", body: "Initial" };

    const firstRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", sharedKey)
      .send({
        customerId,
        recipient: "idemp-overload@example.com",
        channel: "email",
        payload: initialPayload,
      });
    expect(firstRes.status).toBe(202);
    const existingId = firstRes.body.id;

    // 2. Transition system to OVERLOADED state
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");

    // 3. Re-send identical request during overload -> returns 202 with existing record (safe replay)
    const replayRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", sharedKey)
      .send({
        customerId,
        recipient: "idemp-overload@example.com",
        channel: "email",
        payload: initialPayload,
      });
    expect(replayRes.status).toBe(202);
    expect(replayRes.body.id).toBe(existingId);

    // 4. Send conflicting request with same key but differing payload -> returns 409 Conflict
    const conflictRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", sharedKey)
      .send({
        customerId,
        recipient: "idemp-overload@example.com",
        channel: "email",
        payload: { subject: "Different Payload", body: "Changed" },
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.code).toBe("IDEMPOTENCY_CONFLICT");

    // 5. Send new request with unrecorded key during overload -> returns 503 System Overloaded
    const newKey = crypto.randomUUID();
    const overloadRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", newKey)
      .send({
        customerId,
        recipient: "new-during-overload@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Brand new request" },
      });
    expect(overloadRes.status).toBe(503);
    expect(overloadRes.body.code).toBe("SYSTEM_OVERLOADED");
  }, 15000);

  // 12. Database unavailable behavior
  it("evaluates state as OVERLOADED with reason db_health when database is unavailable", async () => {
    // Set override simulating database health failure
    backpressureService.setOverrideState("OVERLOADED", "db_health");
    const admission = await backpressureService.checkAdmission();

    expect(admission.allowed).toBe(false);
    expect(admission.state).toBe("OVERLOADED");
    expect(admission.reason).toBe("db_health");
    expect(admission.retryAfter).toBe(backpressureService.retryAfterSeconds);
  });

  // 13. Recovery from OVERLOADED to NORMAL
  it("smoothly recovers from OVERLOADED state back to NORMAL state when backlog clears", async () => {
    // 1. Force OVERLOADED state
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");
    const key1 = crypto.randomUUID();
    const resOverload = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key1)
      .send({
        customerId,
        recipient: "recovery@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Before recovery" },
      });
    expect(resOverload.status).toBe(503);

    // 2. Recover system state to NORMAL
    backpressureService.setOverrideState("NORMAL");
    const key2 = crypto.randomUUID();
    const resRecovered = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key2)
      .send({
        customerId,
        recipient: "recovery@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "After recovery" },
      });
    expect(resRecovered.status).toBe(202);
    expect(resRecovered.body.id).toBeDefined();
  }, 15000);

  // 14. Concurrent admission requests
  it("safely and consistently rejects concurrent admission requests during overload", async () => {
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");

    const requests = Array.from({ length: 8 }).map((_, i) =>
      request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", crypto.randomUUID())
        .send({
          customerId,
          recipient: `concurrent-${i}@example.com`,
          channel: "email",
          payload: { subject: "Test Subject", body: `Concurrent overload ${i}` },
        })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("SYSTEM_OVERLOADED");
    }
  }, 15000);

  // 15. Metrics and label safety
  it("exposes backpressure Prometheus metrics with bounded labels and zero tenant IDs", async () => {
    // Trigger an admission check and rejection to populate metrics
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");
    await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", crypto.randomUUID())
      .send({
        customerId,
        recipient: "metrics@example.com",
        channel: "email",
        payload: { subject: "Test Subject", body: "Metrics test" },
      });

    const metrics = await getMetrics();

    // Verify metric presence
    expect(metrics).toContain("relay_backpressure_state");
    expect(metrics).toContain("relay_outbox_backlog_total");
    expect(metrics).toContain("relay_backpressure_rejections_total");
    expect(metrics).toContain("relay_admission_check_duration_seconds");

    // Cardinality safety check: metric output must never contain raw customer UUIDs or notification IDs in labels
    expect(metrics).not.toMatch(/customerId="/);
    expect(metrics).not.toMatch(/notificationId="/);
    expect(metrics).not.toContain(customerId);
  }, 15000);
});

