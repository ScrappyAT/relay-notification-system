import { Counter } from "prom-client";
import { register } from "./registry.js";

export const notificationsStatusTotal = new Counter({
  name: "relay_notifications_status_total",
  help: "Total count of notification lifecycle status transitions",
  labelNames: ["status", "channel"],
  registers: [register],
});

function sanitizeChannel(channel?: string): string {
  if (channel === "email" || channel === "sms") return channel;
  return "unknown";
}

export function recordNotificationAccepted(channel?: string): void {
  notificationsStatusTotal.inc({ status: "accepted", channel: sanitizeChannel(channel) });
}

export function recordNotificationQueued(channel?: string): void {
  notificationsStatusTotal.inc({ status: "queued", channel: sanitizeChannel(channel) });
}

export function recordNotificationProcessing(channel?: string): void {
  notificationsStatusTotal.inc({ status: "processing", channel: sanitizeChannel(channel) });
}

export function recordNotificationProcessed(channel?: string): void {
  notificationsStatusTotal.inc({ status: "processed", channel: sanitizeChannel(channel) });
}

export function recordNotificationFailed(channel?: string): void {
  notificationsStatusTotal.inc({ status: "failed", channel: sanitizeChannel(channel) });
}

export function recordNotificationOutcomeUnknown(channel?: string): void {
  notificationsStatusTotal.inc({ status: "outcome_unknown", channel: sanitizeChannel(channel) });
}

