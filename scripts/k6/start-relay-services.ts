import { app } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { OutboxDispatcher } from "../../src/services/outboxDispatcher.js";
import { getEmailWorker, closeEmailWorker } from "../../src/workers/emailWorker.js";
import { getSmsWorker, closeSmsWorker } from "../../src/workers/smsWorker.js";
import { closeQueues } from "../../src/queues/notificationQueues.js";
import { closeRedisConnection } from "../../src/config/redis.js";
import { pool } from "../../src/database/pool.js";

const PORT = env.PORT || 3000;

console.log("================================================================================");
console.log("             RELAY NOTIFICATION SYSTEM — k6 TEST RUNTIME STACK                  ");
console.log("================================================================================");

const server = app.listen(PORT, () => {
  console.log(`[Relay API] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[Configuration] RateLimit: ${env.RATE_LIMIT_MAX_REQUESTS} req / ${env.RATE_LIMIT_WINDOW_SECONDS}s`);
  console.log(`[Configuration] DB Pool Max: ${env.DB_POOL_MAX} | Backpressure: ${env.BACKPRESSURE_ENABLED ? "ENABLED" : "DISABLED"}`);
});

const dispatcher = new OutboxDispatcher(1000, 60, env.DISPATCHER_BATCH_SIZE);
dispatcher.start().catch((err) => {
  console.error("[Dispatcher] Error starting:", err.message);
});

const emailWorker = getEmailWorker();
const smsWorker = getSmsWorker();
console.log("[Workers] Email and SMS workers active with simulated provider adapters.");
console.log("[Relay Stack] FULL SYSTEM READY FOR k6 INGRESS TESTING\n");

async function shutdown() {
  console.log("\n[Relay Stack] Gracefully shutting down services...");
  server.close(() => {
    console.log("[Relay API] HTTP listener closed.");
  });

  try {
    await dispatcher.stop();
    await Promise.all([closeEmailWorker(), closeSmsWorker()]);
    await closeQueues();
    await closeRedisConnection();
    await pool.end();
    console.log("[Relay Stack] All background connections terminated cleanly.");
    process.exit(0);
  } catch (err: any) {
    console.error("[Relay Stack] Error during shutdown:", err.message);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
