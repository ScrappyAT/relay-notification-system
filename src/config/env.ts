import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DASHBOARD_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(15),

    REDIS_URL: z.string().url().optional(),

    DISPATCHER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    WORKERS_METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    RECONCILIATION_METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    // Tenant Rate Limiting Configuration (Milestone 6B)
    RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_TIMEOUT_MS: z.coerce.number().int().min(10).default(500),

    // Tenant Fairness Configuration (Milestone 6C)
    FAIRNESS_ENABLED: z.coerce.boolean().default(true),
    TENANT_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).default(2),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).default(10),

    // Backpressure & Overload Protection Configuration (Milestone 6D)
    BACKPRESSURE_ENABLED: z.coerce.boolean().default(true),
    BACKPRESSURE_OUTBOX_DEGRADED_THRESHOLD: z.coerce.number().int().min(1).default(500),
    BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD: z.coerce.number().int().min(1).default(2000),
    BACKPRESSURE_QUEUE_DEGRADED_THRESHOLD: z.coerce.number().int().min(1).default(250),
    BACKPRESSURE_QUEUE_OVERLOAD_THRESHOLD: z.coerce.number().int().min(1).default(1000),
    BACKPRESSURE_CACHE_TTL_MS: z.coerce.number().int().min(50).default(1000),
    BACKPRESSURE_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).default(5),
    BACKPRESSURE_DB_POOL_MAX_RATIO: z.coerce.number().min(0.1).max(1.0).default(0.9),
    DISPATCHER_MAX_QUEUE_BACKLOG: z.coerce.number().int().min(1).default(500),
});

export const env = envSchema.parse(process.env);
