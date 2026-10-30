import { pool } from "../src/database/pool.js";
import { env } from "../src/config/env.js";

// Explicit opt-in helper: creates only a tenant, never fabricated notification statistics.
async function main() {
  const url = new URL(env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use a localhost PostgreSQL database for the dashboard demo helper.");
  }
  const existing = await pool.query("SELECT id, name FROM customers WHERE name = $1 ORDER BY created_at LIMIT 1", ["Relay demo workspace"]);
  const customer = existing.rows[0] ?? (await pool.query("INSERT INTO customers(name) VALUES ($1) RETURNING id, name", ["Relay demo workspace"])).rows[0];
  console.log(`Local demo tenant ready: ${customer.name} (${customer.id})`);
}
main().catch(() => { console.error("Unable to prepare a local demo tenant. Check PostgreSQL and the schema."); process.exitCode = 1; }).finally(() => pool.end());
