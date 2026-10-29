import { Counter, Histogram } from "prom-client";
import { register } from "./registry.js";
import { Request, Response, NextFunction } from "express";

export const apiRequestsTotal = new Counter({
  name: "relay_api_requests_total",
  help: "Total count of HTTP requests handled by the Relay API",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const apiRequestDurationSeconds = new Histogram({
  name: "relay_api_request_duration_seconds",
  help: "HTTP request latency in seconds for the Relay API",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const apiValidationFailuresTotal = new Counter({
  name: "relay_api_validation_failures_total",
  help: "Total count of request validation failures (HTTP 400)",
  registers: [register],
});

export const apiIdempotencyConflictsTotal = new Counter({
  name: "relay_api_idempotency_conflicts_total",
  help: "Total count of idempotency payload conflict errors (HTTP 409)",
  registers: [register],
});

export const apiRateLimitsTotal = new Counter({
  name: "relay_api_rate_limits_total",
  help: "Total count of rate-limited requests (HTTP 429)",
  registers: [register],
});

/**
 * Normalizes request paths to bounded low-cardinality route labels.
 * Strips dynamic path segments like UUIDs to prevent metric cardinality explosion.
 */
export function normalizeRoute(path: string): string {
  if (!path) return "unknown";
  
  // Strip trailing slashes and query strings
  const cleanPath = path.split("?")[0].replace(/\/+$/, "") || "/";

  if (cleanPath === "/v1/health") return "/v1/health";
  if (cleanPath === "/v1/ready") return "/v1/ready";
  if (cleanPath === "/metrics") return "/metrics";
  if (cleanPath === "/v1/notifications") return "/v1/notifications";
  
  // Match /v1/notifications/:id
  if (/^\/v1\/notifications\/[0-9a-fA-F-]+$/.test(cleanPath)) {
    return "/v1/notifications/:id";
  }

  // Match /v1/campaigns or sub-routes if added
  if (cleanPath === "/v1/campaigns") return "/v1/campaigns";
  if (/^\/v1\/campaigns\/[0-9a-fA-F-]+$/.test(cleanPath)) {
    return "/v1/campaigns/:id";
  }

  return "unknown";
}

/**
 * Express middleware to collect HTTP metrics on request finish.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    try {
      const end = process.hrtime.bigint();
      const durationSeconds = Number(end - start) / 1e9;
      
      const method = req.method ? req.method.toUpperCase() : "UNKNOWN";
      const route = normalizeRoute(req.originalUrl || req.url || req.path);
      const statusCode = res.statusCode ? res.statusCode.toString() : "500";

      apiRequestsTotal.inc({ method, route, status_code: statusCode });
      apiRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSeconds);

      // Track domain-level error responses
      if (res.statusCode === 429) {
        apiRateLimitsTotal.inc();
      }
    } catch {
      // Do not let metric recording interrupt response cycle
    }
  });

  next();
}

export function recordValidationFailure(): void {
  apiValidationFailuresTotal.inc();
}

export function recordIdempotencyConflict(): void {
  apiIdempotencyConflictsTotal.inc();
}

