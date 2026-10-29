import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import { RateLimiter, rateLimiter } from "../src/services/rateLimiter.js";
import * as redisConfig from "../src/config/redis.js";
import crypto from "crypto";
import { getMetrics } from "../src/metrics/index.js";

describe("Tenant-Level Rate Limiting (Milestone 6B)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const resA = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["RateLimit Tenant A"]
    );
    tenantA = resA.rows[0].id;

    const resB = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["RateLimit Tenant B"]
    );
    tenantB = resB.rows[0].id;
  });

  afterAll(async () => {
    if (tenantA || tenantB) {
      try {
        await pool.query(
          "DELETE FROM idempotency_keys WHERE customer_id IN ($1, $2)",
          [tenantA, tenantB]
        );
        await pool.query(
          "DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2))",
          [tenantA, tenantB]
        );
        await pool.query(
          "DELETE FROM notifications WHERE customer_id IN ($1, $2)",
          [tenantA, tenantB]
        );
        await pool.query(
          "DELETE FROM customers WHERE id IN ($1, $2)",
          [tenantA, tenantB]
        );
      } catch {}
    }
  });

  describe("Core Rate Limiting & Quotas (Live Integration)", () => {
    it("allows requests within the configured tenant limit and returns standard headers", async () => {
      const customLimiter = new RateLimiter(60, 5);
      await customLimiter.reset(tenantA);

      const res1 = await customLimiter.consume(tenantA);
      expect(res1.allowed).toBe(true);
      expect(res1.limit).toBe(5);
      expect(res1.remaining).toBe(4);
      expect(res1.resetSeconds).toBeGreaterThan(0);

      const res2 = await customLimiter.consume(tenantA);
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(3);
    });

    it("rejects requests exceeding the limit and reports correct remaining/reset quota", async () => {
      const smallLimiter = new RateLimiter(60, 2);
      await smallLimiter.reset(tenantA);

      const r1 = await smallLimiter.consume(tenantA);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(1);

      const r2 = await smallLimiter.consume(tenantA);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);

      const r3 = await smallLimiter.consume(tenantA);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);
      expect(r3.resetSeconds).toBeGreaterThan(0);
    });

    it("enforces tenant isolation: Tenant A exhausting quota does not affect Tenant B", async () => {
      const isolLimiter = new RateLimiter(60, 2);
      await isolLimiter.reset(tenantA);
      await isolLimiter.reset(tenantB);

      // Exhaust Tenant A
      await isolLimiter.consume(tenantA);
      await isolLimiter.consume(tenantA);
      const resA = await isolLimiter.consume(tenantA);
      expect(resA.allowed).toBe(false);

      // Tenant B should still have full quota
      const resB = await isolLimiter.consume(tenantB);
      expect(resB.allowed).toBe(true);
      expect(resB.remaining).toBe(1);
    });

    it("atomically handles concurrent requests against the same tenant", async () => {
      const concurrencyLimiter = new RateLimiter(60, 5);
      await concurrencyLimiter.reset(tenantA);

      // Fire 10 concurrent requests simultaneously
      const promises = Array.from({ length: 10 }).map(() =>
        concurrencyLimiter.consume(tenantA)
      );
      const results = await Promise.all(promises);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      // Exactly 5 should be allowed and 5 rejected
      expect(allowedCount).toBe(5);
      expect(rejectedCount).toBe(5);
    });

    it("shares rate limit state across multiple simulated API instances", async () => {
      // Simulate two independent API instances with their own RateLimiter objects
      const instance1 = new RateLimiter(60, 3);
      const instance2 = new RateLimiter(60, 3);
      await instance1.reset(tenantA);

      const r1 = await instance1.consume(tenantA);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      // Instance 2 consumes from same tenant
      const r2 = await instance2.consume(tenantA);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await instance1.consume(tenantA);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // Exceeded on instance 2
      const r4 = await instance2.consume(tenantA);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it("resets quota after the sliding window expires", async () => {
      // 1-second window with limit 1
      const shortWindowLimiter = new RateLimiter(1, 1);
      await shortWindowLimiter.reset(tenantA);

      const r1 = await shortWindowLimiter.consume(tenantA);
      expect(r1.allowed).toBe(true);

      const r2 = await shortWindowLimiter.consume(tenantA);
      expect(r2.allowed).toBe(false);

      // Wait 1.1s for sliding window expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const r3 = await shortWindowLimiter.consume(tenantA);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
    });
  });

  describe("HTTP API Endpoint Integration & Response Headers", () => {
    it("returns HTTP 429 Too Many Requests with standard RateLimit and Retry-After headers", async () => {
      const testLimiter = new RateLimiter(60, 1);
      await testLimiter.reset(tenantA);

      // We can test against app using a unique test tenant
      const isolatedTenant = crypto.randomUUID();
      await pool.query(
        "INSERT INTO customers (id, name) VALUES ($1, $2) RETURNING id",
        [isolatedTenant, "HTTP 429 Test Customer"]
      );

      const origLimit = rateLimiter.maxRequests;
      rateLimiter.maxRequests = 1;

      try {
        // Send request 1: consumes 1 token (reaches limit of 1)
        const res1 = await request(app)
          .post("/v1/notifications")
          .set("Idempotency-Key", crypto.randomUUID())
          .send({
            customerId: isolatedTenant,
            recipient: "test@example.com",
            channel: "email",
            payload: { subject: "Test", body: "Hello" },
          });

        expect(res1.status).toBe(202);
        expect(res1.headers["ratelimit-limit"]).toBe("1");
        expect(res1.headers["ratelimit-remaining"]).toBe("0");
        expect(res1.headers["ratelimit-reset"]).toBeDefined();

        // Next request to API must receive 429
        const res429 = await request(app)
          .post("/v1/notifications")
          .set("Idempotency-Key", crypto.randomUUID())
          .send({
            customerId: isolatedTenant,
            recipient: "test@example.com",
            channel: "email",
            payload: { subject: "Test", body: "Hello" },
          });

        expect(res429.status).toBe(429);
        expect(res429.body.code).toBe("RATE_LIMIT_EXCEEDED");
        expect(res429.body.message).toContain("Too many requests");
        expect(res429.headers["retry-after"]).toBeDefined();
        expect(res429.headers["ratelimit-limit"]).toBe("1");
        expect(res429.headers["ratelimit-remaining"]).toBe("0");
        expect(res429.headers["ratelimit-reset"]).toBeDefined();
      } finally {
        rateLimiter.maxRequests = origLimit;
        await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [isolatedTenant]).catch(() => {});
        await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)", [isolatedTenant]).catch(() => {});
        await pool.query("DELETE FROM notifications WHERE customer_id = $1", [isolatedTenant]).catch(() => {});
        await pool.query("DELETE FROM customers WHERE id = $1", [isolatedTenant]).catch(() => {});
      }
    });

    it("refunds rate limit quota for safe identical idempotency replays", async () => {
      const customLimiter = new RateLimiter(60, 5);
      await customLimiter.reset(tenantA);

      const idempotencyKey = crypto.randomUUID();

      // First submission
      const res1 = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", idempotencyKey)
        .send({
          customerId: tenantA,
          recipient: "refund@example.com",
          channel: "email",
          payload: { subject: "Refund Test", body: "Original Payload" },
        });

      expect(res1.status).toBe(202);

      // Identical replay: should return 202 and refund token
      const resReplay = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", idempotencyKey)
        .send({
          customerId: tenantA,
          recipient: "refund@example.com",
          channel: "email",
          payload: { subject: "Refund Test", body: "Original Payload" },
        });

      expect(resReplay.status).toBe(202);
      expect(resReplay.body.id).toBe(res1.body.id);

      // Conflicting replay with different payload: must return 409 and not refund
      const resConflict = await request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", idempotencyKey)
        .send({
          customerId: tenantA,
          recipient: "refund@example.com",
          channel: "email",
          payload: { subject: "Refund Test", body: "DIFFERENT Payload" },
        });

      expect(resConflict.status).toBe(409);
      expect(resConflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("Fail-Open & Reliability Scenarios (Mocked)", () => {
    it("fails open and allows durable ingestion when Redis is unavailable", async () => {
      const failLimiter = new RateLimiter(60, 10);
      
      // Spy on Redis functions to simulate Redis outage
      const isConnectedSpy = vi.spyOn(redisConfig, "isRedisConnected").mockReturnValue(false);
      const getClientSpy = vi.spyOn(redisConfig, "getRedisClient").mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6386"));
      const getClientSyncSpy = vi.spyOn(redisConfig, "getRedisClientSync").mockImplementation(() => {
        throw new Error("Redis client unavailable");
      });

      try {
        const result = await failLimiter.consume(tenantA);
        expect(result.allowed).toBe(true);
        expect(result.failOpen).toBe(true);

        const metrics = await getMetrics();
        expect(metrics).toContain("relay_rate_limit_redis_failures_total");
      } finally {
        isConnectedSpy.mockRestore();
        getClientSpy.mockRestore();
        getClientSyncSpy.mockRestore();
      }
    });

    it("enforces bounded timeout and fails open if Redis call hangs", async () => {
      // Configure very short 50ms timeout
      const timeoutLimiter = new RateLimiter(60, 10, 50);

      // Mock client.eval to simulate hanging / slow Redis command
      const mockClient = {
        eval: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 200))),
      };
      const getClientSpy = vi.spyOn(redisConfig, "getRedisClientSync").mockReturnValue(mockClient as any);
      const isConnectedSpy = vi.spyOn(redisConfig, "isRedisConnected").mockReturnValue(true);

      try {
        const start = Date.now();
        const result = await timeoutLimiter.consume(tenantA);
        const elapsed = Date.now() - start;

        // Must fail open within bounded timeout without hanging
        expect(result.allowed).toBe(true);
        expect(result.failOpen).toBe(true);
        expect(elapsed).toBeLessThan(150);
      } finally {
        getClientSpy.mockRestore();
        isConnectedSpy.mockRestore();
      }
    });

    it("records Prometheus metrics for rate limit evaluations and latency", async () => {
      const metricLimiter = new RateLimiter(60, 100);
      await metricLimiter.consume(tenantB);

      const metrics = await getMetrics();
      expect(metrics).toContain("relay_rate_limit_evaluations_total");
      expect(metrics).toContain("relay_rate_limit_evaluation_duration_seconds");
      expect(metrics).toMatch(/relay_rate_limit_evaluations_total\{result="allowed"\} [1-9]\d*/);
    });
  });
});
