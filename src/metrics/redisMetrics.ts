import { Counter, Gauge } from "prom-client";
import { register } from "./registry.js";

export const redisConnectedGauge = new Gauge({
  name: "relay_redis_connected",
  help: "Current Redis connection state (1 for connected, 0 for disconnected)",
  registers: [register],
});

export const redisDisconnectsTotal = new Counter({
  name: "relay_redis_disconnects_total",
  help: "Total count of Redis connection drop events",
  registers: [register],
});

export const redisReconnectsTotal = new Counter({
  name: "relay_redis_reconnects_total",
  help: "Total count of successful Redis reconnections after disconnection",
  registers: [register],
});

export const redisConnectionErrorsTotal = new Counter({
  name: "relay_redis_connection_errors_total",
  help: "Total count of Redis connection error events",
  registers: [register],
});

export const redisConsecutiveFailuresGauge = new Gauge({
  name: "relay_redis_consecutive_failures",
  help: "Current number of consecutive Redis connection failures",
  registers: [register],
});

// Initialize gauge to disconnected until confirmed
redisConnectedGauge.set(0);
redisConsecutiveFailuresGauge.set(0);

