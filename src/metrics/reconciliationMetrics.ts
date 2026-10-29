import { Counter } from "prom-client";
import { register } from "./registry.js";

export const reconciliationExpiredLeasesTotal = new Counter({
  name: "relay_reconciliation_expired_leases_total",
  help: "Total count of stuck notifications with expired processing leases detected",
  labelNames: ["channel"],
  registers: [register],
});

export const reconciliationRecoveredTotal = new Counter({
  name: "relay_reconciliation_recovered_total",
  help: "Total count of stuck notifications successfully recovered or reconciled",
  labelNames: ["channel"],
  registers: [register],
});

export const reconciliationFailuresTotal = new Counter({
  name: "relay_reconciliation_failures_total",
  help: "Total count of reconciliation recovery errors",
  labelNames: ["channel"],
  registers: [register],
});

function sanitizeChannel(channel?: string): string {
  if (channel === "email" || channel === "sms") return channel;
  return "unknown";
}

export function recordExpiredLease(channel?: string): void {
  reconciliationExpiredLeasesTotal.inc({ channel: sanitizeChannel(channel) });
}

export function recordReconciliationRecovered(channel?: string): void {
  reconciliationRecoveredTotal.inc({ channel: sanitizeChannel(channel) });
}

export function recordReconciliationFailure(channel?: string): void {
  reconciliationFailuresTotal.inc({ channel: sanitizeChannel(channel) });
}

