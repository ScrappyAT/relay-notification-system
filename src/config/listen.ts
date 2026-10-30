import type { ListenOptions } from "node:net";
import { env } from "./env.js";

/** Keep the unauthenticated dashboard/demo local without changing backend defaults. */
export function getListenOptions(port: number, service: "api" | "metrics"): ListenOptions {
  const host = env.DEMO_MODE || env.DASHBOARD_ENABLED
    ? "127.0.0.1"
    : service === "api" ? env.API_HOST : env.METRICS_HOST;

  // Omitting host preserves the original Node IPv6/IPv4 unspecified-interface behavior.
  return host === undefined ? { port } : { port, host };
}
