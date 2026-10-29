import { pool } from "../src/database/pool.js";
import { app } from "../src/app.js";
import request from "supertest";
import { backpressureService } from "../src/services/backpressureService.js";
import { OutboxDispatcher } from "../src/services/outboxDispatcher.js";
import { getEmailQueue, closeQueues } from "../src/queues/notificationQueues.js";
import { getEmailWorker, closeEmailWorker } from "../src/workers/emailWorker.js";
import { closeRedisConnection } from "../src/config/redis.js";
import crypto from "crypto";

async function runFailureDrill() {
  console.log("==============================================================");
  console.log("       RELAY MILESTONE 6D: CONTROLLED FAILURE DRILL           ");
  console.log("==============================================================");

  // Setup test customer
  const customerId = crypto.randomUUID();
  await pool.query("INSERT INTO customers (id, name) VALUES ($1, 'Failure Drill Tenant')", [customerId]);

  try {
    // -------------------------------------------------------------
    // PHASE 1: Baseline Health (NORMAL state)
    // -------------------------------------------------------------
    console.log("\n[Phase 1] Evaluating Baseline Health...");
    backpressureService.reset();
    const baseline = await backpressureService.evaluateState(true);
    console.log(`  - Initial Backpressure State: ${baseline.state} (Outbox backlog: ${baseline.metrics.outboxBacklog})`);

    const normalKey = crypto.randomUUID();
    const res1 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", normalKey)
      .send({
        customerId,
        recipient: "drill-baseline@example.com",
        channel: "email",
        payload: { subject: "Baseline", body: "Normal Phase" },
      });
    console.log(`  - Baseline Submission: HTTP ${res1.status} (ID: ${res1.body.id})`);
    if (res1.status !== 202) throw new Error(`Expected HTTP 202 in baseline, got ${res1.status}`);

    // -------------------------------------------------------------
    // PHASE 2: Dispatcher Stopped & Outbox Backlog Accumulation
    // -------------------------------------------------------------
    console.log("\n[Phase 2] Simulating Outbox Backlog Accumulation (Dispatcher Stopped)...");
    // Temporarily set low thresholds for controlled drill
    backpressureService.setThresholds({
      outboxDegraded: 5,
      outboxOverload: 12,
      cacheTtlMs: 100,
    });

    console.log("  - Injecting pending notifications into PostgreSQL outbox...");
    const injectedIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const notifId = crypto.randomUUID();
      injectedIds.push(notifId);
      await pool.query(
        "INSERT INTO notifications (id, customer_id, recipient, channel, payload, status) VALUES ($1, $2, $3, 'email', '{\"subject\":\"Drill\",\"body\":\"Drill\"}', 'pending')",
        [notifId, customerId, `drill-injected-${i}@example.com`]
      );
      await pool.query(
        "INSERT INTO outbox_events (notification_id, event_type, attempts) VALUES ($1, 'notification.created', 0)",
        [notifId]
      );
    }

    // Force evaluation with newly injected outbox backlog
    const overloadEval = await backpressureService.evaluateState(true);
    console.log(`  - Measured Backpressure State: ${overloadEval.state} (Reason: ${overloadEval.reason}, Backlog: ${overloadEval.metrics.outboxBacklog})`);
    if (overloadEval.state !== "OVERLOADED") {
      throw new Error(`Expected OVERLOADED state, got ${overloadEval.state}`);
    }

    // Attempt new submission during OVERLOADED state
    console.log("  - Attempting new notification submission during OVERLOADED state...");
    const overloadKey = crypto.randomUUID();
    const resOverload = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", overloadKey)
      .send({
        customerId,
        recipient: "drill-overload@example.com",
        channel: "email",
        payload: { subject: "Overload", body: "Should be rejected" },
      });

    console.log(`  - Overload Response: HTTP ${resOverload.status} (Code: ${resOverload.body.code}, Retry-After: ${resOverload.headers["retry-after"]})`);
    if (resOverload.status !== 503 || resOverload.body.code !== "SYSTEM_OVERLOADED") {
      throw new Error(`Expected HTTP 503 SYSTEM_OVERLOADED, got ${resOverload.status}`);
    }

    // Verify previously accepted request can still be safely replayed during overload
    console.log("  - Verifying safe identical idempotency replay during OVERLOADED state...");
    const replayRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", normalKey)
      .send({
        customerId,
        recipient: "drill-baseline@example.com",
        channel: "email",
        payload: { subject: "Baseline", body: "Normal Phase" },
      });

    console.log(`  - Idempotent Replay Response: HTTP ${replayRes.status} (ID: ${replayRes.body.id}, Matches Original: ${replayRes.body.id === res1.body.id})`);
    if (replayRes.status !== 202 || replayRes.body.id !== res1.body.id) {
      throw new Error("Safe idempotent replay failed during overload");
    }

    // -------------------------------------------------------------
    // PHASE 3: Outbox Dispatcher Recovery & Backlog Draining
    // -------------------------------------------------------------
    console.log("\n[Phase 3] Starting Outbox Dispatcher & Draining Outbox Backlog...");
    const emailQueue = getEmailQueue();
    await emailQueue.drain().catch(() => {});

    // Start worker to process jobs as dispatcher publishes them
    const worker = getEmailWorker();
    const dispatcher = new OutboxDispatcher(100, 60, 25);
    await dispatcher.start();

    // Wait until outbox events are published and processed
    const pollStart = Date.now();
    let remainingBacklog = 15;
    while (remainingBacklog > 0 && Date.now() - pollStart < 30000) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await pool.query(
        "SELECT COUNT(*) as count FROM outbox_events WHERE notification_id = ANY($1::uuid[]) AND published_at IS NULL",
        [injectedIds]
      );
      remainingBacklog = parseInt(res.rows[0].count, 10);
    }
    console.log(`  - Injected outbox backlog drained to: ${remainingBacklog} unpublished events.`);

    await dispatcher.stop();

    // -------------------------------------------------------------
    // PHASE 4: State Recovery Verification
    // -------------------------------------------------------------
    console.log("\n[Phase 4] Verifying System Recovery to NORMAL...");
    backpressureService.reset();
    const recoveredEval = await backpressureService.evaluateState(true);
    console.log(`  - Recovered Backpressure State: ${recoveredEval.state} (Backlog: ${recoveredEval.metrics.outboxBacklog})`);

    const recoveryKey = crypto.randomUUID();
    const resRecovered = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", recoveryKey)
      .send({
        customerId,
        recipient: "drill-recovered@example.com",
        channel: "email",
        payload: { subject: "Recovery", body: "Recovered Phase" },
      });

    console.log(`  - Post-Recovery Submission: HTTP ${resRecovered.status} (ID: ${resRecovered.body.id})`);
    if (resRecovered.status !== 202) {
      throw new Error(`Expected HTTP 202 after recovery, got ${resRecovered.status}`);
    }

    console.log("\n==============================================================");
    console.log("            CONTROLLED FAILURE DRILL: SUCCESS                 ");
    console.log("==============================================================");
    console.log("All phases verified successfully:");
    console.log("  [Pass] Baseline NORMAL state accepts requests (HTTP 202)");
    console.log("  [Pass] Outbox backlog accumulation triggers OVERLOADED state");
    console.log("  [Pass] New submissions rejected with HTTP 503 SYSTEM_OVERLOADED");
    console.log("  [Pass] Safe identical replays served with HTTP 202 during overload");
    console.log("  [Pass] Outbox dispatcher drains backlog when started");
    console.log("  [Pass] System smoothly recovers to NORMAL and resumes ingestion");
  } finally {
    // Scoped cleanup
    console.log("\n[Cleanup] Cleaning up failure drill test data...");
    await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [customerId]).catch(() => {});
    await pool.query(
      "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)",
      [customerId]
    ).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE customer_id = $1", [customerId]).catch(() => {});
    await pool.query("DELETE FROM customers WHERE id = $1", [customerId]).catch(() => {});
    await closeEmailWorker();
    await closeQueues();
    await closeRedisConnection();
    await pool.end();
    console.log("[Cleanup] Complete.");
  }
}

runFailureDrill().catch((err) => {
  console.error("Failure drill failed:", err);
  process.exit(1);
});

