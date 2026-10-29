import pg from "pg";
import { pool } from "../database/pool.js";
import { generateClaimToken } from "../utils/uuid.js";
import { env } from "../config/env.js";

export class OutboxDispatcherRepository {
  async claimUnpublishedEvents(
    client: pg.PoolClient,
    limit: number = 10,
    leaseDurationSeconds: number = 60
  ): Promise<any[]> {
    const claimToken = generateClaimToken();
    const lockedUntil = new Date(Date.now() + leaseDurationSeconds * 1000);
    
    // Interleaved Round-Robin across active tenants when fairness is enabled:
    // Ensures high-volume tenants cannot starve low-volume tenants in outbox claiming.
    const query = env.FAIRNESS_ENABLED
      ? `UPDATE outbox_events 
         SET claimed_at = NOW(), 
             locked_until = $2,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events 
           WHERE id IN (
             SELECT sub.id FROM (
               SELECT oe.id,
                      ROW_NUMBER() OVER (
                        PARTITION BY n.customer_id 
                        ORDER BY oe.created_at ASC
                      ) as tenant_turn,
                      oe.created_at
               FROM outbox_events oe
               JOIN notifications n ON oe.notification_id = n.id
               WHERE oe.published_at IS NULL 
                 AND oe.failed_at IS NULL
                 AND (oe.locked_until IS NULL OR oe.locked_until < NOW())
              ) sub
             ORDER BY sub.tenant_turn ASC, sub.created_at ASC
             LIMIT $1
           )
           FOR UPDATE SKIP LOCKED
         ) 
         RETURNING *, $3 as claim_token`
      : `UPDATE outbox_events 
         SET claimed_at = NOW(), 
             locked_until = $2,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events 
           WHERE published_at IS NULL 
             AND (locked_until IS NULL OR locked_until < NOW())
           ORDER BY created_at ASC 
           FOR UPDATE SKIP LOCKED 
           LIMIT $1
         ) 
         RETURNING *, $3 as claim_token`;

    const result = await client.query(query, [limit, lockedUntil, claimToken]);
    return result.rows;
  }

  async claimUnpublishedEventsReadOnly(
    client: pg.PoolClient,
    limit: number = 10,
    leaseDurationSeconds: number = 60
  ): Promise<any[]> {
    const claimToken = generateClaimToken();
    const lockedUntil = new Date(Date.now() + leaseDurationSeconds * 1000);
    
    // Interleaved Round-Robin across active tenants when fairness is enabled
    const query = env.FAIRNESS_ENABLED
      ? `UPDATE outbox_events 
         SET claimed_at = COALESCE(claimed_at, NOW()), 
             locked_until = $2,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events 
           WHERE id IN (
             SELECT sub.id FROM (
               SELECT oe.id,
                      ROW_NUMBER() OVER (
                        PARTITION BY n.customer_id 
                        ORDER BY oe.created_at ASC
                      ) as tenant_turn,
                      oe.created_at
               FROM outbox_events oe
               JOIN notifications n ON oe.notification_id = n.id
               WHERE oe.published_at IS NULL 
                 AND oe.failed_at IS NULL
                 AND (oe.locked_until IS NULL OR oe.locked_until < NOW())
              ) sub
             ORDER BY sub.tenant_turn ASC, sub.created_at ASC
             LIMIT $1
           )
           FOR UPDATE SKIP LOCKED
         ) 
         RETURNING id, notification_id, event_type, created_at, attempts, claimed_at, locked_until, $3 as claim_token`
      : `UPDATE outbox_events 
         SET claimed_at = COALESCE(claimed_at, NOW()), 
             locked_until = $2,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events 
           WHERE published_at IS NULL 
             AND (locked_until IS NULL OR locked_until < NOW())
           ORDER BY created_at ASC 
           FOR UPDATE SKIP LOCKED 
           LIMIT $1
         ) 
         RETURNING id, notification_id, event_type, created_at, attempts, claimed_at, locked_until, $3 as claim_token`;

    const result = await client.query(query, [limit, lockedUntil, claimToken]);
    return result.rows;
  }

  async markAsPublished(client: pg.PoolClient, eventId: string, claimToken?: string): Promise<boolean> {
    // Only mark as published if we still own the claim (no newer lease)
    // published_at must ONLY be set on successful queue publication
    const result = await client.query(
      `UPDATE outbox_events 
       SET published_at = NOW(),
           locked_until = NULL,
           failed_at = NULL,
           failure_reason = NULL
       WHERE id = $1 
         AND published_at IS NULL
         AND failed_at IS NULL
         AND (locked_until IS NULL OR locked_until >= NOW())
       RETURNING id`,
      [eventId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async markAsFailed(client: pg.PoolClient, eventId: string, reason: string): Promise<void> {
    // Mark as terminally failed - do NOT set published_at
    await client.query(
      `UPDATE outbox_events 
       SET failed_at = NOW(),
           failure_reason = $2,
           locked_until = NULL,
           last_error = $2
       WHERE id = $1 AND published_at IS NULL AND failed_at IS NULL`,
      [eventId, reason]
    );
  }

  async releaseClaim(client: pg.PoolClient, eventId: string): Promise<void> {
    // Release claim on failure to make it eligible for retry
    await client.query(
      `UPDATE outbox_events 
       SET locked_until = NULL 
       WHERE id = $1 AND published_at IS NULL AND failed_at IS NULL`,
      [eventId]
    );
  }

  async extendLease(client: pg.PoolClient, eventId: string, leaseDurationSeconds: number = 60): Promise<boolean> {
    const lockedUntil = new Date(Date.now() + leaseDurationSeconds * 1000);
    const result = await client.query(
      `UPDATE outbox_events 
       SET locked_until = $2
       WHERE id = $1 AND published_at IS NULL AND locked_until >= NOW()
       RETURNING id`,
      [eventId, lockedUntil]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async countUnpublished(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM outbox_events WHERE published_at IS NULL`
    );
    return parseInt(result.rows[0].count);
  }

  async countEligibleForRetry(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM outbox_events 
       WHERE published_at IS NULL 
         AND (locked_until IS NULL OR locked_until < NOW())`
    );
    return parseInt(result.rows[0].count);
  }
}
