import { pool } from "../database/pool.js";
import { env } from "../config/env.js";
import { OutboxDispatcherRepository } from "../repositories/outboxDispatcherRepository.js";
import { NotificationRepository } from "../repositories/notificationRepository.js";
import { getEmailQueue, getSmsQueue } from "../queues/notificationQueues.js";
import {
  recordPublicationSuccess,
  recordPublicationFailure,
  recordOutboxRetry,
  setOutboxAwaitingPublication,
  recordNotificationQueued,
} from "../metrics/index.js";

/**
 * Pattern: Transactional Outbox Pattern (Dispatch & Publication Phase)
 * Purpose: Decouples the HTTP ingestion transaction from external message brokers (Redis/BullMQ).
 * OutboxDispatcher continuously polls unpublished outbox events using row-level locking (SKIP LOCKED),
 * guarantees at-least-once enqueueing with deterministic BullMQ job IDs, and updates publication status.
 */
export class OutboxDispatcher {
  private dispatcherRepo: OutboxDispatcherRepository;
  private notificationRepo: NotificationRepository;
  private isRunning: boolean = false;
  private isDispatching: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = 1000;
  private leaseDurationSeconds: number = 60;
  private maxAttempts: number = 10;
  private batchSize: number = env.DISPATCHER_BATCH_SIZE;

  constructor(
    pollIntervalMs: number = 1000,
    leaseDurationSeconds: number = 60,
    batchSize: number = env.DISPATCHER_BATCH_SIZE
  ) {
    this.dispatcherRepo = new OutboxDispatcherRepository();
    this.notificationRepo = new NotificationRepository();
    this.pollIntervalMs = pollIntervalMs;
    this.leaseDurationSeconds = leaseDurationSeconds;
    this.batchSize = batchSize;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    console.log("Outbox dispatcher started");
    
    this.intervalId = setInterval(() => {
      if (this.isDispatching) return;
      this.isDispatching = true;
      this.dispatch()
        .catch((err) => {
          console.error("Error in dispatcher:", err.message);
        })
        .finally(() => {
          this.isDispatching = false;
        });
    }, this.pollIntervalMs);
    
    this.isDispatching = true;
    this.dispatch()
      .catch((err) => {
        console.error("Error in initial dispatcher run:", err.message);
      })
      .finally(() => {
        this.isDispatching = false;
      });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Await any in-flight dispatch tick before resolving stop
    while (this.isDispatching) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    
    console.log("Outbox dispatcher stopped");
  }

