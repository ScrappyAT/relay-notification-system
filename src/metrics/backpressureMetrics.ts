import client from "prom-client";
import { register } from "./registry.js";

export type BackpressureState = "NORMAL" | "DEGRADED" | "OVERLOADED";

export const backpressureStateGauge = new client.Gauge({
  name: "relay_backpressure_state",
  help: "Indicator of whether the given backpressure state is active (1) or inactive (0)",
  labelNames: ["state"] as const,
  registers: [register],
});

export const backpressureCurrentStateGauge = new client.Gauge({
  name: "relay_backpressure_current_state",
  help: "Current backpressure state encoded as integer (0=NORMAL, 1=DEGRADED, 2=OVERLOADED)",
  registers: [register],
});

export const outboxBacklogGauge = new client.Gauge({
  name: "relay_outbox_backlog_total",
  help: "Current number of unpublished events in the PostgreSQL transactional outbox",
  registers: [register],
});

export const queueBacklogGauge = new client.Gauge({
  name: "relay_queue_backlog_total",
  help: "Current number of waiting and delayed jobs in BullMQ queues",
  labelNames: ["channel"] as const,
  registers: [register],
});

export const backpressureRejectionsTotal = new client.Counter({
  name: "relay_backpressure_rejections_total",
  help: "Total count of notification requests rejected at ingress due to backpressure / overload",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const admissionCheckDurationSeconds = new client.Histogram({
  name: "relay_admission_check_duration_seconds",
  help: "Duration of the backpressure admission control check in seconds",
  buckets: [0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});

export const dependencyCheckFailuresTotal = new client.Counter({
  name: "relay_dependency_check_failures_total",
  help: "Total count of dependency health check failures encountered during backpressure evaluations",
  labelNames: ["dependency"] as const,
  registers: [register],
});

export const backpressureStateSecondsTotal = new client.Counter({
  name: "relay_backpressure_state_seconds_total",
  help: "Cumulative seconds the system has spent in each backpressure state",
  labelNames: ["state"] as const,
  registers: [register],
});

// Helper functions for updating metrics
export function setBackpressureStateMetric(state: BackpressureState): void {
  backpressureStateGauge.labels({ state: "NORMAL" }).set(state === "NORMAL" ? 1 : 0);
  backpressureStateGauge.labels({ state: "DEGRADED" }).set(state === "DEGRADED" ? 1 : 0);
  backpressureStateGauge.labels({ state: "OVERLOADED" }).set(state === "OVERLOADED" ? 1 : 0);

  const numericState = state === "NORMAL" ? 0 : state === "DEGRADED" ? 1 : 2;
  backpressureCurrentStateGauge.set(numericState);
}

export function setOutboxBacklogMetric(count: number): void {
  outboxBacklogGauge.set(count);
}

export function setQueueBacklogMetric(channel: "email" | "sms" | "all", count: number): void {
  queueBacklogGauge.labels({ channel }).set(count);
}

export function recordBackpressureRejection(reason: "outbox_backlog" | "queue_depth" | "db_health" | "system_overloaded"): void {
  backpressureRejectionsTotal.labels({ reason }).inc();
}

export function recordAdmissionCheckDuration(seconds: number): void {
  admissionCheckDurationSeconds.observe(seconds);
}

export function recordDependencyCheckFailure(dependency: "postgres" | "redis"): void {
  dependencyCheckFailuresTotal.labels({ dependency }).inc();
}

export function recordBackpressureStateDuration(state: BackpressureState, durationSeconds: number): void {
  if (durationSeconds > 0) {
    backpressureStateSecondsTotal.labels({ state }).inc(durationSeconds);
  }
}

