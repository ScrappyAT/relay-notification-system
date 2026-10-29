import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "./registry.js";

export const outboxAwaitingPublicationGauge = new Gauge({
  name: "relay_dispatcher_outbox_awaiting_publication",
  help: "Current number of outbox events waiting to be published to queues",
  registers: [register],
});

export const dispatcherPublicationsTotal = new Counter({
  name: "relay_dispatcher_publications_total",
  help: "Total count of outbox event queue publication attempts",
  labelNames: ["channel", "status"],
  registers: [register],
});

export const dispatcherPublicationDurationSeconds = new Histogram({
  name: "relay_dispatcher_publication_duration_seconds",
  help: "Time in seconds taken to publish an outbox event to BullMQ",
  labelNames: ["channel"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const dispatcherOutboxRetriesTotal = new Counter({
  name: "relay_dispatcher_outbox_retries_total",
  help: "Total count of outbox events retried due to prior publication failure or lease expiration",
  labelNames: ["channel"],
  registers: [register],
});

function sanitizeChannel(channel?: string): string {
  if (channel === "email" || channel === "sms") return channel;
  return "unknown";
}

export function recordPublicationSuccess(channel: string, durationSeconds: number): void {
  const safeChannel = sanitizeChannel(channel);
  dispatcherPublicationsTotal.inc({ channel: safeChannel, status: "success" });
  dispatcherPublicationDurationSeconds.observe({ channel: safeChannel }, durationSeconds);
}

export function recordPublicationFailure(channel: string): void {
  const safeChannel = sanitizeChannel(channel);
  dispatcherPublicationsTotal.inc({ channel: safeChannel, status: "failure" });
}

export function recordOutboxRetry(channel?: string): void {
  dispatcherOutboxRetriesTotal.inc({ channel: sanitizeChannel(channel) });
}

export function setOutboxAwaitingPublication(count: number): void {
  outboxAwaitingPublicationGauge.set(count);
}

