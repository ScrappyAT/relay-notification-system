import express from "express";
import cors from "cors";
import notificationsRouter from "./routes/notifications.js";
import readyRouter from "./routes/ready.js";
import { metricsMiddleware, getMetrics, register } from "./metrics/index.js";
import { updateQueueMetrics } from "./metrics/queueMetrics.js";
import { pool } from "./database/pool.js";
import { setOutboxAwaitingPublication } from "./metrics/dispatcherMetrics.js";

export const app = express();

app.disable("x-powered-by");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Collect HTTP request metrics
app.use(metricsMiddleware);

// Liveness health endpoint
app.get("/v1/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "relay",
    timestamp: new Date().toISOString(),
  });
});

// Readiness dependency check endpoint
app.use("/v1/ready", readyRouter);

// Prometheus metrics endpoint
app.get("/metrics", async (_req, res) => {
  try {
    // Optionally update queue gauges and outbox gauges on scrape if available
    try {
      await updateQueueMetrics();
    } catch {
      // Ignore background gauge update error
    }

    try {
      const outboxRes = await pool.query(
        "SELECT COUNT(*) as count FROM outbox_events WHERE published_at IS NULL AND failed_at IS NULL"
      );
      if (outboxRes.rows && outboxRes.rows[0]) {
        setOutboxAwaitingPublication(parseInt(outboxRes.rows[0].count, 10));
      }
    } catch {
      // Ignore database gauge query error
    }

    const metrics = await getMetrics();
    res.setHeader("Content-Type", register.contentType);
    res.status(200).send(metrics);
  } catch (err: any) {
    res.status(500).send(`Error collecting metrics: ${err.message}`);
  }
});

app.use("/v1/notifications", notificationsRouter);

app.use((_req, res) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: "The requested resource was not found.",
  });
});