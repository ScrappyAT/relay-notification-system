import crypto from "crypto";
import { pool } from "../src/database/pool.js";
import { getEmailWorker, closeEmailWorker } from "../src/workers/emailWorker.js";
import { getSmsWorker, closeSmsWorker } from "../src/workers/smsWorker.js";
import { getEmailQueue, getSmsQueue, closeQueues } from "../src/queues/notificationQueues.js";
import { simulatedProvider } from "../src/adapters/simulatedProvider.js";
import { closeRedisConnection } from "../src/config/redis.js";

async function waitForNotificationStatus(
  notificationId: string,
  targetStatuses: string[],
  timeoutMs = 7000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await pool.query(
      `SELECT id, recipient, channel, status, retry_count,
              processing_started_at, processing_locked_until, claim_token, updated_at
       FROM notifications WHERE id = $1`,
      [notificationId]
    );
    if (res.rows.length > 0 && targetStatuses.includes(res.rows[0].status)) {
      return res.rows[0];
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  const check = await pool.query(
    `SELECT id, recipient, channel, status, retry_count,
            processing_started_at, processing_locked_until, claim_token, updated_at
     FROM notifications WHERE id = $1`,
    [notificationId]
  );
  return check.rows[0] || null;
}

async function runDrill() {
  console.log("================================================================================");
  console.log("             RELAY NOTIFICATION SYSTEM — MILESTONE 7B FAILURE DRILL             ");
  console.log("             Simulated Provider Failures, Retries & State Recovery              ");
  console.log("================================================================================\n");

  const drillStart = new Date().toISOString();
  console.log(`[Drill Started] ${drillStart}`);

  // Create drill tenant
  const tenantRes = await pool.query(
    "INSERT INTO customers (name) VALUES ($1) RETURNING id, name",
    ["Milestone 7B Drill Tenant"]
  );
  const tenantId = tenantRes.rows[0].id;
  console.log(`[Tenant Created] ID: ${tenantId} | Name: "${tenantRes.rows[0].name}"\n`);

  // Start worker instances
  getEmailWorker();
  getSmsWorker();
  const emailQueue = getEmailQueue();
  const smsQueue = getSmsQueue();

  const drillResults: Array<{
    scenario: string;
    notificationId: string;
    channel: string;
    recipient: string;
    expectedStatus: string;
    actualStatus: string;
    retryCount: number;
    providerCalls: number;
    pass: boolean;
    details: string;
  }> = [];

  try {
    // -------------------------------------------------------------------------
    // SCENARIO 1: Transient 503 Service Outage with Exponential Retry & Recovery
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 1: Transient 503 Provider Outage with Backoff Retry & Recovery");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "transient-503-drill@example.com";
      simulatedProvider.setRecipientFailure(recipient, "TRANSIENT_503", 1);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ subject: "Drill 503", body: "Testing 503" })]
      );

      console.log(`[Scenario 1] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 1] Injected 1x TRANSIENT_503 failure into simulated provider`);
      console.log(`[Scenario 1] Dispatching BullMQ job with backoff (attempts: 3, delay: 100ms)...`);

      await emailQueue.add(
        "send-email",
        { notificationId: notifId, customerId: tenantId, channel: "email", createdAt: new Date() },
        { jobId: `drill-503-${notifId}`, attempts: 3, backoff: { type: "exponential", delay: 100 } }
      );

      const record = await waitForNotificationStatus(notifId, ["provider_accepted"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "provider_accepted" && record?.retry_count >= 1 && calls.length === 2;
      drillResults.push({
        scenario: "1. Transient 503 with Recovery",
        notificationId: notifId,
        channel: "email",
        recipient,
        expectedStatus: "provider_accepted",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Failed on attempt 1 with HTTP 503, lease released; recovered on retry attempt 2 with HTTP 202.`,
      });

      console.log(`[Scenario 1 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 1 Calls] Attempt 1 Status: ${calls[0]?.statusCode} | Attempt 2 Status: ${calls[1]?.statusCode}`);
      console.log(`[Scenario 1 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 2: Provider Rate Limiting (HTTP 429) with Backoff & Recovery
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 2: Downstream Rate Limiting (HTTP 429) with Backoff & Recovery");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "ratelimit-429-drill@example.com";
      simulatedProvider.setRecipientFailure(recipient, "RATE_LIMIT_429", 1);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ subject: "Drill 429", body: "Testing 429" })]
      );

      console.log(`[Scenario 2] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 2] Injected 1x RATE_LIMIT_429 quota exhaustion into simulated provider`);
      console.log(`[Scenario 2] Dispatching BullMQ job with backoff (attempts: 3, delay: 100ms)...`);

      await emailQueue.add(
        "send-email",
        { notificationId: notifId, customerId: tenantId, channel: "email", createdAt: new Date() },
        { jobId: `drill-429-${notifId}`, attempts: 3, backoff: { type: "exponential", delay: 100 } }
      );

      const record = await waitForNotificationStatus(notifId, ["provider_accepted"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "provider_accepted" && record?.retry_count >= 1 && calls.length === 2;
      drillResults.push({
        scenario: "2. Provider 429 Rate Limit Recovery",
        notificationId: notifId,
        channel: "email",
        recipient,
        expectedStatus: "provider_accepted",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Rejected on attempt 1 with HTTP 429, lease released; recovered on retry attempt 2 with HTTP 202.`,
      });

      console.log(`[Scenario 2 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 2 Calls] Attempt 1 Status: ${calls[0]?.statusCode} | Attempt 2 Status: ${calls[1]?.statusCode}`);
      console.log(`[Scenario 2 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 3: Permanent Provider Rejection (HTTP 400 Bad Request)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 3: Permanent Provider Rejection (HTTP 400 Bad Request)");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "invalid-address-400-drill@example.com";
      simulatedProvider.setRecipientFailure(recipient, "PERMANENT_400", 5);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ subject: "Drill 400", body: "Testing 400" })]
      );

      console.log(`[Scenario 3] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 3] Injected PERMANENT_400 non-retryable rejection into simulated provider`);
      console.log(`[Scenario 3] Dispatching BullMQ job with 5 allowed attempts...`);

      await emailQueue.add(
        "send-email",
        { notificationId: notifId, customerId: tenantId, channel: "email", createdAt: new Date() },
        { jobId: `drill-400-${notifId}`, attempts: 5, backoff: { type: "exponential", delay: 100 } }
      );

      const record = await waitForNotificationStatus(notifId, ["failed"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "failed" && calls.length === 1 && calls[0]?.statusCode === 400;
      drillResults.push({
        scenario: "3. Permanent 400 Non-Retryable Rejection",
        notificationId: notifId,
        channel: "email",
        recipient,
        expectedStatus: "failed",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Immediately transitioned to failed without endless retries via UnrecoverableError; exactly 1 call dispatched.`,
      });

      console.log(`[Scenario 3 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 3 Calls] Attempt 1 Status: ${calls[0]?.statusCode}`);
      console.log(`[Scenario 3 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 4: Network Socket Read Timeout Leading to outcome_unknown
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 4: Network Timeout Leading to outcome_unknown Status");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "+18885551234-sim-timeout";

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'sms', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ body: "Drill timeout alert" })]
      );

      console.log(`[Scenario 4] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 4] Injected TIMEOUT socket read failure into SMS provider`);
      console.log(`[Scenario 4] Dispatching BullMQ SMS job...`);

      await smsQueue.add(
        "send-sms",
        { notificationId: notifId, customerId: tenantId, channel: "sms", createdAt: new Date() },
        { jobId: `drill-timeout-${notifId}`, attempts: 4, backoff: { type: "exponential", delay: 100 } }
      );

      const record = await waitForNotificationStatus(notifId, ["outcome_unknown"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "outcome_unknown" && calls.length === 1 && calls[0]?.statusCode === 504;
      drillResults.push({
        scenario: "4. Network Timeout -> outcome_unknown",
        notificationId: notifId,
        channel: "sms",
        recipient,
        expectedStatus: "outcome_unknown",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Socket read timed out after dispatch; marked outcome_unknown to avert blind duplicate SMS dispatch.`,
      });

      console.log(`[Scenario 4 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 4 Calls] Attempt 1 Status: ${calls[0]?.statusCode}`);
      console.log(`[Scenario 4 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 5: Retry Exhaustion on Prolonged Outage Moving to failed
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 5: Max Retry Exhaustion Moving to Terminal failed Status");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "prolonged-outage-drill@example.com";
      simulatedProvider.setRecipientFailure(recipient, "TRANSIENT_503", 10);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ subject: "Drill Outage", body: "Testing exhaustion" })]
      );

      console.log(`[Scenario 5] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 5] Injected continuous 503 outage across all retry attempts`);
      console.log(`[Scenario 5] Dispatching BullMQ job with limit of 2 attempts...`);

      await emailQueue.add(
        "send-email",
        { notificationId: notifId, customerId: tenantId, channel: "email", createdAt: new Date() },
        { jobId: `drill-exhaust-${notifId}`, attempts: 2, backoff: { type: "exponential", delay: 100 } }
      );

      const record = await waitForNotificationStatus(notifId, ["failed"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "failed" && record?.retry_count >= 1 && calls.length === 2;
      drillResults.push({
        scenario: "5. Retry Exhaustion -> failed",
        notificationId: notifId,
        channel: "email",
        recipient,
        expectedStatus: "failed",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Exhausted configured attempt limit (2/2) on persistent 503; transitioned to terminal failed status.`,
      });

      console.log(`[Scenario 5 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 5 Calls] Attempt 1: ${calls[0]?.statusCode} | Attempt 2: ${calls[1]?.statusCode}`);
      console.log(`[Scenario 5 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

    // -------------------------------------------------------------------------
    // SCENARIO 6: Clean Provider Delivery After Recovery
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SCENARIO 6: Clean Provider Acceptance After Infrastructure Recovery");
    console.log("--------------------------------------------------------------------------------");
    {
      const notifId = crypto.randomUUID();
      const recipient = "recovered-healthy-drill@example.com";
      simulatedProvider.clearOverrides();

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifId, tenantId, recipient, JSON.stringify({ subject: "Drill Clean", body: "Healthy delivery" })]
      );

      console.log(`[Scenario 6] Notification created: ${notifId} (status: pending)`);
      console.log(`[Scenario 6] Cleared all provider overrides; normal operation restored`);
      console.log(`[Scenario 6] Dispatching BullMQ job...`);

      await emailQueue.add(
        "send-email",
        { notificationId: notifId, customerId: tenantId, channel: "email", createdAt: new Date() },
        { jobId: `drill-clean-${notifId}` }
      );

      const record = await waitForNotificationStatus(notifId, ["provider_accepted"]);
      const calls = simulatedProvider.getCallsForNotification(notifId);

      const passed = record?.status === "provider_accepted" && calls.length === 1 && calls[0]?.statusCode === 202;
      drillResults.push({
        scenario: "6. Clean Delivery After Recovery",
        notificationId: notifId,
        channel: "email",
        recipient,
        expectedStatus: "provider_accepted",
        actualStatus: record?.status,
        retryCount: record?.retry_count,
        providerCalls: calls.length,
        pass: passed,
        details: `Delivered cleanly with HTTP 202; providerMessageId generated and logged.`,
      });

      console.log(`[Scenario 6 Result] Status: ${record?.status} | Retry Count: ${record?.retry_count} | Calls: ${calls.length}`);
      console.log(`[Scenario 6 Calls] Provider Message ID: ${calls[0]?.providerMessageId}`);
      console.log(`[Scenario 6 Outcome] ${passed ? "PASSED" : "FAILED"}\n`);
    }

  } finally {
    // Teardown
    console.log("--------------------------------------------------------------------------------");
    console.log("TEARDOWN & CLEANUP");
    console.log("--------------------------------------------------------------------------------");
    await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)", [tenantId]);
    await pool.query("DELETE FROM notifications WHERE customer_id = $1", [tenantId]);
    await pool.query("DELETE FROM customers WHERE id = $1", [tenantId]);
    console.log(`[Cleanup] Deleted test tenant ${tenantId} and associated records.`);

    await closeEmailWorker();
    await closeSmsWorker();
    await closeQueues();
    await closeRedisConnection();
    await pool.end();
    console.log("[Cleanup] Closed worker instances, queues, Redis and PostgreSQL connections.\n");
  }

  // Summary Table
  console.log("================================================================================");
  console.log("                     MILESTONE 7B DRILL EXECUTION SUMMARY                      ");
  console.log("================================================================================");
  console.table(
    drillResults.map((r) => ({
      Scenario: r.scenario,
      Channel: r.channel,
      Expected: r.expectedStatus,
      Actual: r.actualStatus,
      Retries: r.retryCount,
      Calls: r.providerCalls,
      Pass: r.pass ? "YES" : "NO",
    }))
  );

  const allPassed = drillResults.every((r) => r.pass);
  console.log(`\nOverall Drill Verdict: ${allPassed ? "ALL 6 SCENARIOS PASSED" : "DRILL ENCOUNTERED FAILURES"}`);
  console.log(`Completed At: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  if (!allPassed) {
    process.exit(1);
  }
}

runDrill().catch((err) => {
  console.error("Fatal drill execution error:", err);
  process.exit(1);
});
