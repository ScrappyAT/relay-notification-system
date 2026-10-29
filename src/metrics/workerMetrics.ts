import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "./registry.js";

export const workerJobsTotal = new Counter({
  name: "relay_worker_jobs_total",
  help: "Total count of jobs processed by workers",
  labelNames: ["channel", "status"],
  registers: [register],
});

export const workerJobDurationSeconds = new Histogram({
  name: "relay_worker_job_duration_seconds",
  help: "Job processing execution duration in seconds",
  labelNames: ["channel"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const workerRetriesTotal = new Counter({
  name: "relay_worker_retries_total",
  help: "Total count of job retry attempts handled by workers",
  labelNames: ["channel"],
  registers: [register],
});

export const workerActiveJobsGauge = new Gauge({
  name: "relay_worker_active_jobs",
  help: "Current number of worker jobs actively being processed",
  labelNames: ["channel"],
  registers: [register],
});

function sanitizeChannel(channel?: string): string {
  if (channel === "email" || channel === "sms") return channel;
  return "unknown";
}

export function recordWorkerJobProcessed(channel: string, durationSeconds: number): void {
  const safeChannel = sanitizeChannel(channel);
  workerJobsTotal.inc({ channel: safeChannel, status: "processed" });
  workerJobDurationSeconds.observe({ channel: safeChannel }, durationSeconds);
}

export function recordWorkerJobFailed(channel: string): void {
  const safeChannel = sanitizeChannel(channel);
  workerJobsTotal.inc({ channel: safeChannel, status: "failed" });
}

export function recordWorkerJobSkipped(channel: string): void {
  const safeChannel = sanitizeChannel(channel);
  workerJobsTotal.inc({ channel: safeChannel, status: "skipped" });
}

export function recordWorkerRetry(channel: string): void {
  workerRetriesTotal.inc({ channel: sanitizeChannel(channel) });
}

export function incrementActiveJobs(channel: string): void {
  workerActiveJobsGauge.inc({ channel: sanitizeChannel(channel) });
}

export function decrementActiveJobs(channel: string): void {
  workerActiveJobsGauge.dec({ channel: sanitizeChannel(channel) });
}

