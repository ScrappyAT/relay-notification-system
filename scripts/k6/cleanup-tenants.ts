import fs from "fs";
import path from "path";
import { pool } from "../../src/database/pool.js";

async function cleanupTenants() {
  console.log("Cleaning up k6 load test tenants and related records...");

  const tenantsPath = path.resolve(process.cwd(), "scripts/k6/test-tenants.json");
  if (!fs.existsSync(tenantsPath)) {
    console.log("No test-tenants.json found; nothing to clean up.");
    await pool.end();
    return;
  }

  const tenants = JSON.parse(fs.readFileSync(tenantsPath, "utf-8"));
  const tenantIds = tenants.map((t: any) => t.id);

  if (tenantIds.length > 0) {
    await pool.query("DELETE FROM idempotency_keys WHERE customer_id = ANY($1)", [tenantIds]);
    await pool.query("DELETE FROM recipient_preferences WHERE customer_id = ANY($1)", [tenantIds]);
    await pool.query(
      "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = ANY($1))",
      [tenantIds]
    );
    await pool.query("DELETE FROM notifications WHERE customer_id = ANY($1)", [tenantIds]);
    await pool.query("DELETE FROM customers WHERE id = ANY($1)", [tenantIds]);

    console.log(`Cleaned up ${tenantIds.length} test customers and all associated notification records.`);
  }

  await pool.end();
}

cleanupTenants().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
