import Redis from "ioredis";
import { env } from "./env.js";
import {
  redisConnectedGauge,
  redisDisconnectsTotal,
  redisReconnectsTotal,
  redisConnectionErrorsTotal,
  redisConsecutiveFailuresGauge,
} from "../metrics/redisMetrics.js";

let redisClient: Redis | null = null;
let redisConnectionPromise: Promise<Redis> | null = null;

let isConnected = false;
let consecutiveFailures = 0;
let disconnectsCount = 0;
let reconnectsCount = 0;
let lastLoggedErrorTime = 0;
let lastErrorMessage: string | null = null;

export function isRedisConnected(): boolean {
  if (!redisClient) return false;
  return isConnected && redisClient.status === "ready";
}

export function getRedisConnectionStats() {
  return {
    connected: isRedisConnected(),
    consecutiveFailures,
    disconnectsCount,
    reconnectsCount,
    lastErrorMessage,
  };
}

function createRedisClient(): Redis {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times: number) {
      // Bounded exponential backoff with jitter (100ms - 5000ms)
      const baseDelay = Math.min(times * 200, 5000);
      const jitter = Math.floor(Math.random() * (baseDelay * 0.2));
      const delay = baseDelay + (Math.random() > 0.5 ? jitter : -jitter);
      return Math.max(100, delay);
    },
  });

  client.on("error", (err) => {
    consecutiveFailures++;
    lastErrorMessage = err.message;
    redisConnectionErrorsTotal.inc();
    redisConsecutiveFailuresGauge.set(consecutiveFailures);
    redisConnectedGauge.set(0);
    isConnected = false;

    // Log throttling: prevent console log flooding during prolonged outages
    const now = Date.now();
    const shouldLog =
      consecutiveFailures === 1 ||
      consecutiveFailures === 5 ||
      consecutiveFailures % 25 === 0 ||
      now - lastLoggedErrorTime >= 30000;

    if (shouldLog) {
      lastLoggedErrorTime = now;
      console.error(
        `[Redis] Connection error (${consecutiveFailures} consecutive failure${
          consecutiveFailures > 1 ? "s" : ""
        }): ${err.message}`
      );
    }
  });

  client.on("connect", () => {
    const wasDisconnected = consecutiveFailures > 0;
    const failuresBeforeReconnect = consecutiveFailures;

    isConnected = true;
    consecutiveFailures = 0;
    redisConnectedGauge.set(1);
    redisConsecutiveFailuresGauge.set(0);

    if (wasDisconnected) {
      reconnectsCount++;
      redisReconnectsTotal.inc();
      console.log(
        `[Redis] Reconnected successfully after ${failuresBeforeReconnect} consecutive failure(s)`
      );
    } else {
      console.log("[Redis] Connected");
    }
  });

  client.on("ready", () => {
    isConnected = true;
    redisConnectedGauge.set(1);
    redisConsecutiveFailuresGauge.set(0);
  });

  client.on("close", () => {
    if (isConnected) {
      disconnectsCount++;
      redisDisconnectsTotal.inc();
      console.log("[Redis] Connection closed");
    }
    isConnected = false;
    redisConnectedGauge.set(0);
  });

  return client;
}

export async function getRedisClient(): Promise<Redis> {
  if (redisClient && redisClient.status === "ready") {
    return redisClient;
  }

  if (redisConnectionPromise) {
    return redisConnectionPromise;
  }

  redisConnectionPromise = (async () => {
    try {
      if (!redisClient) {
        redisClient = createRedisClient();
      }
      if (redisClient.status === "wait") {
        await redisClient.connect();
      }
      return redisClient;
    } catch (error: any) {
      redisConnectionPromise = null;
      throw error;
    } finally {
      if (redisClient && redisClient.status === "ready") {
        redisConnectionPromise = null;
      }
    }
  })();

  return redisConnectionPromise;
}

export function getRedisClientSync(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    redisConnectionPromise = null;
    isConnected = false;
    redisConnectedGauge.set(0);
  }
}
