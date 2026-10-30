import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import { getRedisClientSync } from "../src/config/redis.js";
import { getEmailWorker, closeEmailWorker } from "../src/workers/emailWorker.js";
import { getSmsWorker, closeSmsWorker } from "../src/workers/smsWorker.js";
import { getEmailQueue, getSmsQueue, closeQueues } from "../src/queues/notificationQueues.js";
import { simulatedProvider, ProviderError } from "../src/adapters/simulatedProvider.js";
import { tenantFairnessService } from "../src/services/tenantFairnessService.js";

describe("Milestone 7B: Simulated Provider Failures & Recovery", () => {
  let customerAId: string;
  let customerBId: string;

  async function waitForNotificationStatus(
    notificationId: string,
    targetStatus: string | string[],
    timeoutMs = 6000
  ): Promise<any> {
    const start = Date.now();
    const targets = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
    while (Date.now() - start < timeoutMs) {
      const res = await pool.query("SELECT * FROM notifications WHERE id = $1", [notificationId]);
      if (res.rows.length > 0 && targets.includes(res.rows[0].status)) {
        return res.rows[0];
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    const check = await pool.query("SELECT * FROM notifications WHERE id = $1", [notificationId]);
    throw new Error(
      `Timeout waiting for notification ${notificationId} to reach status [${targets.join(", ")}]; current status: ${check.rows[0]?.status}, retry_count: ${check.rows[0]?.retry_count}`
    );
  }

  beforeAll(async () => {
    // Create test customers
    const c1 = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Tenant Provider-A"]
    );
    customerAId = c1.rows[0].id;

    const c2 = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Tenant Provider-B"]
    );
    customerBId = c2.rows[0].id;

    // Start workers
    getEmailWorker();
    getSmsWorker();
  });

  afterAll(async () => {
    await closeEmailWorker();
    await closeSmsWorker();
    await closeQueues();

    if (customerAId || customerBId) {
      const customerIds = [customerAId, customerBId].filter(Boolean);
      await pool.query("DELETE FROM idempotency_keys WHERE customer_id = ANY($1)", [customerIds]);
      await pool.query("DELETE FROM recipient_preferences WHERE customer_id = ANY($1)", [customerIds]);
      await pool.query(
        "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = ANY($1))",
        [customerIds]
      );
      await pool.query("DELETE FROM notifications WHERE customer_id = ANY($1)", [customerIds]);
      await pool.query("DELETE FROM customers WHERE id = ANY($1)", [customerIds]);
    }
  });

  beforeEach(() => {
    simulatedProvider.reset();
  });

  // 1. Adapter Unit Verification
  describe("Simulated Provider Adapter Capabilities", () => {
    it("delivers realistic response metadata on successful dispatch", async () => {
      const res = await simulatedProvider.send({
        notificationId: crypto.randomUUID(),
        customerId: customerAId,
        channel: "email",
        recipient: "alice@example.com",
        payload: { subject: "Hello", body: "World" },
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(202);
      expect(res.provider).toBe("SendGrid-Simulator");
      expect(res.providerMessageId).toMatch(/^sim_email_/);
      expect(res.deliveredAt).toBeInstanceOf(Date);
    });

    it("throws retryable ProviderError on HTTP 503 service outage", async () => {
      await expect(
        simulatedProvider.send({
          notificationId: crypto.randomUUID(),
          customerId: customerAId,
          channel: "sms",
          recipient: "+1234567890-sim-503",
          payload: { body: "SMS text" },
        })
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.statusCode).toBe(503);
        expect(err.retryable).toBe(true);
        expect(err.isTimeout).toBe(false);
        return true;
      });
    });

    it("throws retryable ProviderError on HTTP 429 rate limit exceeded", async () => {
      await expect(
        simulatedProvider.send({
          notificationId: crypto.randomUUID(),
          customerId: customerAId,
          channel: "email",
          recipient: "user-sim-429@example.com",
          payload: { subject: "Test" },
        })
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.statusCode).toBe(429);
        expect(err.retryable).toBe(true);
        return true;
      });
    });

    it("throws indeterminate ProviderError on network timeout", async () => {
      await expect(
        simulatedProvider.send({
          notificationId: crypto.randomUUID(),
          customerId: customerAId,
          channel: "sms",
          recipient: "+1234567890-sim-timeout",
          payload: { body: "Timeout test" },
        })
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.statusCode).toBe(504);
        expect(err.retryable).toBe(false);
        expect(err.isTimeout).toBe(true);
        return true;
      });
    });

    it("throws non-retryable ProviderError on permanent HTTP 400 rejection", async () => {
      await expect(
        simulatedProvider.send({
          notificationId: crypto.randomUUID(),
          customerId: customerAId,
          channel: "email",
          recipient: "invalid-sim-400@example.com",
          payload: { subject: "Test" },
        })
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.statusCode).toBe(400);
        expect(err.retryable).toBe(false);
        expect(err.isTimeout).toBe(false);
        return true;
      });
    });
  });

  // 2. Worker Execution & Lifecycle State Transitions
  describe("Worker Lifecycle & Provider Failure Modes", () => {
    it("successfully delivers email notification and marks status as provider_accepted", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "success-email@example.com";

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Email body" })]
      );

      const emailQ = getEmailQueue();
      await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        { jobId: `test-success-email-${notificationId}` }
      );

      const updated = await waitForNotificationStatus(notificationId, "provider_accepted");
      expect(updated.status).toBe("provider_accepted");
      expect(updated.processing_locked_until).toBeNull();
      expect(updated.claim_token).toBeNull();

      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(1);
      expect(calls[0].success).toBe(true);
      expect(calls[0].statusCode).toBe(202);
    });

    it("successfully delivers SMS notification and marks status as provider_accepted", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "+15551234567";

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'sms', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "SMS text" })]
      );

      const smsQ = getSmsQueue();
      await smsQ.add(
        "send-sms",
        { notificationId, customerId: customerAId, channel: "sms", createdAt: new Date() },
        { jobId: `test-success-sms-${notificationId}` }
      );

      const updated = await waitForNotificationStatus(notificationId, "provider_accepted");
      expect(updated.status).toBe("provider_accepted");
      expect(updated.processing_locked_until).toBeNull();
      expect(updated.claim_token).toBeNull();

      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(1);
      expect(calls[0].success).toBe(true);
    });

    it("retries after temporary provider failure (HTTP 503) and recovers to provider_accepted", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "retry-503@example.com";

      // Fail once with 503, succeed on next attempt
      simulatedProvider.setRecipientFailure(recipient, "TRANSIENT_503", 1);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Retry body" })]
      );

      const emailQ = getEmailQueue();
      await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        {
          jobId: `test-retry-503-${notificationId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 80 },
        }
      );

      const updated = await waitForNotificationStatus(notificationId, "provider_accepted");
      expect(updated.status).toBe("provider_accepted");
      expect(updated.retry_count).toBeGreaterThanOrEqual(1);

      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(2);
      expect(calls[0].statusCode).toBe(503);
      expect(calls[1].statusCode).toBe(202);
    });

    it("retries after provider rate limiting (HTTP 429) and recovers to provider_accepted", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "retry-429@example.com";

      // Fail once with 429, succeed on next attempt
      simulatedProvider.setRecipientFailure(recipient, "RATE_LIMIT_429", 1);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Rate limit body" })]
      );

      const emailQ = getEmailQueue();
      await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        {
          jobId: `test-retry-429-${notificationId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 80 },
        }
      );

      const updated = await waitForNotificationStatus(notificationId, "provider_accepted");
      expect(updated.status).toBe("provider_accepted");
      expect(updated.retry_count).toBeGreaterThanOrEqual(1);

      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(2);
      expect(calls[0].statusCode).toBe(429);
      expect(calls[1].statusCode).toBe(202);
    });

    it("marks status as failed immediately on permanent provider rejection (HTTP 400) without endless retries", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "permanent-reject-sim-400@example.com";

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Bad email" })]
      );

      const emailQ = getEmailQueue();
      await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        {
          jobId: `test-perm-fail-${notificationId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 80 },
        }
      );

      const updated = await waitForNotificationStatus(notificationId, "failed");
      expect(updated.status).toBe("failed");
      expect(updated.processing_locked_until).toBeNull();
      expect(updated.claim_token).toBeNull();

      // Only 1 dispatch call attempted because UnrecoverableError prevented futile retries
      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(1);
      expect(calls[0].statusCode).toBe(400);
    });

    it("transitions status to outcome_unknown on network timeout to avoid unsafe duplicate dispatch", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "+19990001111-sim-timeout";

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'sms', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Timeout alert" })]
      );

      const smsQ = getSmsQueue();
      await smsQ.add(
        "send-sms",
        { notificationId, customerId: customerAId, channel: "sms", createdAt: new Date() },
        {
          jobId: `test-timeout-${notificationId}`,
          attempts: 4,
          backoff: { type: "exponential", delay: 80 },
        }
      );

      const updated = await waitForNotificationStatus(notificationId, "outcome_unknown");
      expect(updated.status).toBe("outcome_unknown");
      expect(updated.processing_locked_until).toBeNull();
      expect(updated.claim_token).toBeNull();

      // Indeterminate timeout halted without blind retry
      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(1);
      expect(calls[0].statusCode).toBe(504);
    });

    it("transitions status to failed when transient retry attempts are exhausted", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "exhaust-retries@example.com";

      // Configure persistent 503 failure across all attempts
      simulatedProvider.setRecipientFailure(recipient, "TRANSIENT_503", 10);

      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Exhaust test" })]
      );

      const emailQ = getEmailQueue();
      await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        {
          jobId: `test-exhaust-${notificationId}`,
          attempts: 2, // 2 total attempts
          backoff: { type: "exponential", delay: 80 },
        }
      );

      const updated = await waitForNotificationStatus(notificationId, "failed");
      expect(updated.status).toBe("failed");
      expect(updated.retry_count).toBeGreaterThanOrEqual(1);

      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(2);
      expect(calls[0].statusCode).toBe(503);
      expect(calls[1].statusCode).toBe(503);
    });

    it("safely skips duplicate jobs for already completed notifications", async () => {
      const notificationId = crypto.randomUUID();
      const recipient = "already-done@example.com";

      // Seed notification directly in provider_accepted status
      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'provider_accepted')`,
        [notificationId, customerAId, recipient, JSON.stringify({ body: "Already done" })]
      );

      const emailQ = getEmailQueue();
      const job = await emailQ.add(
        "send-email",
        { notificationId, customerId: customerAId, channel: "email", createdAt: new Date() },
        { jobId: `test-duplicate-${notificationId}` }
      );

      // Wait a short duration for worker to process the job
      await new Promise((r) => setTimeout(r, 400));

      const updated = await pool.query("SELECT * FROM notifications WHERE id = $1", [notificationId]);
      expect(updated.rows[0].status).toBe("provider_accepted");

      // Verify that provider received ZERO delivery calls
      const calls = simulatedProvider.getCallsForNotification(notificationId);
      expect(calls.length).toBe(0);
    });
  });

  // 3. System Integration, Preferences & Fairness Coexistence
  describe("Preferences & Tenant Fairness Integration", () => {
    it("preserves preference suppression: opt-out notifications never invoke provider adapter", async () => {
      const recipient = "optout-user@example.com";

      // Set explicit opt-out preference
      await request(app)
        .put("/v1/recipients/preferences")
        .send({ customerId: customerAId, recipient, channel: "email", enabled: false })
        .expect(200);

      // Ingest notification via HTTP endpoint
      const key = crypto.randomUUID();
      const res = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", key)
        .send({
          customerId: customerAId,
          recipient,
          channel: "email",
          payload: { subject: "Promo", body: "50% off" },
        })
        .expect(200);

      expect(res.body.status).toBe("suppressed");
      const notifId = res.body.id;

      // Verify outbox has zero records for this notification
      const outbox = await pool.query(
        "SELECT * FROM outbox_events WHERE notification_id = $1",
        [notifId]
      );
      expect(outbox.rows.length).toBe(0);

      // Verify simulated provider never received any calls
      const calls = simulatedProvider.getCallsForRecipient(recipient);
      expect(calls.length).toBe(0);
    });

    it("maintains fair execution for Tenant B when Tenant A suffers downstream provider failures", async () => {
      const notifA = crypto.randomUUID();
      const notifB = crypto.randomUUID();

      // Configure persistent 503 failure for Tenant A's recipient
      const recipA = "tenant-a-failing@example.com";
      simulatedProvider.setRecipientFailure(recipA, "TRANSIENT_503", 5);

      const recipB = "tenant-b-healthy@example.com";

      // Insert Tenant A failing notification
      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifA, customerAId, recipA, JSON.stringify({ body: "Tenant A" })]
      );

      // Insert Tenant B healthy notification
      await pool.query(
        `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status)
         VALUES ($1, $2, $3, 'email', $4, 'pending')`,
        [notifB, customerBId, recipB, JSON.stringify({ body: "Tenant B" })]
      );

      const emailQ = getEmailQueue();

      // Enqueue Tenant A job with backoff
      await emailQ.add(
        "send-email",
        { notificationId: notifA, customerId: customerAId, channel: "email", createdAt: new Date() },
        {
          jobId: `test-fair-a-${notifA}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
        }
      );

      // Enqueue Tenant B job
      await emailQ.add(
        "send-email",
        { notificationId: notifB, customerId: customerBId, channel: "email", createdAt: new Date() },
        { jobId: `test-fair-b-${notifB}` }
      );

      // Tenant B must complete successfully without being blocked by Tenant A's failing job
      const completedB = await waitForNotificationStatus(notifB, "provider_accepted", 5000);
      expect(completedB.status).toBe("provider_accepted");

      const callsB = simulatedProvider.getCallsForNotification(notifB);
      expect(callsB.length).toBe(1);
      expect(callsB[0].success).toBe(true);

      // Tenant A is in retry backoff or exhausted
      const checkA = await pool.query("SELECT * FROM notifications WHERE id = $1", [notifA]);
      expect(["processing", "failed"]).toContain(checkA.rows[0].status);
    });
  });
});
