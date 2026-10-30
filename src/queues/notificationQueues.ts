import { Queue } from "bullmq";
import { getRedisClientSync } from "../config/redis.js";
import { env } from "../config/env.js";

/**
 * Pattern: Exponential Backoff Pattern
 * Purpose: Defends downstream networks and internal workers from retry stampedes during transient failures.
 * Failed BullMQ delivery jobs back off exponentially (delay * 2^attempt) before retrying, preventing provider overload.
 */
let emailQueueInstance: Queue | null = null;
let smsQueueInstance: Queue | null = null;

export function getEmailQueue(): Queue {
  if (!emailQueueInstance) {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is not configured");
    }
    const connection = getRedisClientSync();
    emailQueueInstance = new Queue("email-notifications", {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    });
  }
  return emailQueueInstance;
}

export function getSmsQueue(): Queue {
  if (!smsQueueInstance) {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is not configured");
    }
    const connection = getRedisClientSync();
    smsQueueInstance = new Queue("sms-notifications", {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    });
  }
  return smsQueueInstance;
}

export const emailQueue = {
  add: async (name: string, data: any, opts?: any) => {
    const queue = getEmailQueue();
    return queue.add(name, data, opts);
  },
};

export const smsQueue = {
  add: async (name: string, data: any, opts?: any) => {
    const queue = getSmsQueue();
    return queue.add(name, data, opts);
  },
};

export async function closeQueues(): Promise<void> {
  const promises = [];
  if (emailQueueInstance) promises.push(emailQueueInstance.close());
  if (smsQueueInstance) promises.push(smsQueueInstance.close());
  await Promise.all(promises);
}
