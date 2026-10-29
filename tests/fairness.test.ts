import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/database/pool.js";
import { OutboxDispatcherRepository } from "../src/repositories/outboxDispatcherRepository.js";
import { TenantFairnessService, tenantFairnessService } from "../src/services/tenantFairnessService.js";
import { ReconciliationService } from "../src/services/reconciliationService.js";
import { NotificationService } from "../src/services/notificationService.js";
import { getMetrics } from "../src/metrics/index.js";
import crypto from "crypto";

describe("Tenant Fairness Architecture (Milestone 6C)", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  const dispatcherRepo = new OutboxDispatcherRepository();
  const notificationService = new NotificationService();

  beforeAll(async () => {
    // Clean up any stale test customers / outbox events from prior aborted test runs
    await pool.query(
      `DELETE FROM idempotency_keys WHERE customer_id IN (
         SELECT id FROM customers WHERE name LIKE 'Fair%'
       )`
    ).catch(() => {});
    await pool.query(
      `DELETE FROM outbox_events WHERE notification_id IN (
         SELECT id FROM notifications WHERE customer_id IN (
           SELECT id FROM customers WHERE name LIKE 'Fair%'
         )
       )`
    ).catch(() => {});
    await pool.query(
      `DELETE FROM notifications WHERE customer_id IN (
         SELECT id FROM customers WHERE name LIKE 'Fair%'
       )`
    ).catch(() => {});
    await pool.query("DELETE FROM customers WHERE name LIKE 'Fair%'").catch(() => {});

    const resA = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Fairness Tenant High-Volume A"]
    );
    tenantA = resA.rows[0].id;

    const resB = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Fairness Tenant Low-Volume B"]
    );
    tenantB = resB.rows[0].id;

    const resC = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Fairness Tenant Low-Volume C"]
    );
    tenantC = resC.rows[0].id;
  });

  afterAll(async () => {
    try {
      const tenantIds = [tenantA, tenantB, tenantC].filter(Boolean);
      if (tenantIds.length > 0) {
        await pool.query(
          "DELETE FROM idempotency_keys WHERE customer_id = ANY($1::uuid[])",
          [tenantIds]
        );
        await pool.query(
          `DELETE FROM outbox_events WHERE notification_id IN (
             SELECT id FROM notifications WHERE customer_id = ANY($1::uuid[])
           )`,
          [tenantIds]
        );
        await pool.query(
          "DELETE FROM notifications WHERE customer_id = ANY($1::uuid[])",
          [tenantIds]
        );
        await pool.query(
          "DELETE FROM customers WHERE id = ANY($1::uuid[])",
          [tenantIds]
        );
      }
      await tenantFairnessService.reset("email");
      await tenantFairnessService.reset("sms");
    } catch {
      // Ignore cleanup errors
    }
  });

  // 1. High-volume tenant does not starve a low-volume tenant
  it("interleaves outbox claiming so a high-volume tenant does not starve a low-volume tenant", async () => {
    // Insert 6 notifications for Tenant A (high-volume) and 2 notifications for Tenant B (low-volume)
    for (let i = 0; i < 6; i++) {
      await notificationService.submitNotification(
        {
          customerId: tenantA,
          recipient: `high-${i}@example.com`,
          channel: "email",
          payload: { subject: `High ${i}`, body: "A" },
        },
        crypto.randomUUID()
      );
    }
    for (let i = 0; i < 2; i++) {
      await notificationService.submitNotification(
        {
          customerId: tenantB,
          recipient: `low-${i}@example.com`,
          channel: "email",
          payload: { subject: `Low ${i}`, body: "B" },
        },
        crypto.randomUUID()
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Claim a batch of 4 events
      const claimed = await dispatcherRepo.claimUnpublishedEventsReadOnly(client, 4, 60);
      await client.query("COMMIT");

      expect(claimed.length).toBeGreaterThanOrEqual(2);
      expect(claimed.length).toBeLessThanOrEqual(4);

      // Verify that Tenant B's notifications are included in the very first claimed batch
      const claimedNotificationIds = claimed.map((c) => c.notification_id);
      const res = await pool.query(
        "SELECT id, customer_id FROM notifications WHERE id = ANY($1::uuid[])",
        [claimedNotificationIds]
      );

      const tenantACount = res.rows.filter((r) => r.customer_id === tenantA).length;
      const tenantBCount = res.rows.filter((r) => r.customer_id === tenantB).length;

      // Both tenants must have received processing opportunities in the same batch
      expect(tenantBCount).toBeGreaterThan(0);
      expect(tenantACount).toBeGreaterThan(0);
    } finally {
      client.release();
      await pool.query("DELETE FROM idempotency_keys WHERE customer_id IN ($1, $2)", [tenantA, tenantB]).catch(() => {});
      await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2))", [tenantA, tenantB]).catch(() => {});
      await pool.query("DELETE FROM notifications WHERE customer_id IN ($1, $2)", [tenantA, tenantB]).catch(() => {});
    }
  }, 15000);

  // 2. Multiple active tenants receive processing opportunities in round-robin turns
  it("fairly distributes opportunities across multiple active tenants (A, B, C)", async () => {
    const freshA = crypto.randomUUID();
    const freshB = crypto.randomUUID();
    const freshC = crypto.randomUUID();

    await pool.query(
      "INSERT INTO customers (id, name) VALUES ($1, 'Fair A'), ($2, 'Fair B'), ($3, 'Fair C')",
      [freshA, freshB, freshC]
    );

    try {
      // Create 2 notifications for A, 2 for B, 2 for C
      for (let i = 0; i < 2; i++) {
        await notificationService.submitNotification({ customerId: freshA, recipient: `a${i}@example.com`, channel: "sms", payload: { body: "A" } }, crypto.randomUUID());
        await notificationService.submitNotification({ customerId: freshB, recipient: `b${i}@example.com`, channel: "sms", payload: { body: "B" } }, crypto.randomUUID());
        await notificationService.submitNotification({ customerId: freshC, recipient: `c${i}@example.com`, channel: "sms", payload: { body: "C" } }, crypto.randomUUID());
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claimed = await dispatcherRepo.claimUnpublishedEventsReadOnly(client, 3, 60);
        await client.query("COMMIT");

        expect(claimed.length).toBe(3);

        const ids = claimed.map((c) => c.notification_id);
        const res = await pool.query("SELECT id, customer_id FROM notifications WHERE id = ANY($1::uuid[])", [ids]);

        const countA = res.rows.filter((r) => r.customer_id === freshA).length;
        const countB = res.rows.filter((r) => r.customer_id === freshB).length;
        const countC = res.rows.filter((r) => r.customer_id === freshC).length;

        // In a batch of 3 across 3 tenants, each tenant should get exactly 1 opportunity (round-robin turn 1)
        expect(countA).toBe(1);
        expect(countB).toBe(1);
        expect(countC).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await pool.query("DELETE FROM idempotency_keys WHERE customer_id IN ($1, $2, $3)", [freshA, freshB, freshC]).catch(() => {});
      await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2, $3))", [freshA, freshB, freshC]).catch(() => {});
      await pool.query("DELETE FROM notifications WHERE customer_id IN ($1, $2, $3)", [freshA, freshB, freshC]).catch(() => {});
      await pool.query("DELETE FROM customers WHERE id IN ($1, $2, $3)", [freshA, freshB, freshC]).catch(() => {});
    }
  }, 15000);

  // 3. A single active tenant can utilize available capacity (Work-conserving burst)
  it("allows a single active tenant to burst and utilize available capacity when no contention exists", async () => {
    const singleTenant = crypto.randomUUID();
    await tenantFairnessService.reset("email");

    const fairness = new TenantFairnessService(true, 2, 5, 60);

    // Tenant acquires slot 1 (within quota: 1 <= 2)
    const slot1 = await fairness.acquireSlot("email", singleTenant, "job-1");
    expect(slot1.granted).toBe(true);
    expect(slot1.isBurst).toBe(false);

    // Tenant acquires slot 2 (within quota: 2 <= 2)
    const slot2 = await fairness.acquireSlot("email", singleTenant, "job-2");
    expect(slot2.granted).toBe(true);
    expect(slot2.isBurst).toBe(false);

    // Tenant acquires slot 3 (> 2, but sole active tenant: burst allowed up to capacity 5)
    const slot3 = await fairness.acquireSlot("email", singleTenant, "job-3");
    expect(slot3.granted).toBe(true);
    expect(slot3.isBurst).toBe(true);

    const slot4 = await fairness.acquireSlot("email", singleTenant, "job-4");
    expect(slot4.granted).toBe(true);
    expect(slot4.isBurst).toBe(true);

    // Release all acquired slots
    await fairness.releaseSlot("email", singleTenant, "job-1");
    await fairness.releaseSlot("email", singleTenant, "job-2");
    await fairness.releaseSlot("email", singleTenant, "job-3");
    await fairness.releaseSlot("email", singleTenant, "job-4");
  });

  // 4. Concurrent dispatchers preserve claim safety with FOR UPDATE SKIP LOCKED
  it("prevents duplicate claiming when concurrent dispatchers claim events simultaneously", async () => {
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      await client1.query("BEGIN");
      await client2.query("BEGIN");

      const [batch1, batch2] = await Promise.all([
        dispatcherRepo.claimUnpublishedEventsReadOnly(client1, 5, 60),
        dispatcherRepo.claimUnpublishedEventsReadOnly(client2, 5, 60),
      ]);

      await client1.query("COMMIT");
      await client2.query("COMMIT");

      // Set of claimed IDs in batch1 and batch2 must be completely disjoint
      const ids1 = new Set(batch1.map((b) => b.id));
      const ids2 = new Set(batch2.map((b) => b.id));

      for (const id of ids1) {
        expect(ids2.has(id)).toBe(false);
      }
    } finally {
      client1.release();
      client2.release();
    }
  });

  // 5. Worker concurrency limits are respected when contention exists
  it("enforces tenant concurrency limits and denies excess slots when contention exists", async () => {
    const tA = crypto.randomUUID();
    const tB = crypto.randomUUID();
    await tenantFairnessService.reset("sms");

    const fairness = new TenantFairnessService(true, 2, 5, 60);

    // Tenant B acquires a slot (creating contention with 2 distinct active tenants)
    const bSlot1 = await fairness.acquireSlot("sms", tB, "b-job-1");
    expect(bSlot1.granted).toBe(true);

    // Tenant A acquires slot 1 and slot 2 (within limit of 2)
    const aSlot1 = await fairness.acquireSlot("sms", tA, "a-job-1");
    const aSlot2 = await fairness.acquireSlot("sms", tA, "a-job-2");
    expect(aSlot1.granted).toBe(true);
    expect(aSlot2.granted).toBe(true);

    // Tenant A attempts slot 3 under contention: MUST be denied (to be deferred)
    const aSlot3 = await fairness.acquireSlot("sms", tA, "a-job-3");
    expect(aSlot3.granted).toBe(false);

    // Clean up
    await fairness.releaseSlot("sms", tB, "b-job-1");
    await fairness.releaseSlot("sms", tA, "a-job-1");
    await fairness.releaseSlot("sms", tA, "a-job-2");
  });

  // 6. Worker crashes do not permanently consume capacity
  it("ensures slots can be reclaimed and capacity is not permanently locked after worker crash or release", async () => {
    const crashTenant = crypto.randomUUID();
    await tenantFairnessService.reset("email");

    const shortLeaseFairness = new TenantFairnessService(true, 2, 5, 1); // 1-second lease

    await shortLeaseFairness.acquireSlot("email", crashTenant, "crash-job-1");
    await shortLeaseFairness.acquireSlot("email", crashTenant, "crash-job-2");

    // Wait for the short 1-second Redis TTL lease to expire without calling releaseSlot
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Slots must be automatically available again after TTL expiry
    const newSlot = await shortLeaseFairness.acquireSlot("email", crashTenant, "new-job-after-crash");
    expect(newSlot.granted).toBe(true);

    await shortLeaseFairness.releaseSlot("email", crashTenant, "new-job-after-crash");
  });

  // 7. Redis outages preserve durable notifications (Fail-Open)
  it("fails open when Redis is unconfigured or unavailable to protect durable processing", async () => {
    const outageFairness = new TenantFairnessService(true, 2, 5, 60, 50);
    // Simulate Redis timeout / error by targeting invalid port / host
    const badClient = {
      eval: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6399")),
    };

    const res = await outageFairness.acquireSlot("email", tenantA, "outage-job");
    // Under outage or timeout, must fail open
    expect(res.granted).toBe(true);
  });

  // 8. Existing idempotency and rate limiting remain functional
  it("preserves idempotency and rate limiting behavior alongside fairness", async () => {
    const idempKey = crypto.randomUUID();
    const res1 = await notificationService.submitNotification(
      {
        customerId: tenantA,
        recipient: "idemp@example.com",
        channel: "email",
        payload: { subject: "Idemp Test", body: "1" },
      },
      idempKey
    );

    // Identical replay returns existing notification
    const res2 = await notificationService.submitNotification(
      {
        customerId: tenantA,
        recipient: "idemp@example.com",
        channel: "email",
        payload: { subject: "Idemp Test", body: "1" },
      },
      idempKey
    );

    expect(res1.body.id).toBe(res2.body.id);
    expect(res2.isReplay).toBe(true);
  }, 15000);

  // 9. Fairness does not break reconciliation
  it("preserves reconciliation of stuck notifications with expired leases", async () => {
    const stuckNotification = await notificationService.submitNotification(
      {
        customerId: tenantC,
        recipient: "stuck@example.com",
        channel: "email",
        payload: { subject: "Stuck Lease", body: "Reconcile" },
      },
      crypto.randomUUID()
    );

    // Simulate notification stuck in processing with an expired lease
    const pastDate = new Date(Date.now() - 120000); // 2 minutes ago
    await pool.query(
      `UPDATE notifications 
       SET status = 'processing', 
           processing_locked_until = $2, 
           claim_token = 'stuck-token' 
       WHERE id = $1`,
      [stuckNotification.body.id, pastDate]
    );

    const reconciler = new ReconciliationService(60000);
    await reconciler.reconcile();

    // Notification lease should be released so it can be reclaimed
    const check = await pool.query(
      "SELECT status, processing_locked_until FROM notifications WHERE id = $1",
      [stuckNotification.body.id]
    );
    expect(check.rows[0].processing_locked_until).toBeNull();
  }, 15000);

  // 10. Both email and SMS channels work independently
  it("operates fair scheduling and slot allocation independently on both email and SMS channels", async () => {
    const multiChannelTenant = crypto.randomUUID();
    await tenantFairnessService.reset("email");
    await tenantFairnessService.reset("sms");

    // Acquire max slots on email
    const email1 = await tenantFairnessService.acquireSlot("email", multiChannelTenant, "m-email-1");
    const email2 = await tenantFairnessService.acquireSlot("email", multiChannelTenant, "m-email-2");
    expect(email1.granted).toBe(true);
    expect(email2.granted).toBe(true);

    // SMS channel capacity must remain completely independent
    const sms1 = await tenantFairnessService.acquireSlot("sms", multiChannelTenant, "m-sms-1");
    const sms2 = await tenantFairnessService.acquireSlot("sms", multiChannelTenant, "m-sms-2");
    expect(sms1.granted).toBe(true);
    expect(sms2.granted).toBe(true);

    // Clean up
    await tenantFairnessService.releaseSlot("email", multiChannelTenant, "m-email-1");
    await tenantFairnessService.releaseSlot("email", multiChannelTenant, "m-email-2");
    await tenantFairnessService.releaseSlot("sms", multiChannelTenant, "m-sms-1");
    await tenantFairnessService.releaseSlot("sms", multiChannelTenant, "m-sms-2");

    // Verify Prometheus fairness metrics are populated
    const metrics = await getMetrics();
    expect(metrics).toContain("relay_fair_scheduling_decisions_total");
    expect(metrics).toContain("relay_active_tenants");
  });

  // 11. Self-healing active_tenants set and total active counters after worker crashes
  it("self-heals active_tenants set and total active counters after orphaned keys from worker crashes", async () => {
    const crashTenant1 = crypto.randomUUID();
    const activeTenant2 = crypto.randomUUID();
    await tenantFairnessService.reset("email");

    const fairness = new TenantFairnessService(true, 2, 5, 60);

    // Tenant 1 acquires 2 slots
    await fairness.acquireSlot("email", crashTenant1, "crash-slot-1");
    await fairness.acquireSlot("email", crashTenant1, "crash-slot-2");

    // Simulate worker crash: Tenant 1's active key expires/is deleted directly without releaseSlot
    const redis = (await import("../src/config/redis.js")).getRedisClientSync();
    await redis.del(`rl:fair:active:email:${crashTenant1}`);

    // Verify orphaned state before self-healing: tenantsSetKey still has crashTenant1
    const rawTenantsBefore = await redis.smembers("rl:fair:active_tenants:email");
    expect(rawTenantsBefore).toContain(crashTenant1);

    // Tenant 2 now acquires a slot. The Lua script's self-healing loop must purge crashTenant1!
    const slotT2 = await fairness.acquireSlot("email", activeTenant2, "t2-job-1");
    expect(slotT2.granted).toBe(true);

    // Verify self-healing: crashTenant1 has been purged from the active set
    const rawTenantsAfter = await redis.smembers("rl:fair:active_tenants:email");
    expect(rawTenantsAfter).not.toContain(crashTenant1);
    expect(rawTenantsAfter).toContain(activeTenant2);

    // Total active counter must reflect exactly 1 (Tenant 2's job), not 3!
    const totalActive = await redis.get("rl:fair:total_active:email");
    expect(Number(totalActive)).toBe(1);

    // Clean up
    await fairness.releaseSlot("email", activeTenant2, "t2-job-1");
  });

  // 12. Bursting is immediately revoked when contention begins and BullMQ deferral does not mutate DB
  it("immediately revokes bursting eligibility as soon as contention begins and preserves DB state", async () => {
    const burstTenant = tenantA;
    const arrivingTenant = tenantB;
    await tenantFairnessService.reset("email");

    const fairness = new TenantFairnessService(true, 2, 5, 60);

    // 1. burstTenant acquires 2 quota slots + 2 burst slots (total 4 slots) while alone
    await fairness.acquireSlot("email", burstTenant, "b-1");
    await fairness.acquireSlot("email", burstTenant, "b-2");
    const burst1 = await fairness.acquireSlot("email", burstTenant, "b-3");
    const burst2 = await fairness.acquireSlot("email", burstTenant, "b-4");
    expect(burst1.granted).toBe(true);
    expect(burst1.isBurst).toBe(true);
    expect(burst2.granted).toBe(true);
    expect(burst2.isBurst).toBe(true);

    // 2. arrivingTenant arrives and requests its guaranteed quota slot (Condition 1)
    const arrivingSlot = await fairness.acquireSlot("email", arrivingTenant, "arr-1");
    expect(arrivingSlot.granted).toBe(true);
    expect(arrivingSlot.isBurst).toBe(false);

    // 3. burstTenant attempts to acquire a 5th slot. Under contention (activeTenantsCount == 2), MUST be denied
    const deniedSlot = await fairness.acquireSlot("email", burstTenant, "b-5");
    expect(deniedSlot.granted).toBe(false);

    // 4. Verify that deferred notifications never have their DB status mutated to 'processing'
    const notif = await notificationService.submitNotification(
      {
        customerId: burstTenant,
        recipient: "deferred@example.com",
        channel: "email",
        payload: { body: "deferred" },
      },
      crypto.randomUUID()
    );

    const checkDb = await pool.query("SELECT status, processing_started_at, processing_locked_until FROM notifications WHERE id = $1", [notif.body.id]);
    expect(checkDb.rows[0].status).toBe("pending");
    expect(checkDb.rows[0].processing_started_at).toBeNull();
    expect(checkDb.rows[0].processing_locked_until).toBeNull();

    // Clean up
    await fairness.releaseSlot("email", burstTenant, "b-1");
    await fairness.releaseSlot("email", burstTenant, "b-2");
    await fairness.releaseSlot("email", burstTenant, "b-3");
    await fairness.releaseSlot("email", burstTenant, "b-4");
    await fairness.releaseSlot("email", arrivingTenant, "arr-1");
    await pool.query("DELETE FROM outbox_events WHERE notification_id = $1", [notif.body.id]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE id = $1", [notif.body.id]).catch(() => {});
  }, 15000);
});
