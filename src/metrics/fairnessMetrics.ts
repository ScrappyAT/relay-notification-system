import client from "prom-client";
import { register } from "./registry.js";

export const fairSchedulingDecisionsTotal = new client.Counter({
  name: "relay_fair_scheduling_decisions_total",
  help: "Total count of fair scheduling decisions made across channels",
  labelNames: ["channel", "decision"] as const,
  registers: [register],
});

export const activeTenantsGauge = new client.Gauge({
  name: "relay_active_tenants",
  help: "Current number of active distinct tenants competing for processing capacity",
  labelNames: ["channel"] as const,
  registers: [register],
});

export const tenantSchedulingDelaySeconds = new client.Histogram({
  name: "relay_tenant_scheduling_delay_seconds",
  help: "Latency in seconds from notification creation until processing acquisition",
  labelNames: ["channel"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const fairnessDeferralsTotal = new client.Counter({
  name: "relay_fairness_deferrals_total",
  help: "Total count of job deferrals triggered by per-tenant fairness concurrency limits",
  labelNames: ["channel", "reason"] as const,
  registers: [register],
});

export const workerConcurrencyUtilization = new client.Gauge({
  name: "relay_worker_concurrency_utilization",
  help: "Ratio of active worker slots currently occupied (0.0 to 1.0)",
  labelNames: ["channel"] as const,
  registers: [register],
});

export function recordFairSchedulingDecision(
  channel: "email" | "sms",
  decision: "dispatched" | "deferred" | "burst"
): void {
  fairSchedulingDecisionsTotal.labels({ channel, decision }).inc();
}

export function setActiveTenantsCount(
  channel: "email" | "sms",
  count: number
): void {
  activeTenantsGauge.labels({ channel }).set(count);
}

export function recordTenantSchedulingDelay(
  channel: "email" | "sms",
  delaySeconds: number
): void {
  tenantSchedulingDelaySeconds.labels({ channel }).observe(delaySeconds);
}

export function recordFairnessDeferral(
  channel: "email" | "sms",
  reason: "concurrency_limit" | "rate_limit" = "concurrency_limit"
): void {
  fairnessDeferralsTotal.labels({ channel, reason }).inc();
}

export function setWorkerConcurrencyUtilization(
  channel: "email" | "sms",
  ratio: number
): void {
  workerConcurrencyUtilization.labels({ channel }).set(Math.min(1.0, Math.max(0.0, ratio)));
}
