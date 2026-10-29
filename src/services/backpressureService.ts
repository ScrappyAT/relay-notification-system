import { pool } from "../database/pool.js";
import { env } from "../config/env.js";
import { isRedisConnected } from "../config/redis.js";
import { getEmailQueue, getSmsQueue } from "../queues/notificationQueues.js";
import {
  BackpressureState,
  setBackpressureStateMetric,
  setOutboxBacklogMetric,
  setQueueBacklogMetric,
  recordBackpressureRejection,
  recordAdmissionCheckDuration,
  recordDependencyCheckFailure,
  recordBackpressureStateDuration,
} from "../metrics/index.js";

export interface BackpressureMetricsSnapshot {
  outboxBacklog: number;
  emailQueueDepth: number;
  smsQueueDepth: number;
  totalQueueDepth: number;
  dbPoolUtilization: number;
  dbHealthy: boolean;
  redisConnected: boolean;
}

export interface AdmissionDecision {
  allowed: boolean;
  state: BackpressureState;
  reason?: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded";
  retryAfter?: number;
}

export class BackpressureService {
  public enabled: boolean;
  public outboxDegradedThreshold: number;
  public outboxOverloadThreshold: number;
  public queueDegradedThreshold: number;
  public queueOverloadThreshold: number;
  public cacheTtlMs: number;
  public retryAfterSeconds: number;
  public dbPoolMaxRatio: number;

  private currentState: BackpressureState = "NORMAL";
  private currentReason?: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded";
  private lastEvaluatedAt: number = 0;
  private lastStateChangeAt: number = Date.now();
  private overrideState: BackpressureState | null = null;
  private backgroundIntervalId: NodeJS.Timeout | null = null;
  private consecutiveDbFailures: number = 0;

  private cachedMetrics: BackpressureMetricsSnapshot = {
    outboxBacklog: 0,
    emailQueueDepth: 0,
    smsQueueDepth: 0,
    totalQueueDepth: 0,
    dbPoolUtilization: 0,
    dbHealthy: true,
    redisConnected: true,
  };

  constructor(
    enabled: boolean = env.BACKPRESSURE_ENABLED,
    outboxDegradedThreshold: number = env.BACKPRESSURE_OUTBOX_DEGRADED_THRESHOLD,
    outboxOverloadThreshold: number = env.BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD,
    queueDegradedThreshold: number = env.BACKPRESSURE_QUEUE_DEGRADED_THRESHOLD,
    queueOverloadThreshold: number = env.BACKPRESSURE_QUEUE_OVERLOAD_THRESHOLD,
    cacheTtlMs: number = env.BACKPRESSURE_CACHE_TTL_MS,
    retryAfterSeconds: number = env.BACKPRESSURE_RETRY_AFTER_SECONDS,
    dbPoolMaxRatio: number = env.BACKPRESSURE_DB_POOL_MAX_RATIO
  ) {
    this.enabled = enabled;
    this.outboxDegradedThreshold = outboxDegradedThreshold;
    this.outboxOverloadThreshold = outboxOverloadThreshold;
    this.queueDegradedThreshold = queueDegradedThreshold;
    this.queueOverloadThreshold = queueOverloadThreshold;
    this.cacheTtlMs = cacheTtlMs;
    this.retryAfterSeconds = retryAfterSeconds;
    this.dbPoolMaxRatio = dbPoolMaxRatio;

    // Initialize metrics
    setBackpressureStateMetric("NORMAL");
  }

