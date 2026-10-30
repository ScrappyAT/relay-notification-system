import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { env } from "../config/env.js";
import { localOnly } from "../middleware/localOnly.js";
import { getRedisClient, getRedisConnectionStats } from "../config/redis.js";
import { getEmailQueue, getSmsQueue } from "../queues/notificationQueues.js";
import { register } from "../metrics/registry.js";

const router = Router();
router.use((_req, res, next) => {
  if (!env.DASHBOARD_ENABLED) { res.status(404).json({ code: "NOT_FOUND", message: "Local dashboard is disabled." }); return; }
  next();
});
router.use(localOnly);

const statuses = ["pending", "queued", "processing", "processed", "provider_accepted", "delivered", "failed", "outcome_unknown", "suppressed"] as const;
const querySchema = z.object({
  customerId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
  channel: z.enum(["email", "sms"]).optional(),
  status: z.enum(statuses).optional(),
  search: z.string().max(255).default(""),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

// Every dashboard query is read-only, parameterized, bounded and returns no payloads/secrets.
function query(text: string, values?: unknown[]) {
  // node-postgres accepts per-query timeouts; its public QueryConfig omits that option.
  const config = { text, values, query_timeout: 5000 };
  return pool.query(config);
}

router.get("/customers", async (_req, res) => {
  try {
    const result = await query("SELECT id, name FROM customers ORDER BY name, id LIMIT 1000");
    res.json({ customers: result.rows });
  } catch { res.status(503).json({ message: "Cannot load tenants. Check the API database connection." }); }
});

router.get("/overview", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: "Invalid dashboard filters." }); return; }
  const { customerId, days } = parsed.data;
  try {
    const result = await query(`
      WITH scope AS (
        SELECT channel, status, created_at FROM notifications
        WHERE ($1::uuid IS NULL OR customer_id = $1)
          AND created_at >= (((NOW() AT TIME ZONE 'UTC')::date - ($2::int - 1))::timestamp AT TIME ZONE 'UTC')
      ), series AS (
        SELECT generate_series(((NOW() AT TIME ZONE 'UTC')::date - ($2::int - 1))::timestamp,
          (NOW() AT TIME ZONE 'UTC')::date::timestamp, interval '1 day') AS day
      )
      SELECT
        (SELECT count(*)::int FROM scope) AS total,
        (SELECT count(*)::int FROM scope WHERE status = 'provider_accepted') AS accepted,
        (SELECT count(*)::int FROM scope WHERE status = 'delivered') AS delivered,
        (SELECT count(*)::int FROM scope WHERE status = 'failed') AS failed,
        (SELECT count(*)::int FROM scope WHERE status = 'outcome_unknown') AS unknown,
        (SELECT count(*)::int FROM scope WHERE status = 'suppressed') AS suppressed,
        (SELECT count(*)::int FROM scope WHERE status IN ('pending','queued','processing')) AS in_flight,
        (SELECT count(*)::int FROM scope WHERE channel = 'email') AS email,
        (SELECT count(*)::int FROM scope WHERE channel = 'sms') AS sms,
        (SELECT json_agg(row_to_json(a) ORDER BY a.day) FROM (
          SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
            count(n.created_at) FILTER (WHERE channel = 'email')::int AS email,
            count(n.created_at) FILTER (WHERE channel = 'sms')::int AS sms
          FROM series s LEFT JOIN scope n ON n.created_at >= (s.day AT TIME ZONE 'UTC')
            AND n.created_at < ((s.day + interval '1 day') AT TIME ZONE 'UTC')
          GROUP BY s.day
        ) a) AS activity`, [customerId ?? null, days]);
    res.json({ ...result.rows[0], days, timezone: "UTC", sampledAt: new Date().toISOString() });
  } catch { res.status(503).json({ message: "Statistics unavailable. Check PostgreSQL and the existing migrations." }); }
});

