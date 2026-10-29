import { getRedisClient, getRedisClientSync, isRedisConnected } from "../config/redis.js";
import { env } from "../config/env.js";
import {
  recordFairSchedulingDecision,
  setActiveTenantsCount,
  recordFairnessDeferral,
  setWorkerConcurrencyUtilization,
} from "../metrics/index.js";
import Redis from "ioredis";

export interface SlotAcquireResult {
  granted: boolean;
  activeCount: number;
  isBurst: boolean;
  failOpen?: boolean;
}

const ACQUIRE_SLOT_LUA = `
local tenantKey = KEYS[1]
local tenantsSetKey = KEYS[2]
local totalActiveKey = KEYS[3]

local customerId = ARGV[1]
local jobId = ARGV[2]
local maxPerTenant = tonumber(ARGV[3])
local totalCapacity = tonumber(ARGV[4])
local leaseSeconds = tonumber(ARGV[5])
local channel = ARGV[6]

-- Check if job is already holding a slot
if redis.call('SISMEMBER', tenantKey, jobId) == 1 then
    local activeCount = redis.call('SCARD', tenantKey)
    return {1, activeCount, 0}
end

-- Self-healing: Audit active_tenants set and purge orphaned tenants whose key expired
local rawTenants = redis.call('SMEMBERS', tenantsSetKey)
local activeTenantsCount = 0
local realTotalActive = 0

for _, tId in ipairs(rawTenants) do
    local key = 'rl:fair:active:' .. channel .. ':' .. tId
    local count = redis.call('SCARD', key)
    if count == 0 then
        redis.call('SREM', tenantsSetKey, tId)
    else
        activeTenantsCount = activeTenantsCount + 1
        realTotalActive = realTotalActive + count
    end
end

-- Resynchronize totalActiveKey to prevent counter drift from worker crashes
redis.call('SET', totalActiveKey, realTotalActive)
redis.call('EXPIRE', totalActiveKey, leaseSeconds * 2)

local activeCount = redis.call('SCARD', tenantKey)

-- Condition 1: Within guaranteed per-tenant quota
if activeCount < maxPerTenant then
    redis.call('SADD', tenantKey, jobId)
    redis.call('EXPIRE', tenantKey, leaseSeconds)
    redis.call('SADD', tenantsSetKey, customerId)
    redis.call('EXPIRE', tenantsSetKey, leaseSeconds * 2)
    redis.call('INCR', totalActiveKey)
    redis.call('EXPIRE', totalActiveKey, leaseSeconds * 2)
    return {1, activeCount + 1, 0}
end

-- Condition 2: Work-conserving burst
-- If this tenant is the ONLY active tenant in the system, allow bursting up to totalCapacity
if (activeTenantsCount <= 1) and (realTotalActive < totalCapacity) then
    redis.call('SADD', tenantKey, jobId)
    redis.call('EXPIRE', tenantKey, leaseSeconds)
    redis.call('SADD', tenantsSetKey, customerId)
    redis.call('EXPIRE', tenantsSetKey, leaseSeconds * 2)
    redis.call('INCR', totalActiveKey)
    redis.call('EXPIRE', totalActiveKey, leaseSeconds * 2)
    return {1, activeCount + 1, 1}
end

-- Condition 3: Contention exists and tenant exceeded quota. Deny slot.
return {0, activeCount, 0}
`;

const RELEASE_SLOT_LUA = `
local tenantKey = KEYS[1]
local tenantsSetKey = KEYS[2]
local totalActiveKey = KEYS[3]

local customerId = ARGV[1]
local jobId = ARGV[2]

if redis.call('SREM', tenantKey, jobId) == 1 then
    local rem = redis.call('SCARD', tenantKey)
    if rem == 0 then
        redis.call('DEL', tenantKey)
        redis.call('SREM', tenantsSetKey, customerId)
    end
    local tot = redis.call('DECR', totalActiveKey)
    if tot <= 0 then
        redis.call('DEL', totalActiveKey)
    end
    return rem
end

return 0
`;

export class TenantFairnessService {
  public enabled: boolean;
  public maxPerTenant: number;
  public totalCapacity: number;
  public leaseSeconds: number;
  private timeoutMs: number;

  constructor(
    enabled: boolean = env.FAIRNESS_ENABLED,
    maxPerTenant: number = env.TENANT_MAX_CONCURRENT_JOBS,
    totalCapacity: number = env.WORKER_CONCURRENCY,
    leaseSeconds: number = 60,
    timeoutMs: number = 500
  ) {
    this.enabled = enabled;
    this.maxPerTenant = maxPerTenant;
    this.totalCapacity = totalCapacity;
    this.leaseSeconds = leaseSeconds;
    this.timeoutMs = timeoutMs;
  }

  private getKeys(channel: string, customerId: string) {
    return {
      tenantKey: `rl:fair:active:${channel}:${customerId}`,
      tenantsSetKey: `rl:fair:active_tenants:${channel}`,
      totalActiveKey: `rl:fair:total_active:${channel}`,
    };
  }