  async dispatch(): Promise<void> {
    // Queue Protection: Pause outbox claiming if downstream BullMQ queue depth exceeds threshold
    if (env.REDIS_URL) {
      try {
        const emailQ = getEmailQueue();
        const smsQ = getSmsQueue();
        const [emailCounts, smsCounts] = await Promise.all([
          emailQ.getJobCounts("waiting", "delayed"),
          smsQ.getJobCounts("waiting", "delayed"),
        ]);
        const totalBacklog =
          (emailCounts.waiting || 0) + (emailCounts.delayed || 0) +
          (smsCounts.waiting || 0) + (smsCounts.delayed || 0);
        if (totalBacklog >= env.DISPATCHER_MAX_QUEUE_BACKLOG) {
          console.warn(
            `[OutboxDispatcher] Queue backlog (${totalBacklog}) exceeds threshold (${env.DISPATCHER_MAX_QUEUE_BACKLOG}). Pausing publication until queues drain.`
          );
          return;
        }
      } catch {
        // If Redis check fails or times out, proceed to normal outbox claiming
      }
    }

    const client = await pool.connect();
    let clientReleased = false;
    try {
      await client.query("BEGIN");
      
      const events = await this.dispatcherRepo.claimUnpublishedEventsReadOnly(
        client,
        this.batchSize,
        this.leaseDurationSeconds
      );
      
      if (events.length === 0) {
        await client.query("COMMIT");
        clientReleased = true;
        client.release();
        setOutboxAwaitingPublication(0);
        return;
      }
      
      await client.query("COMMIT");
      clientReleased = true;
      client.release();

      try {
        const remaining = await this.dispatcherRepo.countUnpublished();
        setOutboxAwaitingPublication(remaining);
      } catch {}
      
      for (const event of events) {
        try {
          // Check if we still have ownership of this claim
          if (event.attempts > this.maxAttempts) {
            console.error(`Outbox event ${event.id} exceeded max attempts (${event.attempts}), marking as failed (NOT published)`);
            const failClient = await pool.connect();
            try {
              await failClient.query("BEGIN");
              await this.dispatcherRepo.markAsFailed(
                failClient,
                event.id,
                `Exceeded maximum retry attempts (${event.attempts})`
              );
              await failClient.query("COMMIT");
            } finally {
              failClient.release();
            }
            continue;
          }
          
          const notification = await this.notificationRepo.findById(event.notification_id);
          if (!notification) {
            console.error(`Notification ${event.notification_id} not found for outbox event ${event.id}`);
            const failClient = await pool.connect();
            try {
              await failClient.query("BEGIN");
              await this.dispatcherRepo.markAsFailed(
                failClient,
                event.id,
                `Notification ${event.notification_id} not found`
              );
              await failClient.query("COMMIT");
            } finally {
              failClient.release();
            }
            continue;
          }
          
          if (event.attempts > 1) {
            recordOutboxRetry(notification.channel);
          }

          const jobId = `notif-${notification.id}`;
          const jobData = {
            notificationId: notification.id,
            customerId: notification.customer_id,
            channel: notification.channel,
            createdAt: notification.created_at,
          };
          
          const pubStart = process.hrtime.bigint();
          try {
            if (notification.channel === "email") {
              const emailQueue = getEmailQueue();
              await emailQueue.add("send-email", jobData, { jobId });
            } else if (notification.channel === "sms") {
              const smsQueue = getSmsQueue();
              await smsQueue.add("send-sms", jobData, { jobId });
            }
            const pubDuration = Number(process.hrtime.bigint() - pubStart) / 1e9;
            recordPublicationSuccess(notification.channel, pubDuration);
            recordNotificationQueued(notification.channel);
            // Transition to queued after successful publication - only if still in pending
            // Never overwrite processing/processed states
            try {
              const queueClient = await pool.connect();
              try {
                await queueClient.query("BEGIN");
                await queueClient.query(
                  `UPDATE notifications SET status = 'queued', updated_at = NOW() 
                   WHERE id = $1 AND status = 'pending'`,
                  [notification.id]
                );
                await queueClient.query("COMMIT");
              } finally {
                queueClient.release();
              }
            } catch (e) {
              // Ignore if already queued or other issues
            }
          } catch (queueError: any) {
            recordPublicationFailure(notification.channel);
            console.error(`Redis queue error for event ${event.id}:`, queueError.message);
            // Release claim so it can be retried when Redis is available
            const releaseClient = await pool.connect();
            try {
              await releaseClient.query("BEGIN");
              await this.dispatcherRepo.releaseClaim(releaseClient, event.id);
              await releaseClient.query("COMMIT");
            } finally {
              releaseClient.release();
            }
            continue;
          }
          
          // Mark as published only after successful queue publication
          // Check ownership to prevent stale dispatcher from marking
          const markClient = await pool.connect();
          try {
            await markClient.query("BEGIN");
            const marked = await this.dispatcherRepo.markAsPublished(markClient, event.id);
            await markClient.query("COMMIT");
            if (!marked) {
              console.warn(`Lost ownership of outbox event ${event.id}, another dispatcher may have claimed it`);
            } else {
              console.log(`Published outbox event ${event.id} for notification ${notification.id} to ${notification.channel} queue`);
            }
          } finally {
            markClient.release();
          }
        } catch (error: any) {
          console.error(`Failed to publish outbox event ${event.id}:`, error.message);
          // Release claim on error for retry
          try {
            const releaseClient = await pool.connect();
            try {
              await releaseClient.query("BEGIN");
              await this.dispatcherRepo.releaseClaim(releaseClient, event.id);
              await releaseClient.query("COMMIT");
            } finally {
              releaseClient.release();
            }
          } catch (releaseError: any) {
            console.error(`Failed to release claim for event ${event.id}:`, releaseError.message);
          }
        }
      }
    } catch (error: any) {
      if (!clientReleased) {
        try {
          await client.query("ROLLBACK");
        } catch (e) {
          // Ignore rollback errors
        }
      }
      console.error("Dispatcher transaction error:", error.message);
      throw error;
    } finally {
      if (!clientReleased) {
        try {
          client.release();
        } catch (e) {
          // Ignore release errors
        }
      }
    }
  }
}
