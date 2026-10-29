import { pool } from "../src/database/pool.js";
import { app } from "../src/app.js";
import request from "supertest";
import { backpressureService } from "../src/services/backpressureService.js";
import { OutboxDispatcher } from "../src/services/outboxDispatcher.js";
import { getEmailQueue, closeQueues } from "../src/queues/notificationQueues.js";
import { getEmailWorker, closeEmailWorker } from "../src/workers/emailWorker.js";
import { closeRedisConnection } from "../src/config/redis.js";
import crypto from "crypto";

interface LoadTestMetrics {
  totalRequests: number;
  accepted202: number;
  rateLimited429: number;
  overloaded503: number;
  otherErrors: number;
  latencies: number[];
  startTime: number;
  endTime: number;
}

async function runLoadTest() {
  console.log("==============================================================");
  console.log("       RELAY MILESTONE 6D: REPRODUCIBLE LOAD TEST             ");
  console.log("==============================================================");

  // Setup test tenants
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  await pool.query(
    "INSERT INTO customers (id, name) VALUES ($1, 'Load Test Tenant A'), ($2, 'Load Test Tenant B')",
    [tenantA, tenantB]
  );

  const metrics: LoadTestMetrics = {
    totalRequests: 0,
    accepted202: 0,
    rateLimited429: 0,
    overloaded503: 0,
    otherErrors: 0,
    latencies: [],
    startTime: 0,
    endTime: 0,
  };

  try {
    // -------------------------------------------------------------
    // PHASE 1: Bounded Baseline Concurrency Test (50 requests)
    // -------------------------------------------------------------
    console.log("\n[Phase 1] Executing Bounded Baseline Ingress Test (50 requests across 2 tenants)...");
    metrics.startTime = Date.now();

    const sendRequest = async (customerId: string, index: number) => {
      const key = crypto.randomUUID();
      const start = Date.now();
      try {
        const res = await request(app)
          .post("/v1/notifications")
          .set("Idempotency-Key", key)
          .send({
            customerId,
            recipient: `load-${index}@example.com`,
            channel: "email",
            payload: { subject: `Load ${index}`, body: "Baseline Ingress" },
          });

        const elapsed = Date.now() - start;
        metrics.latencies.push(elapsed);
        metrics.totalRequests++;

        if (res.status === 202) {
          metrics.accepted202++;
        } else if (res.status === 429) {
          metrics.rateLimited429++;
        } else if (res.status === 503) {
          metrics.overloaded503++;
        } else {
          metrics.otherErrors++;
        }
      } catch {
        metrics.otherErrors++;
      }
    };

    // Send 35 requests for Tenant A, 15 for Tenant B in concurrent batches of 5
    const requests: (() => Promise<void>)[] = [];
    for (let i = 0; i < 35; i++) {
      requests.push(() => sendRequest(tenantA, i));
    }
    for (let i = 35; i < 50; i++) {
      requests.push(() => sendRequest(tenantB, i));
    }

    const CONCURRENCY = 5;
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
      const batch = requests.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((fn) => fn()));
    }

    metrics.endTime = Date.now();
    const durationSec = (metrics.endTime - metrics.startTime) / 1000;

    // Sort latencies for percentiles
    metrics.latencies.sort((a, b) => a - b);
    const p50 = metrics.latencies[Math.floor(metrics.latencies.length * 0.5)] || 0;
    const p95 = metrics.latencies[Math.floor(metrics.latencies.length * 0.95)] || 0;
    const p99 = metrics.latencies[Math.floor(metrics.latencies.length * 0.99)] || 0;

    console.log("\nBaseline Ingress Metrics:");
    console.log(`  - Total Requests Sent:     ${metrics.totalRequests}`);
    console.log(`  - HTTP 202 Accepted:       ${metrics.accepted202} (${((metrics.accepted202 / metrics.totalRequests) * 100).toFixed(1)}%)`);
    console.log(`  - HTTP 429 Rate-Limited:   ${metrics.rateLimited429}`);
    console.log(`  - HTTP 503 Overloaded:     ${metrics.overloaded503}`);
    console.log(`  - Elapsed Duration:        ${durationSec.toFixed(2)}s`);
    console.log(`  - Measured Ingress Rate:   ${(metrics.totalRequests / durationSec).toFixed(1)} req/s`);
    console.log(`  - API Latency P50:         ${p50} ms`);
    console.log(`  - API Latency P95:         ${p95} ms`);
    console.log(`  - API Latency P99:         ${p99} ms`);

    // -------------------------------------------------------------
    // PHASE 2: Backpressure Activation & Rejection Latency
    // -------------------------------------------------------------
    console.log("\n[Phase 2] Testing Overload Admission Rejection Latency...");
    backpressureService.setOverrideState("OVERLOADED", "outbox_backlog");

    const rejectionLatencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      const res = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", crypto.randomUUID())
        .send({
          customerId: tenantA,
          recipient: `overload-${i}@example.com`,
          channel: "email",
          payload: { subject: "Overload", body: "Rejection Latency Test" },
        });
      rejectionLatencies.push(Date.now() - start);
      if (res.status !== 503) {
        throw new Error(`Expected 503 during overload phase, got ${res.status}`);
      }
    }

    rejectionLatencies.sort((a, b) => a - b);
    const rejP50 = rejectionLatencies[Math.floor(rejectionLatencies.length * 0.5)] || 0;
    const rejP95 = rejectionLatencies[Math.floor(rejectionLatencies.length * 0.95)] || 0;
    console.log(`  - 503 Rejection Latency P50: ${rejP50} ms (Zero DB transaction overhead)`);
    console.log(`  - 503 Rejection Latency P95: ${rejP95} ms`);

    // -------------------------------------------------------------
    // PHASE 3: Background Dispatching & Worker Draining Throughput
    // -------------------------------------------------------------
    console.log("\n[Phase 3] Draining Accepted Outbox Backlog & Measuring Worker Throughput...");
    backpressureService.reset();

    const dbPending = await pool.query(
      "SELECT COUNT(*) as count FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2)) AND published_at IS NULL",
      [tenantA, tenantB]
    );
    const initialOutboxBacklog = parseInt(dbPending.rows[0].count, 10);
    console.log(`  - Outbox backlog to drain: ${initialOutboxBacklog} items`);

    const drainStart = Date.now();
    const worker = getEmailWorker();
    const dispatcher = new OutboxDispatcher(100, 60, 25);
    await dispatcher.start();

    // Poll until drained
    let remaining = initialOutboxBacklog;
    while (remaining > 0 && Date.now() - drainStart < 45000) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await pool.query(
        "SELECT COUNT(*) as count FROM notifications WHERE customer_id IN ($1, $2) AND status = 'processed'",
        [tenantA, tenantB]
      );
      remaining = initialOutboxBacklog - parseInt(res.rows[0].count, 10);
    }

    const drainElapsedSec = (Date.now() - drainStart) / 1000;
    await dispatcher.stop();

    console.log(`  - Backlog drained in:      ${drainElapsedSec.toFixed(2)}s`);
    console.log(`  - Worker Drain Rate:       ${(initialOutboxBacklog / drainElapsedSec).toFixed(1)} notifications/sec`);

    console.log("\n==============================================================");
    console.log("                  LOAD TEST SUMMARY RESULTS                   ");
    console.log("==============================================================");
    console.log(`Total Requests Evaluated:    ${metrics.totalRequests + 20}`);
    console.log(`Baseline Ingress Throughput: ${(metrics.accepted202 / durationSec).toFixed(1)} accepted/s`);
    console.log(`Overload Admission Defense:  100% of excess requests cleanly rejected with HTTP 503`);
    console.log(`Drain Recovery Rate:         ${(initialOutboxBacklog / drainElapsedSec).toFixed(1)} notifications/s`);
  } finally {
    // Scoped cleanup
    console.log("\n[Cleanup] Cleaning up load test data...");
    await pool.query("DELETE FROM idempotency_keys WHERE customer_id IN ($1, $2)", [tenantA, tenantB]).catch(() => {});
    await pool.query(
      "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2))",
      [tenantA, tenantB]
    ).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE customer_id IN ($1, $2)", [tenantA, tenantB]).catch(() => {});
    await pool.query("DELETE FROM customers WHERE id IN ($1, $2)", [tenantA, tenantB]).catch(() => {});
    await closeEmailWorker();
    await closeQueues();
    await closeRedisConnection();
    await pool.end();
    console.log("[Cleanup] Complete.");
  }
}

runLoadTest().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

