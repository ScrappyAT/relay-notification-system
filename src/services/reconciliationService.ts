import { pool } from "../database/pool.js";
import { Queue } from "bullmq";
import { getRedisClientSync } from "../config/redis.js";
import { env } from "../config/env.js";
import {
  recordExpiredLease,
  recordReconciliationRecovered,
  recordReconciliationFailure,
} from "../metrics/index.js";

export class ReconciliationService {
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = 30000;
  private emailQueue: Queue | null = null;
  private smsQueue: Queue | null = null;

  constructor(pollIntervalMs: number = 30000) {
    this.pollIntervalMs = pollIntervalMs;
    if (env.REDIS_URL) {
      try {
        const connection = getRedisClientSync();
        this.emailQueue = new Queue("email-notifications", { connection });
        this.smsQueue = new Queue("sms-notifications", { connection });
      } catch (e) {
        // Ignore if Redis not available
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    console.log("Reconciliation service started");
    
    this.intervalId = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error("Error in reconciliation:", err.message);
      });
    }, this.pollIntervalMs);
    
    this.reconcile().catch((err) => {
      console.error("Error in initial reconciliation run:", err.message);
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
    
    console.log("Reconciliation service stopped");
  }

  async reconcile(): Promise<void> {
    const client = await pool.connect();
    try {
      // Find notifications stuck in processing with expired leases
      const stuckResult = await client.query(
        `SELECT id, customer_id, channel, status, processing_started_at, processing_locked_until, claim_token
         FROM notifications 
         WHERE status = 'processing' 
           AND (processing_locked_until IS NULL OR processing_locked_until < NOW())
         ORDER BY processing_started_at ASC
         LIMIT 20`
      );

      for (const notification of stuckResult.rows) {
        recordExpiredLease(notification.channel);
        console.log(`Found stuck notification ${notification.id} in processing (channel: ${notification.channel})`);
        
        try {
          // Check job state if queues available
          if (this.emailQueue && notification.channel === "email") {
            const job = await this.emailQueue.getJob(`notif-${notification.id}`);
            if (job) {
              const state = await job.getState();
              if (state === "completed") {
                console.log(`Job for notification ${notification.id} already completed, marking as processed`);
                await client.query("BEGIN");
                await client.query(
                  `UPDATE notifications 
                   SET status = 'processed', processing_locked_until = NULL, claim_token = NULL, updated_at = NOW()
                   WHERE id = $1 AND status = 'processing'`,
                  [notification.id]
                );
                await client.query("COMMIT");
                recordReconciliationRecovered(notification.channel);
                continue;
              } else if (state === "active" || state === "waiting" || state === "delayed") {
                console.log(`Job for notification ${notification.id} still ${state}, skipping reconciliation`);
                continue;
              }
            }
          } else if (this.smsQueue && notification.channel === "sms") {
            const job = await this.smsQueue.getJob(`notif-${notification.id}`);
            if (job) {
              const state = await job.getState();
              if (state === "completed") {
                console.log(`Job for notification ${notification.id} already completed, marking as processed`);
                await client.query("BEGIN");
                await client.query(
                  `UPDATE notifications 
                   SET status = 'processed', processing_locked_until = NULL, claim_token = NULL, updated_at = NOW()
                   WHERE id = $1 AND status = 'processing'`,
                  [notification.id]
                );
                await client.query("COMMIT");
                recordReconciliationRecovered(notification.channel);
                continue;
              } else if (state === "active" || state === "waiting" || state === "delayed") {
                console.log(`Job for notification ${notification.id} still ${state}, skipping reconciliation`);
                continue;
              }
            }
          }
          
          // Release lease for retry (simulated processing safe to retry)
          await client.query("BEGIN");
          const recoverResult = await client.query(
            `UPDATE notifications 
             SET processing_locked_until = NULL,
                 updated_at = NOW()
             WHERE id = $1 
               AND status = 'processing'
               AND (processing_locked_until IS NULL OR processing_locked_until < NOW())
             RETURNING id`,
            [notification.id]
          );
          await client.query("COMMIT");
          
          if (recoverResult.rowCount && recoverResult.rowCount > 0) {
            recordReconciliationRecovered(notification.channel);
            console.log(`Released expired lease for stuck notification ${notification.id}, will retry`);
          }
        } catch (e: any) {
          recordReconciliationFailure(notification.channel);
          try {
            await client.query("ROLLBACK");
          } catch {}
          console.error(`Failed to reconcile notification ${notification.id}:`, e.message);
        }
      }
    } catch (error: any) {
      console.error("Reconciliation error:", error.message);
    } finally {
      client.release();
    }
  }
}
