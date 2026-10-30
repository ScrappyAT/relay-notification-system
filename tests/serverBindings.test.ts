import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { env, parseEnv } from "../src/config/env.js";
import { getListenOptions } from "../src/config/listen.js";
import { startApiServer } from "../src/apiServer.js";
import { startProcessMetricsServer } from "../src/metrics/server.js";

const original = {
  NODE_ENV: env.NODE_ENV, DEMO_MODE: env.DEMO_MODE, DASHBOARD_ENABLED: env.DASHBOARD_ENABLED,
  API_HOST: env.API_HOST, METRICS_HOST: env.METRICS_HOST,
};
afterEach(() => Object.assign(env, original));
const base = { DATABASE_URL: "postgresql://localhost/binding-tests" };

describe("Binding environment configuration", () => {
  it.each(["development", "test", "production"])("preserves non-demo defaults in %s", NODE_ENV => {
    const parsed = parseEnv({ ...base, NODE_ENV });
    expect(parsed.DEMO_MODE).toBe(false);
    expect(parsed.DASHBOARD_ENABLED).toBe(false);
    expect(parsed.API_HOST).toBeUndefined();
    expect(parsed.METRICS_HOST).toBeUndefined();
  });

  it("keeps explicit false flags false and accepts independent deployment hosts", () => {
    const parsed = parseEnv({ ...base, DEMO_MODE: "false", DASHBOARD_ENABLED: "false", API_HOST: "10.0.0.10", METRICS_HOST: "10.0.0.20" });
    Object.assign(env, { DEMO_MODE: parsed.DEMO_MODE, DASHBOARD_ENABLED: parsed.DASHBOARD_ENABLED, API_HOST: parsed.API_HOST, METRICS_HOST: parsed.METRICS_HOST });
    expect(getListenOptions(3000, "api")).toEqual({ port: 3000, host: "10.0.0.10" });
    expect(getListenOptions(3001, "metrics")).toEqual({ port: 3001, host: "10.0.0.20" });
  });

  it.each(["API_HOST", "METRICS_HOST"])("rejects an empty %s rather than silently broadening access", field => {
    expect(() => parseEnv({ ...base, [field]: " " })).toThrow();
  });

  it("does not inherit the API host for a separately configured metrics listener", () => {
    Object.assign(env, { DEMO_MODE: false, DASHBOARD_ENABLED: false, API_HOST: "127.0.0.1", METRICS_HOST: undefined });
    expect(getListenOptions(3001, "metrics")).toEqual({ port: 3001 });
  });

  it.each(["DEMO_MODE", "DASHBOARD_ENABLED"])("parses %s=true and prevents wildcard overrides", field => {
    const parsed = parseEnv({ ...base, [field]: "true", API_HOST: "0.0.0.0", METRICS_HOST: "::" });
    Object.assign(env, { DEMO_MODE: parsed.DEMO_MODE, DASHBOARD_ENABLED: parsed.DASHBOARD_ENABLED, API_HOST: parsed.API_HOST, METRICS_HOST: parsed.METRICS_HOST });
    expect(getListenOptions(3000, "api")).toEqual({ port: 3000, host: "127.0.0.1" });
    expect(getListenOptions(3001, "metrics")).toEqual({ port: 3001, host: "127.0.0.1" });
  });
});

function address(server: Server) {
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Expected a TCP listener");
  return bound;
}

describe("Real API and metrics TCP bindings", () => {
  const cases = [
    { name: "original production defaults", dashboard: false, demo: false, api: undefined, metrics: undefined, expectedApi: "unspecified", expectedMetrics: "unspecified" },
    { name: "public API and private metrics", dashboard: false, demo: false, api: "0.0.0.0", metrics: "127.0.0.1", expectedApi: "0.0.0.0", expectedMetrics: "127.0.0.1" },
    { name: "private API and independently reachable metrics", dashboard: false, demo: false, api: "127.0.0.1", metrics: "0.0.0.0", expectedApi: "127.0.0.1", expectedMetrics: "0.0.0.0" },
    { name: "dashboard enabled despite inherited wildcard hosts", dashboard: true, demo: false, api: "0.0.0.0", metrics: "0.0.0.0", expectedApi: "127.0.0.1", expectedMetrics: "127.0.0.1" },
    { name: "isolated demo with dashboard reads disabled", dashboard: false, demo: true, api: "0.0.0.0", metrics: "0.0.0.0", expectedApi: "127.0.0.1", expectedMetrics: "127.0.0.1" },
    { name: "demo and dashboard despite inherited IPv6 wildcard hosts", dashboard: true, demo: true, api: "::", metrics: "::", expectedApi: "127.0.0.1", expectedMetrics: "127.0.0.1" },
  ];

  it.each(cases)("uses $name", async config => {
    Object.assign(env, { NODE_ENV: "production", DEMO_MODE: config.demo, DASHBOARD_ENABLED: config.dashboard, API_HOST: config.api, METRICS_HOST: config.metrics });
    const api = startApiServer(0);
    let metrics: Awaited<ReturnType<typeof startProcessMetricsServer>> | undefined;
    try {
      await once(api, "listening");
      metrics = await startProcessMetricsServer(0, "binding-test");
      for (const [server, expected] of [[api, config.expectedApi], [metrics.server, config.expectedMetrics]] as const) {
        const bound = address(server);
        if (expected === "unspecified") expect(["::", "0.0.0.0"]).toContain(bound.address);
        else expect(bound.address).toBe(expected);
        const response = await request(`http://127.0.0.1:${bound.port}`).get(server === api ? "/v1/health" : "/health");
        expect(response.status).toBe(200);
      }
      const guarded = await request(`http://127.0.0.1:${address(api).port}`).get("/v1/dashboard/customers").set("Host", "untrusted.example");
      expect(guarded.status).toBe(config.dashboard ? 403 : 404);
    } finally {
      if (api.listening) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
      if (metrics) await metrics.close();
    }
  });
});
