import fs from "fs";
import path from "path";
import { pool } from "../../src/database/pool.js";
import { getEmailQueue, getSmsQueue, closeQueues } from "../../src/queues/notificationQueues.js";
import { closeRedisConnection } from "../../src/config/redis.js";

async function verifyDrain() {
  console.log("================================================================================");
  console.log("             RELAY NOTIFICATION SYSTEM — k6 POST-TEST DRAIN AUDIT               ");
  console.log("================================================================================");

  const tenantsPath = path.resolve(process.cwd(), "scripts/k6/test-tenants.json");
  if (!fs.existsSync(tenantsPath)) {
    console.log("No test-tenants.json found.");
    await pool.end();
    return;
  }

  const tenants = JSON.parse(fs.readFileSync(tenantsPath, "utf-8"));
  const tenantIds = tenants.map((t: any) => t.id);

  // 1. Notification Status Breakdown in PostgreSQL
  const statusRes = await pool.query(
    `SELECT status, channel, COUNT(*)::int as count
     FROM notifications
     WHERE customer_id = ANY($1)
     GROUP BY status, channel
     ORDER BY status, channel`,
    [tenantIds]
  );

  console.log("\n[PostgreSQL Notification Status Breakdown]:");
  console.table(statusRes.rows);

  // 2. Outbox Events Status
  const outboxRes = await pool.query(
    `SELECT
       COUNT(*)::int as total_events,
       COUNT(published_at)::int as published_events,
       COUNT(CASE WHEN published_at IS NULL AND failed_at IS NULL THEN 1 END)::int as pending_events,
       COUNT(failed_at)::int as failed_events
     FROM outbox_events
     WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = ANY($1))`,
    [tenantIds]
  );

  console.log("\n[PostgreSQL Outbox Publication Breakdown]:");
  console.table(outboxRes.rows);

  // 3. BullMQ Queue Counts
  try {
    const emailQ = getEmailQueue();
    const smsQ = getSmsQueue();

    const [emailCounts, smsCounts] = await Promise.all([
      emailQ.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
      smsQ.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
    ]);

    console.log("\n[BullMQ Queue Depths]:");
    console.log("Email Queue:", emailCounts);
    console.log("SMS Queue:  ", smsCounts);
  } catch (err: any) {
    console.warn("Could not query BullMQ queue counts:", err.message);
  } finally {
    await closeQueues();
    await closeRedisConnection();
    await pool.end();
  }

  console.log("================================================================================\n");
}

verifyDrain().catch((err) => {
  console.error("Drain verification error:", err);
  process.exit(1);
});
