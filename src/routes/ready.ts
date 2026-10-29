import { Router, Request, Response } from "express";
import { pool } from "../database/pool.js";
import { isRedisConnected } from "../config/redis.js";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  const redisHealthy = isRedisConnected();

  try {
    // Lightweight check for PostgreSQL (durable acceptance dependency)
    // Run query with a strict query timeout or quick execution
    await pool.query("SELECT 1");

    return res.status(200).json({
      status: "ready",
      service: "relay",
      timestamp,
      dependencies: {
        database: "healthy",
        redis: redisHealthy ? "healthy" : "unavailable",
      },
      durableAcceptance: true,
      note: redisHealthy
        ? undefined
        : "Redis unavailable; API ready for durable ingestion via PostgreSQL transactional outbox. Queue publication delayed until reconnection.",
    });
  } catch (error: any) {
    return res.status(503).json({
      status: "not_ready",
      service: "relay",
      timestamp,
      dependencies: {
        database: "unhealthy",
        redis: redisHealthy ? "healthy" : "unavailable",
      },
      durableAcceptance: false,
      error: "PostgreSQL dependency is unavailable; durable ingestion halted.",
    });
  }
});

export default router;

