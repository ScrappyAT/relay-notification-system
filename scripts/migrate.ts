import { pool } from "../src/database/pool.js";
import fs from "fs";
import path from "path";

async function runMigration() {
  const migrationPath = path.resolve(process.cwd(), "src/database/migrations/006_notification_preferences.sql");
  console.log(`Reading migration from: ${migrationPath}`);
  const sql = fs.readFileSync(migrationPath, "utf8");

  console.log("Applying migration 006_notification_preferences.sql...");
  await pool.query(sql);
  console.log("Migration 006 applied successfully!");

  // Verify recipient_preferences table exists
  const check = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'recipient_preferences'"
  );
  console.log("Table check result:", check.rows);

  await pool.end();
}

runMigration().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
