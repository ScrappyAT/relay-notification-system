import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pool } from "../../src/database/pool.js";

async function seedTenants() {
  console.log("Seeding dedicated k6 load test tenants in PostgreSQL...");

  const tenants = [
    { id: crypto.randomUUID(), name: "k6 Load Test Tenant Alpha" },
    { id: crypto.randomUUID(), name: "k6 Load Test Tenant Beta" },
    { id: crypto.randomUUID(), name: "k6 Load Test Tenant Gamma" },
  ];

  for (const t of tenants) {
    await pool.query(
      "INSERT INTO customers (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [t.id, t.name]
    );

    // Seed one suppressed channel preference for optout-user@example.com in each tenant
    await pool.query(
      `INSERT INTO recipient_preferences (customer_id, recipient, channel, enabled)
       VALUES ($1, 'optout-user@example.com', 'email', false)
       ON CONFLICT (customer_id, recipient, channel) DO UPDATE SET enabled = false`,
      [t.id]
    );
  }

  const scriptsTenantsPath = path.resolve(process.cwd(), "scripts/k6/test-tenants.json");
  const benchmarksTenantsPath = path.resolve(process.cwd(), "benchmarks/k6/test-tenants.json");

  fs.writeFileSync(scriptsTenantsPath, JSON.stringify(tenants, null, 2));
  fs.writeFileSync(benchmarksTenantsPath, JSON.stringify(tenants, null, 2));

  console.log(`Successfully seeded ${tenants.length} tenants and saved to:`);
  console.log(` - ${scriptsTenantsPath}`);
  console.log(` - ${benchmarksTenantsPath}`);

  await pool.end();
}

seedTenants().catch((err) => {
  console.error("Failed to seed k6 tenants:", err);
  process.exit(1);
});
