import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import * as redisConfig from "../src/config/redis.js";

describe("Readiness API (Live Integration)", () => {
  it("returns 200 OK and ready status when PostgreSQL is healthy", async () => {
    const response = await request(app).get("/v1/ready");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
    expect(response.body.service).toBe("relay");
    expect(response.body.dependencies).toBeDefined();
    expect(response.body.dependencies.database).toBe("healthy");
    expect(response.body.durableAcceptance).toBe(true);
    expect(response.body.timestamp).toBeDefined();
  });
});

describe("Readiness API (Mocked Failure Scenarios)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 Not Ready when PostgreSQL is unavailable", async () => {
    // Mock database failure
    vi.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("connection to database refused: timeout")
    );

    const response = await request(app).get("/v1/ready");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("not_ready");
    expect(response.body.dependencies.database).toBe("unhealthy");
    expect(response.body.durableAcceptance).toBe(false);
    expect(response.body.error).toContain("PostgreSQL");
  });

  it("returns 200 OK Ready when Redis is unavailable but PostgreSQL is healthy", async () => {
    // Mock Redis as disconnected while PostgreSQL remains healthy
    vi.spyOn(redisConfig, "isRedisConnected").mockReturnValue(false);

    const response = await request(app).get("/v1/ready");

    // The API accepts notifications into PostgreSQL before queue publication,
    // so Redis availability MUST NOT make the API unready!
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
    expect(response.body.dependencies.database).toBe("healthy");
    expect(response.body.dependencies.redis).toBe("unavailable");
    expect(response.body.durableAcceptance).toBe(true);
    expect(response.body.note).toContain("durable ingestion");
  });
});

