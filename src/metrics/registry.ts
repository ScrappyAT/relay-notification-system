import { Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();

// Add default process and runtime metrics with prefix
collectDefaultMetrics({
  register,
  prefix: "relay_process_",
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export function resetMetricsForTesting(): void {
  register.resetMetrics();
}

