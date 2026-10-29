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

let emailWorkerInstance: Worker | null = null;
const notificationRepo = new NotificationRepository();

interface EmailJobData {
  notificationId: string;
  customerId: string;
  channel: string;
  createdAt: Date;
}

export function getEmailWorker(): Worker {
  if (!emailWorkerInstance && env.REDIS_URL) {
    const connection = getRedisClientSync();
    emailWorkerInstance = new Worker<EmailJobData>(
      "email-notifications",
      async (job: Job<EmailJobData>, token?: string) => {
        const { notificationId, customerId, createdAt } = job.data;
        const jobId = job.id || notificationId;

        // 1. Tenant Fairness Concurrency Check
        const slot = await tenantFairnessService.acquireSlot("email", customerId, jobId);
        if (!slot.granted) {
          // Defer job: move to delayed queue so other tenants' jobs can be processed
          await job.moveToDelayed(Date.now() + 500, token);
          throw new DelayedError();
        }

        try {
          incrementActiveJobs("email");
          const jobStart = process.hrtime.bigint();
          if (job.attemptsMade > 0) {
            recordWorkerRetry("email");
          }

          if (createdAt) {
            const delaySec = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 1000);
            recordTenantSchedulingDelay("email", delaySec);
          }

          const claimToken = generateClaimToken();
          const leaseDurationSeconds = 60;
          const lockedUntil = new Date(Date.now() + leaseDurationSeconds * 1000);
          
          console.log(`Processing email job ${job.id} for notification ${notificationId}`);
          
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
          
          if (!notificationId) {
            await client.query("ROLLBACK");
            throw new Error("Missing notificationId");
          }
          
          // Atomically claim notification for processing
          // Allow reclaiming if processing lease expired (worker crash recovery)
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
            // Could be already processed, being processed by another worker with active lease, or not found
            const existing = await notificationRepo.findById(notificationId);
            await client.query("ROLLBACK");
            if (!existing) {
              console.error(`Notification ${notificationId} not found`);
              throw new Error("Notification not found");
            }
            if (existing.status === "delivered" || existing.status === "provider_accepted") {
              recordWorkerJobSkipped("email");
              console.log(`Notification ${notificationId} already processed (status: ${existing.status}), skipping`);
              return { status: "skipped", reason: "already_processed", currentStatus: existing.status };
            }
            if (existing.status === "processing" && existing.processing_locked_until && existing.processing_locked_until > new Date()) {
              recordWorkerJobSkipped("email");
              console.log(`Notification ${notificationId} already being processed by another worker with active lease, skipping`);
              return { status: "skipped", reason: "concurrent_processing" };
            }
            if (existing.status === "processing") {
              console.log(`Notification ${notificationId} in processing state with expired lease, will retry`);
              // Don't throw - let BullMQ retry
              throw new Error("Processing lease expired, retrying");
            }
            recordWorkerJobSkipped("email");
            console.log(`Notification ${notificationId} in status ${existing.status}, skipping`);
            return { status: "skipped", reason: "ineligible_status", currentStatus: existing.status };
          }
          
          const notification = claimResult.rows[0];
          await client.query("COMMIT");
          recordNotificationProcessing("email");

          try {
            // Simulate processing without exposing sensitive recipient/payload
            console.log(`Simulating email delivery for notification ${notificationId} (channel: ${notification.channel})`);
            
            // Transition to processed (simulated internal processing complete)
            // Never mark as delivered - that requires external provider confirmation
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
            recordWorkerJobProcessed("email", duration);
            recordNotificationProcessed("email");
            return { status: "processed", notificationId };
          } catch (processingError: any) {
            // On failure, release the lease so it can be retried
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
          recordWorkerJobFailed("email");
          console.error(`Email job ${job.id} failed:`, error.message);
          throw error;
        } finally {
          await tenantFairnessService.releaseSlot("email", customerId, jobId);
          decrementActiveJobs("email");
        }
      },
      {
        connection,
        concurrency: env.WORKER_CONCURRENCY,
      }
    );

    emailWorkerInstance.on("completed", (job) => {
      console.log(`Email job ${job.id} completed`);
    });

    emailWorkerInstance.on("failed", (job, err) => {
      console.error(`Email job ${job?.id} failed with error:`, err.message);
    });
  }
  if (!emailWorkerInstance) {
    throw new Error("REDIS_URL is not configured");
  }
  return emailWorkerInstance;
}

export async function closeEmailWorker(): Promise<void> {
  if (emailWorkerInstance) {
    await emailWorkerInstance.close();
    emailWorkerInstance = null;
  }
}
