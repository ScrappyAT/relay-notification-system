import { Gauge } from "prom-client";
import { register } from "./registry.js";
import { getEmailQueue, getSmsQueue } from "../queues/notificationQueues.js";
import { isRedisConnected } from "../config/redis.js";

export const queueJobsWaiting = new Gauge({
  name: "relay_queue_jobs_waiting",
  help: "Number of jobs waiting in BullMQ queue",
  labelNames: ["channel"],
  registers: [register],
});

export const queueJobsActive = new Gauge({
  name: "relay_queue_jobs_active",
  help: "Number of jobs actively being worked on in BullMQ queue",
  labelNames: ["channel"],
  registers: [register],
});

export const queueJobsDelayed = new Gauge({
  name: "relay_queue_jobs_delayed",
  help: "Number of jobs delayed in BullMQ queue",
  labelNames: ["channel"],
  registers: [register],
});

export const queueJobsFailed = new Gauge({
  name: "relay_queue_jobs_failed",
  help: "Number of failed jobs retained in BullMQ queue",
  labelNames: ["channel"],
  registers: [register],
});

export const queueJobsCompleted = new Gauge({
  name: "relay_queue_jobs_completed",
  help: "Number of completed jobs retained in BullMQ queue",
  labelNames: ["channel"],
  registers: [register],
});

/**
 * Polls BullMQ queue counts and updates gauges.
 * Safely skips if Redis is currently disconnected to avoid blocking.
 */
export async function updateQueueMetrics(): Promise<void> {
  if (!isRedisConnected()) {
    return;
  }

  try {
    const emailQueue = getEmailQueue();
    const smsQueue = getSmsQueue();

    const [emailCounts, smsCounts] = await Promise.all([
      emailQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
      smsQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
    ]);

    queueJobsWaiting.set({ channel: "email" }, emailCounts.waiting || 0);
    queueJobsActive.set({ channel: "email" }, emailCounts.active || 0);
    queueJobsDelayed.set({ channel: "email" }, emailCounts.delayed || 0);
    queueJobsFailed.set({ channel: "email" }, emailCounts.failed || 0);
    queueJobsCompleted.set({ channel: "email" }, emailCounts.completed || 0);

    queueJobsWaiting.set({ channel: "sms" }, smsCounts.waiting || 0);
    queueJobsActive.set({ channel: "sms" }, smsCounts.active || 0);
    queueJobsDelayed.set({ channel: "sms" }, smsCounts.delayed || 0);
    queueJobsFailed.set({ channel: "sms" }, smsCounts.failed || 0);
    queueJobsCompleted.set({ channel: "sms" }, smsCounts.completed || 0);
  } catch {
    // Gracefully handle queue count query errors during network hiccups
  }
}