router.get("/notifications", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: "Invalid notification filters." }); return; }
  const { customerId, channel, status, search, page, limit } = parsed.data;
  try {
    const values = [customerId ?? null, channel ?? null, status ?? null, search];
    const where = `WHERE ($1::uuid IS NULL OR n.customer_id = $1)
      AND ($2::text IS NULL OR n.channel = $2) AND ($3::text IS NULL OR n.status = $3)
      AND ($4::text = '' OR strpos(lower(n.recipient), lower($4)) > 0 OR strpos(n.id::text, lower($4)) > 0)`;
    const [rows, count] = await Promise.all([
      query(`SELECT n.id, n.customer_id, c.name AS customer_name, n.recipient, n.channel, n.status,
        n.retry_count, n.created_at, n.updated_at FROM notifications n JOIN customers c ON c.id = n.customer_id
        ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT $5 OFFSET $6`, [...values, limit, (page - 1) * limit]),
      query(`SELECT count(*)::int AS total FROM notifications n ${where}`, values),
    ]);
    res.json({ notifications: rows.rows, total: count.rows[0].total, page, limit });
  } catch { res.status(503).json({ message: "Notification history unavailable. Check the database connection." }); }
});

router.get("/preferences", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success || !parsed.data.customerId) { res.status(400).json({ message: "Select a valid tenant." }); return; }
  const { customerId, search, page, limit } = parsed.data;
  try {
    const [result, count] = await Promise.all([query(`SELECT id, recipient, channel, enabled, updated_at
      FROM recipient_preferences WHERE customer_id = $1 AND ($2::text = '' OR strpos(lower(recipient), lower($2)) > 0)
      ORDER BY updated_at DESC, id DESC LIMIT $3 OFFSET $4`, [customerId, search, limit, (page - 1) * limit]),
      query(`SELECT count(*)::int AS total FROM recipient_preferences WHERE customer_id = $1
        AND ($2::text = '' OR strpos(lower(recipient), lower($2)) > 0)`, [customerId, search]),
    ]);
    res.json({ preferences: result.rows, total: count.rows[0].total, page, limit });
  } catch { res.status(503).json({ message: "Saved preferences unavailable. Check the database connection." }); }
});

async function bounded<T>(operation: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

router.get("/monitoring", async (_req, res) => {
  const [database, queues] = await Promise.allSettled([
    query(`SELECT count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - min(created_at) FILTER (WHERE published_at IS NULL AND failed_at IS NULL))), 0)::float AS oldest_seconds
      FROM outbox_events`),
    bounded((async () => {
      if (!env.REDIS_URL) throw new Error("unconfigured");
      await getRedisClient();
      const entries = await Promise.all([getEmailQueue(), getSmsQueue()].map(async (q, i) => ({
        channel: i === 0 ? "email" : "sms",
        ...await q.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
      })));
      return entries;
    })()),
  ]);
  const metrics = await register.getMetricsAsJSON();
  const requests = metrics.find(m => m.name === "relay_api_requests_total")?.values ?? [];
  const totalRequests = requests.reduce((sum, v) => sum + v.value, 0);
  const serverErrors = requests.filter(v => Number(v.labels.status_code) >= 500).reduce((sum, v) => sum + v.value, 0);
  const stats = getRedisConnectionStats();
  res.json({
    api: "healthy", database: database.status === "fulfilled" ? "healthy" : "unavailable",
    redis: queues.status === "fulfilled" ? "healthy" : "unavailable",
    outbox: database.status === "fulfilled" ? database.value.rows[0] : null,
    queues: queues.status === "fulfilled" ? queues.value : null,
    uptimeSeconds: Math.floor(process.uptime()), totalRequests, serverErrors,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: env.DB_POOL_MAX },
    redisReconnects: stats.reconnectsCount,
    sampledAt: new Date().toISOString(), scope: "Queues and outbox are global; request counters belong to this API process. Worker liveness is not inferred from empty queues.",
  });
});

export default router;
