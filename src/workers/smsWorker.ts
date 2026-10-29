import { Worker, Job, DelayedError } from "bullmq";
import { getRedisClientSync } from "../config/redis.js";
import { NotificationRepository } from "../repositories/notificationRepository.js";
import { pool } from "../database/pool.js";
import { env } from "../config/env.js";
import { generateClaimToken } from "../utils/uuid.js";
import { tenantFairnessService } from "../services/tenantFairnessService.js";
import {
  incrementActiveJobs,
  decrementActiveJobs,
  recordWorkerJobProcessed,
  recordWorkerJobFailed,
  recordWorkerJobSkipped,
  recordWorkerRetry,
  recordNotificationProcessing,
  recordNotificationProcessed,
  recordTenantSchedulingDelay,
} from "../metrics/index.js";

let smsWorkerInstance: Worker | null = null;
const notificationRepo = new NotificationRepository();

interface SmsJobData {
  notificationId: string;
  customerId: string;
  channel: string;
  createdAt: Date;
}

export function getSmsWorker(): Worker {
  if (!smsWorkerInstance && env.REDIS_URL) {
    const connection = getRedisClientSync();
    smsWorkerInstance = new Worker<SmsJobData>(
      "sms-notifications",
      async (job: Job<SmsJobData>, token?: string) => {
        const { notificationId, customerId, createdAt } = job.data;
        const jobId = job.id || notificationId;

        // 1. Tenant Fairness Concurrency Check
        const slot = await tenantFairnessService.acquireSlot("sms", customerId, jobId);
        if (!slot.granted) {
          // Defer job: move to delayed queue so other tenants' jobs can be processed
          await job.moveToDelayed(Date.now() + 500, token);
          throw new DelayedError();
        }

        try {
          incrementActiveJobs("sms");
          const jobStart = process.hrtime.bigint();
          if (job.attemptsMade > 0) {
            recordWorkerRetry("sms");
          }

          if (createdAt) {
            const delaySec = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 1000);
            recordTenantSchedulingDelay("sms", delaySec);
          }

          const claimToken = generateClaimToken();
          const leaseDurationSeconds = 60;
          const lockedUntil = new Date(Date.now() + leaseDurationSeconds * 1000);
          
          console.log(`Processing SMS job ${job.id} for notification ${notificationId}`);
          
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
          
          if (!notificationId) {
            await client.query("ROLLBACK");
            throw new Error("Missing notificationId");
          }
          
          const claimResult = await client.query(
            `UPDATE notifications 
             SET status = 'processing',
                 processing_started_at = COALESCE(processing_started_at, NOW()),
                 processing_locked_until = $2,
                 claim_token = $3,
                 updated_at = NOW()
             WHERE id = $1 
               AND (
                 status IN ('pending', 'queued') OR
                 (status = 'processing' AND (processing_locked_until IS NULL OR processing_locked_until < NOW()))
               )
               AND (processing_locked_until IS NULL OR processing_locked_until < NOW() OR claim_token IS NULL)
             RETURNING *`,
            [notificationId, lockedUntil, claimToken]
          );
          
          if (claimResult.rowCount === 0) {
            const existing = await notificationRepo.findById(notificationId);
            await client.query("ROLLBACK");
            if (!existing) {
              console.error(`Notification ${notificationId} not found`);
              throw new Error("Notification not found");
            }
            if (existing.status === "delivered" || existing.status === "provider_accepted") {
              recordWorkerJobSkipped("sms");
              console.log(`Notification ${notificationId} already processed (status: ${existing.status}), skipping`);
              return { status: "skipped", reason: "already_processed", currentStatus: existing.status };
            }
            if (existing.status === "processing" && existing.processing_locked_until && existing.processing_locked_until > new Date()) {
              recordWorkerJobSkipped("sms");
              console.log(`Notification ${notificationId} already being processed by another worker with active lease, skipping`);
              return { status: "skipped", reason: "concurrent_processing" };
            }
            if (existing.status === "processing") {
              console.log(`Notification ${notificationId} in processing state with expired lease, will retry`);
              throw new Error("Processing lease expired, retrying");
            }
            recordWorkerJobSkipped("sms");
            console.log(`Notification ${notificationId} in status ${existing.status}, skipping`);
            return { status: "skipped", reason: "ineligible_status", currentStatus: existing.status };
          }
          
          const notification = claimResult.rows[0];
          await client.query("COMMIT");
          recordNotificationProcessing("sms");
          
          try {
            console.log(`Simulating SMS delivery for notification ${notificationId} (channel: ${notification.channel})`);
            // Transition to processed (simulated internal processing complete)
            const updateClient = await pool.connect();
            try {
              await updateClient.query("BEGIN");
              const result = await updateClient.query(
                `UPDATE notifications 
                 SET status = 'processed',
                     processing_locked_until = NULL,
                     claim_token = NULL,
                     updated_at = NOW()
                 WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
                [notificationId, claimToken]
              );
              await updateClient.query("COMMIT");
              if (result.rowCount === 0) {
                console.warn(`Lost ownership of notification ${notificationId} during completion`);
                return { status: "skipped", reason: "lost_ownership" };
              }
            } finally {
              updateClient.release();
            }
            const duration = Number(process.hrtime.bigint() - jobStart) / 1e9;
            recordWorkerJobProcessed("sms", duration);
            recordNotificationProcessed("sms");
            return { status: "processed", notificationId };
          } catch (processingError: any) {
            const releaseClient = await pool.connect();
            try {
              await releaseClient.query("BEGIN");
              await releaseClient.query(
                `UPDATE notifications 
                 SET processing_locked_until = NULL,
                     updated_at = NOW()
                 WHERE id = $1 AND claim_token = $2`,
                [notificationId, claimToken]
              );
              await releaseClient.query("COMMIT");
            } finally {
              releaseClient.release();
            }
            throw processingError;
          }
          } finally {
            client.release();
          }
        } catch (error: any) {
          recordWorkerJobFailed("sms");
          console.error(`SMS job ${job.id} failed:`, error.message);
          throw error;
        } finally {
          await tenantFairnessService.releaseSlot("sms", customerId, jobId);
          decrementActiveJobs("sms");
        }
      },
      {
        connection,
        concurrency: env.WORKER_CONCURRENCY,
      }
    );

    smsWorkerInstance.on("completed", (job) => {
      console.log(`SMS job ${job.id} completed`);
    });

    smsWorkerInstance.on("failed", (job, err) => {
      console.error(`SMS job ${job?.id} failed with error:`, err.message);
    });
  }
  if (!smsWorkerInstance) {
    throw new Error("REDIS_URL is not configured");
  }
  return smsWorkerInstance;
}

export async function closeSmsWorker(): Promise<void> {
  if (smsWorkerInstance) {
    await smsWorkerInstance.close();
    smsWorkerInstance = null;
  }
}
