import crypto from "crypto";
import { getRedisClient, getRedisClientSync, isRedisConnected } from "../config/redis.js";
import { env } from "../config/env.js";
import {
  recordRateLimitEvaluation,
  recordRateLimitRedisFailure,
} from "../metrics/index.js";
import Redis from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  member?: string;
  failOpen?: boolean;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local clearBefore = now - window

-- Remove elements outside the sliding window
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)

-- Count current elements in the window
local current = redis.call('ZCARD', key)

if current < limit then
    -- Record this request
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    local remaining = limit - current - 1
    local resetSec = math.ceil(window / 1000)
    return {1, remaining, resetSec}
else
    -- Limit exceeded: calculate remaining time until oldest request rolls off
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local resetMs = window
    if oldest and #oldest >= 2 then
        local oldestScore = tonumber(oldest[2])
        resetMs = math.max(0, (oldestScore + window) - now)
    end
    redis.call('PEXPIRE', key, window)
    local resetSec = math.max(1, math.ceil(resetMs / 1000))
    return {0, 0, resetSec}
end
`;

export class RateLimiter {
  public windowSeconds: number;
  public maxRequests: number;
  public timeoutMs: number;
  public enabled: boolean;
  private lastWarningLogTime: number = 0;

  constructor(
    windowSeconds: number = env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: number = env.RATE_LIMIT_MAX_REQUESTS,
    timeoutMs: number = env.RATE_LIMIT_TIMEOUT_MS,
    enabled: boolean = env.RATE_LIMIT_ENABLED
  ) {
    this.windowSeconds = windowSeconds;
    this.maxRequests = maxRequests;
    this.timeoutMs = timeoutMs;
    this.enabled = enabled;
  }

  /**
   * Generates a namespaced Redis key for a tenant rate limit.
   */
  public getKey(customerId: string): string {
    return `rl:tenant:${customerId}`;
  }

  /**
   * Evaluates rate limit for a given tenant customerId using atomic Redis Lua script.
   * Employs bounded timeouts and fails open if Redis is unavailable.
   */
  async consume(customerId: string): Promise<RateLimitResult> {
    if (!this.enabled) {
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests,
        resetSeconds: 0,
      };
    }

    const startHr = process.hrtime.bigint();
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    const member = `${now}:${crypto.randomUUID()}`;
    const key = this.getKey(customerId);

    if (!env.REDIS_URL) {
      return this.handleFailOpen(startHr, "REDIS_URL is not configured");
    }

    try {
      let client: Redis;
      if (isRedisConnected()) {
        client = getRedisClientSync();
      } else {
        const connectTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Redis connection timeout")), this.timeoutMs)
        );
        client = await Promise.race([getRedisClient(), connectTimeoutPromise]);
      }

      // Execute Lua script with bounded timeout
      const evalPromise = client.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        this.maxRequests.toString(),
        member
      ) as Promise<[number, number, number]>;

      const evalTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Rate limiter timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        )
      );

      const result = await Promise.race([evalPromise, evalTimeoutPromise]);
      const durationSeconds = Number(process.hrtime.bigint() - startHr) / 1e9;

      const allowed = result[0] === 1;
      const remaining = Number(result[1]);
      const resetSeconds = Number(result[2]);

      recordRateLimitEvaluation(allowed ? "allowed" : "rate_limited", durationSeconds);

      return {
        allowed,
        limit: this.maxRequests,
        remaining,
        resetSeconds,
        member: allowed ? member : undefined,
      };
    } catch (err: any) {
      return this.handleFailOpen(startHr, err.message);
    }
  }

  /**
   * Refunds a consumed token for safe idempotent replays.
   */
  async refund(customerId: string, member: string): Promise<void> {
    if (!this.enabled || !member || !env.REDIS_URL) {
      return;
    }

    try {
      const client = getRedisClientSync();
      const key = this.getKey(customerId);
      await client.zrem(key, member);
    } catch (err: any) {
      // Silently ignore refund errors during transient connection drops
    }
  }

  /**
   * Resets rate limit for a tenant (primarily for tests and administration).
   */
  async reset(customerId: string): Promise<void> {
    if (!env.REDIS_URL) return;
    try {
      const client = getRedisClientSync();
      const key = this.getKey(customerId);
      await client.del(key);
    } catch {
      // Ignore
    }
  }

  /**
   * Handles fail-open fallback when Redis is unreachable or slow.
   */
  public handleFailOpen(startHr: bigint, reason: string): RateLimitResult {
    const durationSeconds = Number(process.hrtime.bigint() - startHr) / 1e9;
    recordRateLimitRedisFailure();
    recordRateLimitEvaluation("fail_open", durationSeconds);

    const now = Date.now();
    if (now - this.lastWarningLogTime >= 30000) {
      this.lastWarningLogTime = now;
      console.warn(
        `[RateLimiter] Redis unavailable (${reason}). Failing open to preserve durable ingestion.`
      );
    }

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: this.maxRequests,
      resetSeconds: 0,
      failOpen: true,
    };
  }
}

export const rateLimiter = new RateLimiter();