  /**
   * Attempts to acquire an active execution slot for a tenant on a specific channel.
   * Enforces fair concurrency and work-conserving burst using atomic Redis Lua.
   */
  async acquireSlot(
    channel: "email" | "sms",
    customerId: string,
    jobId: string
  ): Promise<SlotAcquireResult> {
    if (!this.enabled) {
      return { granted: true, activeCount: 0, isBurst: false };
    }

    if (!env.REDIS_URL) {
      return { granted: true, activeCount: 0, isBurst: false, failOpen: true };
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

      const { tenantKey, tenantsSetKey, totalActiveKey } = this.getKeys(channel, customerId);

      const evalPromise = client.eval(
        ACQUIRE_SLOT_LUA,
        3,
        tenantKey,
        tenantsSetKey,
        totalActiveKey,
        customerId,
        jobId,
        this.maxPerTenant.toString(),
        this.totalCapacity.toString(),
        this.leaseSeconds.toString(),
        channel
      ) as Promise<[number, number, number]>;

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Fairness acquisition timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        )
      );

      const result = await Promise.race([evalPromise, timeoutPromise]);
      const granted = result[0] === 1;
      const activeCount = Number(result[1]);
      const isBurst = result[2] === 1;

      if (granted) {
        recordFairSchedulingDecision(channel, isBurst ? "burst" : "dispatched");
      } else {
        recordFairSchedulingDecision(channel, "deferred");
        recordFairnessDeferral(channel, "concurrency_limit");
      }

      // Update gauges in background
      this.updateGauges(channel, client).catch(() => {});

      return { granted, activeCount, isBurst };
    } catch (err: any) {
      // Fail-open on Redis timeout or error to preserve durable processing
      console.warn(`[TenantFairnessService] Redis unavailable (${err.message}). Failing open.`);
      return { granted: true, activeCount: 0, isBurst: false, failOpen: true };
    }
  }

  /**
   * Releases an execution slot upon job completion or failure.
   */
  async releaseSlot(
    channel: "email" | "sms",
    customerId: string,
    jobId: string
  ): Promise<void> {
    if (!this.enabled || !env.REDIS_URL) {
      return;
    }

    try {
      const client = getRedisClientSync();
      const { tenantKey, tenantsSetKey, totalActiveKey } = this.getKeys(channel, customerId);

      await client.eval(
        RELEASE_SLOT_LUA,
        3,
        tenantKey,
        tenantsSetKey,
        totalActiveKey,
        customerId,
        jobId
      );

      this.updateGauges(channel, client).catch(() => {});
    } catch {
      // Silently ignore release errors (keys auto-expire via TTL)
    }
  }

  /**
   * Returns the count of distinct active tenants on a channel.
   */
  async getActiveTenantsCount(channel: "email" | "sms"): Promise<number> {
    if (!env.REDIS_URL) return 0;
    try {
      const client = getRedisClientSync();
      const key = `rl:fair:active_tenants:${channel}`;
      return await client.scard(key);
    } catch {
      return 0;
    }
  }

  /**
   * Returns the count of currently active jobs for a specific tenant on a channel.
   */
  async getTenantActiveJobs(channel: "email" | "sms", customerId: string): Promise<number> {
    if (!env.REDIS_URL) return 0;
    try {
      const client = getRedisClientSync();
      const key = `rl:fair:active:${channel}:${customerId}`;
      return await client.scard(key);
    } catch {
      return 0;
    }
  }

  /**
   * Resets fairness state for a channel or tenant (primarily for tests).
   */
  async reset(channel: "email" | "sms", customerId?: string): Promise<void> {
    if (!env.REDIS_URL) return;
    try {
      const client = getRedisClientSync();
      if (customerId) {
        const { tenantKey, tenantsSetKey } = this.getKeys(channel, customerId);
        await client.del(tenantKey);
        await client.srem(tenantsSetKey, customerId);
      } else {
        const keys = await client.keys(`rl:fair:*:${channel}*`);
        if (keys.length > 0) {
          await client.del(...keys);
        }
      }
    } catch {
      // Ignore
    }
  }

  private async updateGauges(channel: "email" | "sms", client: Redis): Promise<void> {
    try {
      const tenantsKey = `rl:fair:active_tenants:${channel}`;
      const totalActiveKey = `rl:fair:total_active:${channel}`;

      const [activeTenants, totalActiveStr] = await Promise.all([
        client.scard(tenantsKey),
        client.get(totalActiveKey),
      ]);

      const totalActive = Number(totalActiveStr || "0");
      setActiveTenantsCount(channel, activeTenants);
      setWorkerConcurrencyUtilization(channel, totalActive / this.totalCapacity);
    } catch {
      // Ignore background metric update errors
    }
  }
}

export const tenantFairnessService = new TenantFairnessService();

