import { Counter, Histogram } from "prom-client";
import { register } from "./registry.js";
import { apiRateLimitsTotal } from "./apiMetrics.js";

export const rateLimitEvaluationsTotal = new Counter({
  name: "relay_rate_limit_evaluations_total",
  help: "Total count of rate limit evaluations performed per decision outcome",
  labelNames: ["result"], // "allowed" | "rate_limited" | "fail_open"
  registers: [register],
});

export const rateLimitEvaluationDurationSeconds = new Histogram({
  name: "relay_rate_limit_evaluation_duration_seconds",
  help: "Latency in seconds taken to evaluate tenant rate limits against Redis",
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [register],
});

export const rateLimitRedisFailuresTotal = new Counter({
  name: "relay_rate_limit_redis_failures_total",
  help: "Total count of Redis errors or timeouts encountered during rate limit evaluation (triggering fail-open)",
  registers: [register],
});

export function recordRateLimitEvaluation(
  result: "allowed" | "rate_limited" | "fail_open",
  durationSeconds: number
): void {
  rateLimitEvaluationsTotal.inc({ result });
  rateLimitEvaluationDurationSeconds.observe(durationSeconds);

  if (result === "rate_limited") {
    apiRateLimitsTotal.inc();
  }
}

export function recordRateLimitRedisFailure(): void {
  rateLimitRedisFailuresTotal.inc();
}

