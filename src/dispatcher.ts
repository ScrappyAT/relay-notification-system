import { OutboxDispatcher } from "./services/outboxDispatcher.js";
import { closeRedisConnection } from "./config/redis.js";
import { closeQueues } from "./queues/notificationQueues.js";
import { env } from "./config/env.js";
import { startProcessMetricsServer, MetricsServerInstance } from "./metrics/index.js";

const dispatcher = new OutboxDispatcher(1000);
let metricsServer: MetricsServerInstance | null = null;

if (env.DISPATCHER_METRICS_PORT) {
  startProcessMetricsServer(env.DISPATCHER_METRICS_PORT, "dispatcher")
    .then((server) => {
      metricsServer = server;
    })
    .catch((err) => {
      console.error("Failed to start dispatcher metrics server:", err);
    });
}

dispatcher.start().catch((err) => {
  console.error("Failed to start dispatcher:", err);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down dispatcher...`);

  dispatcher.stop().then(async () => {
    try {
      if (metricsServer) {
        await metricsServer.close();
      }
      await closeQueues();
      await closeRedisConnection();
      console.log("Dispatcher stopped cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
