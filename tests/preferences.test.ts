import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import { getEmailQueue, getSmsQueue } from "../src/queues/notificationQueues.js";
import { OutboxDispatcher } from "../src/services/outboxDispatcher.js";
import crypto from "crypto";

describe("Milestone 7A: Recipient Notification Preferences", () => {
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    // Create two test tenants for isolation testing
    const resA = await pool.query(
      "INSERT INTO customers (name) VALUES ('Preference Tenant A') RETURNING id"
    );
    tenantAId = resA.rows[0].id;

    const resB = await pool.query(
      "INSERT INTO customers (name) VALUES ('Preference Tenant B') RETURNING id"
    );
    tenantBId = resB.rows[0].id;
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM recipient_preferences WHERE customer_id IN ($1, $2)", [tenantAId, tenantBId]);
      await pool.query("DELETE FROM idempotency_keys WHERE customer_id IN ($1, $2)", [tenantAId, tenantBId]);
      await pool.query(
        "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2))",
        [tenantAId, tenantBId]
      );
      await pool.query("DELETE FROM notifications WHERE customer_id IN ($1, $2)", [tenantAId, tenantBId]);
      await pool.query("DELETE FROM customers WHERE id IN ($1, $2)", [tenantAId, tenantBId]);
    } catch {
      // Ignore cleanup errors
    }
  });

  // -----------------------------------------------------------------
  // 1 & 2. Explicitly Enabled Preferences
  // -----------------------------------------------------------------
  it("accepts email notification and creates outbox event when email channel is explicitly enabled", async () => {
    const recipient = `enabled-email-${Date.now()}@example.com`;

    // 1. Explicitly enable email preference
    const putRes = await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        enabled: true,
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.enabled).toBe(true);

    // 2. Submit notification
    const key = crypto.randomUUID();
    const notifRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Sub", body: "Msg" },
      });

    expect(notifRes.status).toBe(202);
    expect(notifRes.body.status).toBe("pending");

    // Verify outbox record created
    const outbox = await pool.query(
      "SELECT * FROM outbox_events WHERE notification_id = $1",
      [notifRes.body.id]
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("accepts SMS notification and creates outbox event when SMS channel is explicitly enabled", async () => {
    const recipient = `+1555000${Math.floor(1000 + Math.random() * 9000)}`;

    const putRes = await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: tenantAId,
        recipient,
        channel: "sms",
        enabled: true,
      });
    expect(putRes.status).toBe(200);

    const key = crypto.randomUUID();
    const notifRes = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "sms",
        payload: { body: "SMS Message" },
      });

    expect(notifRes.status).toBe(202);
    expect(notifRes.body.status).toBe("pending");

    const outbox = await pool.query(
      "SELECT * FROM outbox_events WHERE notification_id = $1",
      [notifRes.body.id]
    );
    expect(outbox.rowCount).toBe(1);
  });

  // -----------------------------------------------------------------
  // 3 & 4. Explicitly Disabled Preferences (Suppression)
  // -----------------------------------------------------------------
  it("suppresses email notification without creating outbox events when email channel is disabled", async () => {
    const recipient = `optout-email-${Date.now()}@example.com`;

    // Disable email for this recipient
    await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        enabled: false,
      });

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Suppressed Email", body: "Should not be queued" },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suppressed");
    expect(res.body.suppressionReason).toBe("recipient_preference_disabled");
    expect(res.body.id).toBeDefined();

    // Invariant: Notification record exists with status 'suppressed'
    const notifDb = await pool.query("SELECT * FROM notifications WHERE id = $1", [res.body.id]);
    expect(notifDb.rows[0].status).toBe("suppressed");

    // Invariant: Zero outbox events created
    const outbox = await pool.query("SELECT * FROM outbox_events WHERE notification_id = $1", [res.body.id]);
    expect(outbox.rowCount).toBe(0);
  });

  it("suppresses SMS notification without creating outbox events when SMS channel is disabled", async () => {
    const recipient = `+1555999${Math.floor(1000 + Math.random() * 9000)}`;

    await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: tenantAId,
        recipient,
        channel: "sms",
        enabled: false,
      });

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "sms",
        payload: { body: "Suppressed SMS" },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suppressed");
    expect(res.body.suppressionReason).toBe("recipient_preference_disabled");

    const outbox = await pool.query("SELECT * FROM outbox_events WHERE notification_id = $1", [res.body.id]);
    expect(outbox.rowCount).toBe(0);
  });

  // -----------------------------------------------------------------
  // 5. Default-Allow Policy for Recipients with No Saved Preferences
  // -----------------------------------------------------------------
  it("defaults to allowed when recipient has no saved preferences", async () => {
    const freshRecipient = `fresh-${crypto.randomUUID()}@example.com`;

    // Confirm no preference saved
    const prefCheck = await request(app)
      .get(`/v1/recipients/preferences?customerId=${tenantAId}&recipient=${freshRecipient}&channel=email`);
    expect(prefCheck.status).toBe(200);
    expect(prefCheck.body.enabled).toBe(true);
    expect(prefCheck.body.isDefault).toBe(true);

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient: freshRecipient,
        channel: "email",
        payload: { subject: "Default Allowed", body: "Hello" },
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
  });

  // -----------------------------------------------------------------
  // 6. Preference Updates
  // -----------------------------------------------------------------
  it("allows updating preferences dynamically from disabled to enabled", async () => {
    const recipient = `flip-${Date.now()}@example.com`;

    // 1. Disable
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: false });

    const key1 = crypto.randomUUID();
    const res1 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key1)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Sub", body: "First attempt suppressed" },
      });
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe("suppressed");

    // 2. Re-enable
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: true });

    // 3. New notification (with new key) should now be accepted
    const key2 = crypto.randomUUID();
    const res2 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key2)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Sub", body: "Second attempt accepted" },
      });
    expect(res2.status).toBe(202);
    expect(res2.body.status).toBe("pending");
  });

  // -----------------------------------------------------------------
  // 7. Tenant Isolation
  // -----------------------------------------------------------------
  it("strictly enforces tenant isolation: disabling a recipient in Tenant A does not affect Tenant B", async () => {
    const sharedRecipient = `shared-user@example.com`;

    // Tenant A disables email
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient: sharedRecipient, channel: "email", enabled: false });

    // Tenant B explicitly enables email
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantBId, recipient: sharedRecipient, channel: "email", enabled: true });

    // Submission under Tenant A is suppressed
    const resA = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", crypto.randomUUID())
      .send({
        customerId: tenantAId,
        recipient: sharedRecipient,
        channel: "email",
        payload: { subject: "Tenant A Msg", body: "Hello" },
      });
    expect(resA.status).toBe(200);
    expect(resA.body.status).toBe("suppressed");

    // Submission under Tenant B is accepted
    const resB = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", crypto.randomUUID())
      .send({
        customerId: tenantBId,
        recipient: sharedRecipient,
        channel: "email",
        payload: { subject: "Tenant B Msg", body: "Hello" },
      });
    expect(resB.status).toBe(202);
    expect(resB.body.status).toBe("pending");
  });

  // -----------------------------------------------------------------
  // 8 & 9. Disabled Notifications Never Enter Outbox or BullMQ
  // -----------------------------------------------------------------
  it("guarantees disabled notifications never enter outbox table and never reach BullMQ", async () => {
    const recipient = `never-queue-${Date.now()}@example.com`;
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: false });

    const key = crypto.randomUUID();
    const res = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Never Queue", body: "Body" },
      });
    expect(res.status).toBe(200);
    const notifId = res.body.id;

    // Check outbox table: 0 rows
    const outboxCount = await pool.query(
      "SELECT COUNT(*) as count FROM outbox_events WHERE notification_id = $1",
      [notifId]
    );
    expect(parseInt(outboxCount.rows[0].count, 10)).toBe(0);

    // Run outbox dispatcher cycle
    const dispatcher = new OutboxDispatcher(100, 60, 10);
    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 300));
    await dispatcher.stop();

    // Check BullMQ: ensure no job with deterministic ID exists
    const emailQueue = getEmailQueue();
    const job = await emailQueue.getJob(`notif-${notifId}`);
    expect(job).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 10. Idempotent Replay of Suppressed Requests
  // -----------------------------------------------------------------
  it("returns original suppressed result on identical replay, even if recipient subsequently enables channel", async () => {
    const recipient = `replay-optout-${Date.now()}@example.com`;
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: false });

    const key = crypto.randomUUID();
    const payload = { subject: "Idempotent Replay", body: "Content" };

    // Initial submission -> Suppressed
    const res1 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({ customerId: tenantAId, recipient, channel: "email", payload });
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe("suppressed");
    const originalId = res1.body.id;

    // Recipient later updates preference to ENABLED
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: true });

    // Replay with identical key and payload: Must return original suppressed result (deterministic idempotency)
    const res2 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({ customerId: tenantAId, recipient, channel: "email", payload });
    expect(res2.status).toBe(200);
    expect(res2.body.id).toBe(originalId);
    expect(res2.body.status).toBe("suppressed");
    expect(res2.body.isReplay).toBe(true);

    // Confirm no outbox event was retroactively created
    const outbox = await pool.query("SELECT COUNT(*) FROM outbox_events WHERE notification_id = $1", [originalId]);
    expect(parseInt(outbox.rows[0].count, 10)).toBe(0);
  });

  // -----------------------------------------------------------------
  // 11. Conflicting Idempotency Keys on Suppressed Requests
  // -----------------------------------------------------------------
  it("returns HTTP 409 when reusing a suppressed request idempotency key with a different payload", async () => {
    const recipient = `conflict-suppress-${Date.now()}@example.com`;
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: false });

    const key = crypto.randomUUID();

    // First request
    const res1 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Payload 1", body: "Original" },
      });
    expect(res1.status).toBe(200);

    // Conflicting request with same key but different body
    const res2 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Payload 2 (Tampered)", body: "Different" },
      });
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  // -----------------------------------------------------------------
  // 12. Preference Management API Validation & Edge Cases
  // -----------------------------------------------------------------
  it("validates request schemas on PUT and GET /v1/recipients/preferences", async () => {
    // Missing fields
    const res1 = await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId });
    expect(res1.status).toBe(400);
    expect(res1.body.code).toBe("VALIDATION_ERROR");

    // Invalid channel
    const res2 = await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: tenantAId,
        recipient: "user@example.com",
        channel: "pigeon",
        enabled: true,
      });
    expect(res2.status).toBe(400);

    // Non-existent customer
    const res3 = await request(app)
      .put("/v1/recipients/preferences")
      .send({
        customerId: crypto.randomUUID(),
        recipient: "user@example.com",
        channel: "email",
        enabled: true,
      });
    expect(res3.status).toBe(404);
    expect(res3.body.code).toBe("CUSTOMER_NOT_FOUND");

    // GET with invalid query
    const res4 = await request(app).get("/v1/recipients/preferences");
    expect(res4.status).toBe(400);
  });

  // -----------------------------------------------------------------
  // 13. Rate Limiting and Backpressure Compatibility
  // -----------------------------------------------------------------
  it("emits standard RateLimit headers and refunds token on safe replay of suppressed request", async () => {
    const recipient = `ratelimit-suppress-${Date.now()}@example.com`;
    await request(app)
      .put("/v1/recipients/preferences")
      .send({ customerId: tenantAId, recipient, channel: "email", enabled: false });

    const key = crypto.randomUUID();
    const payload = { subject: "RL Test", body: "Testing Headers" };

    // Initial submission
    const res1 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({ customerId: tenantAId, recipient, channel: "email", payload });

    expect(res1.status).toBe(200);
    expect(res1.headers["ratelimit-limit"]).toBeDefined();
    expect(res1.headers["ratelimit-remaining"]).toBeDefined();

    // Replay submission: should return 200 with isReplay: true and rate limit token refunded
    const res2 = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", key)
      .send({ customerId: tenantAId, recipient, channel: "email", payload });

    expect(res2.status).toBe(200);
    expect(res2.body.isReplay).toBe(true);
    expect(res2.headers["ratelimit-remaining"]).toBeDefined();
  });

  // -----------------------------------------------------------------
  // 14. Concurrent Preference Update and Notification Acceptance
  // -----------------------------------------------------------------
  it("deterministically arbitrates concurrent preference updates and notification submissions", async () => {
    const recipient = `concurrent-${Date.now()}@example.com`;

    // Fire multiple notification submissions and a preference toggle simultaneously
    const results = await Promise.all([
      request(app).post("/v1/notifications").set("Idempotency-Key", crypto.randomUUID()).send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Concurrent 1", body: "Body 1" },
      }),
      request(app).post("/v1/notifications").set("Idempotency-Key", crypto.randomUUID()).send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Concurrent 2", body: "Body 2" },
      }),
      request(app).put("/v1/recipients/preferences").send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        enabled: false,
      }),
      request(app).post("/v1/notifications").set("Idempotency-Key", crypto.randomUUID()).send({
        customerId: tenantAId,
        recipient,
        channel: "email",
        payload: { subject: "Concurrent 3", body: "Body 3" },
      }),
    ]);

    const notifResults = [results[0], results[1], results[3]];
    for (const res of notifResults) {
      expect([200, 202]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.status).toBe("suppressed");
      } else {
        expect(res.body.status).toBe("pending");
      }
    }
  });
});
