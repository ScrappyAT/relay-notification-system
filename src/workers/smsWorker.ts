import { Worker, Job, DelayedError, UnrecoverableError } from "bullmq";
import { getRedisClientSync } from "../config/redis.js";
import { NotificationRepository } from "../repositories/notificationRepository.js";
import { pool } from "../database/pool.js";
import { env } from "../config/env.js";
import { generateClaimToken } from "../utils/uuid.js";
import { tenantFairnessService } from "../services/tenantFairnessService.js";
import {
  simulatedProvider,
  ProviderError,
} from "../adapters/simulatedProvider.js";
import {
  incrementActiveJobs,
  decrementActiveJobs,
  recordWorkerJobProcessed,
  recordWorkerJobFailed,
  recordWorkerJobSkipped,
  recordWorkerRetry,
  recordNotificationProcessing,
  recordNotificationProcessed,
  recordNotificationFailed,
  recordNotificationOutcomeUnknown,
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
              // Could be already processed, being processed by another worker with active lease, or terminal
              const existing = await notificationRepo.findById(notificationId);
              await client.query("ROLLBACK");
              if (!existing) {
                console.error(`Notification ${notificationId} not found`);
                throw new Error("Notification not found");
              }
              if (
                existing.status === "delivered" ||
                existing.status === "provider_accepted" ||
                existing.status === "processed" ||
                existing.status === "failed" ||
                existing.status === "outcome_unknown" ||
                existing.status === "suppressed"
              ) {
                recordWorkerJobSkipped("sms");
                console.log(`Notification ${notificationId} already in terminal status (${existing.status}), skipping`);
                return { status: "skipped", reason: "terminal_status", currentStatus: existing.status };
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
              console.log(`Dispatching SMS notification ${notificationId} via simulated provider (channel: ${notification.channel})`);

              const providerResponse = await simulatedProvider.send({
                notificationId,
                customerId,
                channel: "sms",
                recipient: notification.recipient,
                payload: notification.payload,
                attempt: job.attemptsMade + 1,
              });

              // Successful provider acceptance: transition to 'provider_accepted'
              const updateClient = await pool.connect();
              try {
                await updateClient.query("BEGIN");
                const result = await updateClient.query(
                  `UPDATE notifications
                   SET status = 'provider_accepted',
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
              return {
                status: "provider_accepted",
                notificationId,
                providerMessageId: providerResponse.providerMessageId,
              };
            } catch (processingError: any) {
              const isProviderErr = processingError instanceof ProviderError;
              const isTimeout = isProviderErr && processingError.isTimeout;
              const isPermanent = isProviderErr && !processingError.retryable;
              const maxAttempts = job.opts.attempts || 5;
              const isExhausted = job.attemptsMade + 1 >= maxAttempts;

              if (isTimeout) {
                // Timeout: delivery outcome indeterminate across network boundary.
                // Mark outcome_unknown, clear lease, and abort blind retries.
                const timeoutClient = await pool.connect();
                try {
                  await timeoutClient.query("BEGIN");
                  await timeoutClient.query(
                    `UPDATE notifications
                     SET status = 'outcome_unknown',
                         processing_locked_until = NULL,
                         claim_token = NULL,
                         updated_at = NOW()
                     WHERE id = $1 AND claim_token = $2`,
                    [notificationId, claimToken]
                  );
                  await timeoutClient.query("COMMIT");
                } finally {
                  timeoutClient.release();
                }
                recordNotificationOutcomeUnknown("sms");
                console.error(`SMS notification ${notificationId} timed out; marked outcome_unknown`);
                throw new UnrecoverableError(`Provider timeout on notification ${notificationId}: outcome unknown`);
              }

              if (isPermanent) {
                // Permanent rejection (e.g. HTTP 400 Bad Request, unroutable phone number):
                // Mark failed immediately, clear lease, and abort retries.
                const failClient = await pool.connect();
                try {
                  await failClient.query("BEGIN");
                  await failClient.query(
                    `UPDATE notifications
                     SET status = 'failed',
                         processing_locked_until = NULL,
                         claim_token = NULL,
                         updated_at = NOW()
                     WHERE id = $1 AND claim_token = $2`,
                    [notificationId, claimToken]
                  );
                  await failClient.query("COMMIT");
                } finally {
                  failClient.release();
                }
                recordNotificationFailed("sms");
                console.error(`SMS notification ${notificationId} permanently rejected: ${processingError.message}`);
                throw new UnrecoverableError(`Permanent provider rejection: ${processingError.message}`);
              }

              if (isExhausted) {
                // Transient retries exhausted: mark terminal failed.
                const exhaustClient = await pool.connect();
                try {
                  await exhaustClient.query("BEGIN");
                  await exhaustClient.query(
                    `UPDATE notifications
                     SET status = 'failed',
                         retry_count = retry_count + 1,
                         processing_locked_until = NULL,
                         claim_token = NULL,
                         updated_at = NOW()
                     WHERE id = $1 AND claim_token = $2`,
                    [notificationId, claimToken]
                  );
                  await exhaustClient.query("COMMIT");
                } finally {
                  exhaustClient.release();
                }
                recordNotificationFailed("sms");
                console.error(`SMS notification ${notificationId} exhausted max retry attempts (${maxAttempts})`);
                throw processingError;
              }

              // Transient retryable error (HTTP 503 / 429) with attempts remaining:
              // Release lease lock, increment retry_count, and throw error so BullMQ triggers exponential backoff.
              const retryClient = await pool.connect();
              try {
                await retryClient.query("BEGIN");
                await retryClient.query(
                  `UPDATE notifications
                   SET retry_count = retry_count + 1,
                       processing_locked_until = NULL,
                       claim_token = NULL,
                       updated_at = NOW()
                   WHERE id = $1 AND claim_token = $2`,
                  [notificationId, claimToken]
                );
                await retryClient.query("COMMIT");
              } finally {
                retryClient.release();
              }
              console.warn(
                `Transient provider error for SMS ${notificationId} (attempt ${job.attemptsMade + 1}/${maxAttempts}): ${processingError.message}. Backing off.`
              );
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
