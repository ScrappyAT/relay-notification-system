import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import { closeRedisConnection } from "../src/config/redis.js";
import crypto from "crypto";

async function runSmokeTest() {
  const PORT = 3005;
  const server = app.listen(PORT);
  console.log(`Smoke test server started on port ${PORT}`);

  try {
    // 1. GET /v1/health
    console.log("\n--- Testing GET /v1/health ---");
    const healthRes = await fetch(`http://localhost:${PORT}/v1/health`);
    const healthBody = await healthRes.json();
    console.log(`Status: ${healthRes.status}`);
    console.log("Body:", JSON.stringify(healthBody, null, 2));

    // 2. GET /v1/ready
    console.log("\n--- Testing GET /v1/ready ---");
    const readyRes = await fetch(`http://localhost:${PORT}/v1/ready`);
    const readyBody = await readyRes.json();
    console.log(`Status: ${readyRes.status}`);
    console.log("Body:", JSON.stringify(readyBody, null, 2));

    // 3. GET /metrics
    console.log("\n--- Testing GET /metrics ---");
    const metricsRes = await fetch(`http://localhost:${PORT}/metrics`);
    const metricsBody = await metricsRes.text();
    console.log(`Status: ${metricsRes.status}`);
    const relevantLines = metricsBody
      .split("\n")
      .filter((line) => line.startsWith("relay_backpressure") || line.startsWith("relay_outbox_backlog") || line.startsWith("relay_queue_backlog"))
      .slice(0, 10);
    console.log("Sample Backpressure Metrics:\n" + relevantLines.join("\n"));

    // 4. POST /v1/notifications
    console.log("\n--- Testing POST /v1/notifications ---");
    // Ensure test customer exists
    const customerRes = await pool.query(
      "INSERT INTO customers (name) VALUES ('Smoke Test Customer') RETURNING id"
    );
    const customerId = customerRes.rows[0].id;
    const idempotencyKey = crypto.randomUUID();

    const notifRes = await fetch(`http://localhost:${PORT}/v1/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        customerId,
        recipient: "smoke@example.com",
        channel: "email",
        payload: {
          subject: "Smoke Test Notification",
          body: "Testing runtime API endpoints",
        },
      }),
    });
    const notifBody = await notifRes.json();
    console.log(`Status: ${notifRes.status}`);
    console.log("Headers:", {
      "x-backpressure-state": notifRes.headers.get("x-backpressure-state"),
      "ratelimit-limit": notifRes.headers.get("ratelimit-limit"),
      "ratelimit-remaining": notifRes.headers.get("ratelimit-remaining"),
    });
    console.log("Body:", JSON.stringify(notifBody, null, 2));

    // Cleanup
    await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [customerId]);
    await pool.query(
      "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)",
      [customerId]
    );
    await pool.query("DELETE FROM notifications WHERE customer_id = $1", [customerId]);
    await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
    console.log("\nSmoke test cleanup completed.");
  } finally {
    server.close();
    await closeRedisConnection();
    await pool.end();
    console.log("Server stopped successfully.");
  }
}

runSmokeTest().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

