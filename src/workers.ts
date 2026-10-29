import { getEmailWorker, closeEmailWorker } from "./workers/emailWorker.js";
import { getSmsWorker, closeSmsWorker } from "./workers/smsWorker.js";
import { closeRedisConnection } from "./config/redis.js";
import { closeQueues } from "./queues/notificationQueues.js";
import { env } from "./config/env.js";
import { startProcessMetricsServer, MetricsServerInstance } from "./metrics/index.js";

let metricsServer: MetricsServerInstance | null = null;

if (env.WORKERS_METRICS_PORT) {
  startProcessMetricsServer(env.WORKERS_METRICS_PORT, "workers")
    .then((server) => {
      metricsServer = server;
    })
    .catch((err) => {
      console.error("Failed to start workers metrics server:", err);
    });
}

const emailWorker = getEmailWorker();
const smsWorker = getSmsWorker();

console.log("Workers started - consuming email and SMS queues");

function shutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down workers...`);
  
  Promise.all([closeEmailWorker(), closeSmsWorker()])
    .then(async () => {
      try {
        if (metricsServer) {
          await metricsServer.close();
        }
        await closeQueues();
        await closeRedisConnection();
        console.log("Workers stopped cleanly.");
        process.exit(0);
      } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Error closing workers:", err);
      process.exit(1);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