  /**
   * Evaluates the current system state across PostgreSQL outbox backlog,
   * Redis BullMQ queue depths, and database connection pool health.
   * Utilizes cached measurements within cacheTtlMs to eliminate full-table scan overhead on every request.
   */
  async evaluateState(forceRefresh: boolean = false): Promise<{
    state: BackpressureState;
    reason?: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded";
    metrics: BackpressureMetricsSnapshot;
  }> {
    if (this.overrideState !== null) {
      return {
        state: this.overrideState,
        reason: this.currentReason ?? (this.overrideState === "OVERLOADED" ? "system_overloaded" : undefined),
        metrics: this.cachedMetrics,
      };
    }

    if (!this.enabled) {
      return { state: "NORMAL", metrics: this.cachedMetrics };
    }

    const now = Date.now();
    if (!forceRefresh && now - this.lastEvaluatedAt < this.cacheTtlMs) {
      return {
        state: this.currentState,
        reason: this.currentReason,
        metrics: this.cachedMetrics,
      };
    }

    // 1. Evaluate PostgreSQL Health & Outbox Backlog with bounded timeout
    let dbHealthy = true;
    let outboxBacklog = this.cachedMetrics.outboxBacklog;
    let poolUtilization = 0;

    try {
      const dbQueryPromise = pool.query(
        "SELECT COUNT(*) as count FROM outbox_events WHERE published_at IS NULL AND failed_at IS NULL"
      );
      const dbTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Database check timeout")), 2500)
      );

      const dbRes = await Promise.race([dbQueryPromise, dbTimeoutPromise]);
      outboxBacklog = parseInt(dbRes.rows[0].count, 10);
      setOutboxBacklogMetric(outboxBacklog);
      this.consecutiveDbFailures = 0;
      dbHealthy = true;

      // Check pool saturation
      const total = pool.totalCount;
      const idle = pool.idleCount;
      poolUtilization = total > 0 ? (total - idle) / total : 0;
    } catch (err: any) {
      this.consecutiveDbFailures++;
      recordDependencyCheckFailure("postgres");
      console.warn(
        `[BackpressureService] PostgreSQL check failed (attempt ${this.consecutiveDbFailures}): ${err.message}`
      );
      // Require at least 2 consecutive failures to prevent transient network latency from causing false overload
      dbHealthy = this.consecutiveDbFailures >= 2 ? false : this.cachedMetrics.dbHealthy;
    }

    // 2. Evaluate Redis Queue Depths (Email + SMS) with bounded timeout
    const redisConnected = isRedisConnected();
    let emailQueueDepth = 0;
    let smsQueueDepth = 0;

