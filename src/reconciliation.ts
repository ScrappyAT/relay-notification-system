import { ReconciliationService } from "./services/reconciliationService.js";
import { closeRedisConnection } from "./config/redis.js";
import { closeQueues } from "./queues/notificationQueues.js";
import { env } from "./config/env.js";
import { startProcessMetricsServer, MetricsServerInstance } from "./metrics/index.js";

const reconciliationService = new ReconciliationService(30000);
let metricsServer: MetricsServerInstance | null = null;

if (env.RECONCILIATION_METRICS_PORT) {
  startProcessMetricsServer(env.RECONCILIATION_METRICS_PORT, "reconciliation")
    .then((server) => {
      metricsServer = server;
    })
    .catch((err) => {
      console.error("Failed to start reconciliation metrics server:", err);
    });
}

reconciliationService.start().catch((err) => {
  console.error("Failed to start reconciliation service:", err);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down reconciliation service...`);
  
  reconciliationService.stop().then(async () => {
    try {
      if (metricsServer) {
        await metricsServer.close();
      }
      await closeQueues();
      await closeRedisConnection();
      console.log("Reconciliation service stopped cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
