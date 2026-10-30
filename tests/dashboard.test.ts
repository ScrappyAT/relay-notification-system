import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { pool } from "../src/database/pool.js";

const original = env.DASHBOARD_ENABLED;
afterEach(() => { env.DASHBOARD_ENABLED = original; vi.restoreAllMocks(); });

describe("Local dashboard API boundary", () => {
  it("keeps admin reads disabled unless explicitly enabled", async () => {
    env.DASHBOARD_ENABLED = false;
    const spy = vi.spyOn(pool, "query");
    const response = await request(app).get("/v1/dashboard/customers");
    expect(response.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["Host", "evil.example"], ["Origin", "https://evil.example"], ["Sec-Fetch-Site", "cross-site"],
  ])("rejects untrusted %s before querying the database", async (header, value) => {
    env.DASHBOARD_ENABLED = true;
    const spy = vi.spyOn(pool, "query");
    const response = await request(app).get("/v1/dashboard/customers").set(header, value);
    expect(response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("also blocks cross-origin writes to existing unauthenticated routes in demo mode", async () => {
    env.DASHBOARD_ENABLED = true;
    const spy = vi.spyOn(pool, "query");
    const response = await request(app).put("/v1/recipients/preferences").set("Origin", "https://evil.example").send({});
    expect(response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    "/overview?customerId=invalid", "/overview?days=1000", "/overview?days=1.5",
    "/notifications?status=anything", "/notifications?limit=1000", "/notifications?page=-1",
    "/notifications?channel=push", "/preferences", "/preferences?customerId=invalid",
  ])("validates and bounds %s before querying", async (path) => {
    env.DASHBOARD_ENABLED = true;
    const spy = vi.spyOn(pool, "query");
    const response = await request(app).get(`/v1/dashboard${path}`);
    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns actionable errors without leaking database credentials", async () => {
    env.DASHBOARD_ENABLED = true;
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("postgresql://user:secret@private-host/db"));
    const response = await request(app).get("/v1/dashboard/customers");
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|private-host/);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