    if (redisConnected && env.REDIS_URL) {
      try {
        const queueCheckPromise = (async () => {
          const emailQ = getEmailQueue();
          const smsQ = getSmsQueue();

          const [emailCounts, smsCounts] = await Promise.all([
            emailQ.getJobCounts("waiting", "delayed"),
            smsQ.getJobCounts("waiting", "delayed"),
          ]);

          return {
            emailDepth: (emailCounts.waiting || 0) + (emailCounts.delayed || 0),
            smsDepth: (smsCounts.waiting || 0) + (smsCounts.delayed || 0),
          };
        })();

        const queueTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Queue check timeout")), 500)
        );

        const counts = await Promise.race([queueCheckPromise, queueTimeoutPromise]);
        emailQueueDepth = counts.emailDepth;
        smsQueueDepth = counts.smsDepth;

        setQueueBacklogMetric("email", emailQueueDepth);
        setQueueBacklogMetric("sms", smsQueueDepth);
        setQueueBacklogMetric("all", emailQueueDepth + smsQueueDepth);
      } catch (err: any) {
        recordDependencyCheckFailure("redis");
        console.warn(`[BackpressureService] Redis queue check failed: ${err.message}`);
      }
    } else {
      // Redis outage does NOT cause dependency check failure unless configured
      // Treat queue depth as cached or zero
      emailQueueDepth = this.cachedMetrics.emailQueueDepth;
      smsQueueDepth = this.cachedMetrics.smsQueueDepth;
    }

    const totalQueueDepth = emailQueueDepth + smsQueueDepth;

    this.cachedMetrics = {
      outboxBacklog,
      emailQueueDepth,
      smsQueueDepth,
      totalQueueDepth,
      dbPoolUtilization: poolUtilization,
      dbHealthy,
      redisConnected,
    };

    // 3. Compute State based on explicit hierarchy
    let nextState: BackpressureState = "NORMAL";
    let nextReason: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded" | undefined = undefined;

    if (!dbHealthy || (pool.waitingCount > 0 && poolUtilization >= this.dbPoolMaxRatio)) {
      nextState = "OVERLOADED";
      nextReason = "db_health";
    } else if (outboxBacklog >= this.outboxOverloadThreshold) {
      nextState = "OVERLOADED";
      nextReason = "outbox_backlog";
    } else if (totalQueueDepth >= this.queueOverloadThreshold) {
      nextState = "OVERLOADED";
      nextReason = "queue_depth";
    } else if (outboxBacklog >= this.outboxDegradedThreshold) {
      nextState = "DEGRADED";
      nextReason = "outbox_backlog";
    } else if (totalQueueDepth >= this.queueDegradedThreshold) {
      nextState = "DEGRADED";
      nextReason = "queue_depth";
    } else if (!redisConnected) {
      // Redis outage with backlog below overload threshold -> DEGRADED
      // (Durable acceptance in PostgreSQL remains available!)
      nextState = "DEGRADED";
      nextReason = undefined;
    }

    // 4. Record State Transitions and Metrics
    if (nextState !== this.currentState) {
      const stateDurationSec = (now - this.lastStateChangeAt) / 1000;
      recordBackpressureStateDuration(this.currentState, stateDurationSec);

      console.log(
        `[BackpressureService] State transition: ${this.currentState} -> ${nextState} (Reason: ${nextReason ?? "none"}, Outbox: ${outboxBacklog}, Queue: ${totalQueueDepth})`
      );

      this.currentState = nextState;
      this.currentReason = nextReason;
      this.lastStateChangeAt = now;
      setBackpressureStateMetric(nextState);
    }

    this.lastEvaluatedAt = now;
    return { state: this.currentState, reason: this.currentReason, metrics: this.cachedMetrics };
  }

  /**
   * Admission control check invoked by POST /v1/notifications.
   * Returns whether the request is admitted, along with retry guidance if rejected.
   */
  async checkAdmission(): Promise<AdmissionDecision> {
    const start = process.hrtime.bigint();
    try {
      const { state, reason } = await this.evaluateState();
      const allowed = state !== "OVERLOADED";

      if (!allowed && reason) {
        recordBackpressureRejection(reason);
      }

      return {
        allowed,
        state,
        reason,
        retryAfter: allowed ? undefined : this.retryAfterSeconds,
      };
    } finally {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      recordAdmissionCheckDuration(durationSec);
    }
  }

  /**
   * Returns current cached metrics snapshot without executing database/Redis queries.
   */
  getSnapshot(): BackpressureMetricsSnapshot & { state: BackpressureState; reason?: string } {
    return {
      ...this.cachedMetrics,
      state: this.overrideState ?? this.currentState,
      reason: this.currentReason,
    };
  }

  /**
   * Starts background evaluation timer for continuous periodic measurement.
   */
  startBackgroundRefresher(intervalMs: number = this.cacheTtlMs): void {
    if (this.backgroundIntervalId) return;
    this.backgroundIntervalId = setInterval(() => {
      this.evaluateState(true).catch((err) => {
        console.warn(`[BackpressureService] Background refresh error: ${err.message}`);
      });
    }, intervalMs);
  }

  /**
   * Stops background evaluation timer.
   */
  stopBackgroundRefresher(): void {
    if (this.backgroundIntervalId) {
      clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
  }

  /**
   * Testing hook: Manual override for deterministic unit and integration tests.
   */
  setOverrideState(state: BackpressureState | null, reason?: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded"): void {
    this.overrideState = state;
    if (state !== null) {
      this.currentState = state;
      this.currentReason = reason;
      setBackpressureStateMetric(state);
    }
  }

  /**
   * Testing hook: Adjust thresholds dynamically during tests.
   */
  setThresholds(thresholds: {
    outboxDegraded?: number;
    outboxOverload?: number;
    queueDegraded?: number;
    queueOverload?: number;
    cacheTtlMs?: number;
    retryAfterSeconds?: number;
  }): void {
    if (thresholds.outboxDegraded !== undefined) this.outboxDegradedThreshold = thresholds.outboxDegraded;
    if (thresholds.outboxOverload !== undefined) this.outboxOverloadThreshold = thresholds.outboxOverload;
    if (thresholds.queueDegraded !== undefined) this.queueDegradedThreshold = thresholds.queueDegraded;
    if (thresholds.queueOverload !== undefined) this.queueOverloadThreshold = thresholds.queueOverload;
    if (thresholds.cacheTtlMs !== undefined) this.cacheTtlMs = thresholds.cacheTtlMs;
    if (thresholds.retryAfterSeconds !== undefined) this.retryAfterSeconds = thresholds.retryAfterSeconds;
  }

  /**
   * Testing hook: Resets service to default configuration.
   */
  reset(): void {
    this.overrideState = null;
    this.currentState = "NORMAL";
    this.currentReason = undefined;
    this.lastEvaluatedAt = 0;
    this.outboxDegradedThreshold = env.BACKPRESSURE_OUTBOX_DEGRADED_THRESHOLD;
    this.outboxOverloadThreshold = env.BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD;
    this.queueDegradedThreshold = env.BACKPRESSURE_QUEUE_DEGRADED_THRESHOLD;
    this.queueOverloadThreshold = env.BACKPRESSURE_QUEUE_OVERLOAD_THRESHOLD;
    this.cacheTtlMs = env.BACKPRESSURE_CACHE_TTL_MS;
    this.retryAfterSeconds = env.BACKPRESSURE_RETRY_AFTER_SECONDS;
    this.consecutiveDbFailures = 0;
    setBackpressureStateMetric("NORMAL");
  }
}

export const backpressureService = new BackpressureService();
