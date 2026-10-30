import pg from "pg";
import { pool } from "../database/pool.js";

export interface RecipientPreferenceRecord {
  id: string;
  customer_id: string;
  recipient: string;
  channel: "email" | "sms";
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Pattern: Repository Pattern
 * Purpose: Encapsulates database query mechanics and isolation boundaries for recipient preferences,
 * decoupling persistence SQL queries from business logic in services and route handlers.
 */
export class PreferenceRepository {
  /**
   * Retrieves a specific channel preference for a tenant recipient.
   * Can accept either an active PoolClient (for transaction consistency) or defaults to the connection pool.
   */
  async getPreference(
    clientOrPool: pg.PoolClient | pg.Pool = pool,
    customerId: string,
    recipient: string,
    channel: "email" | "sms"
  ): Promise<RecipientPreferenceRecord | null> {
    const result = await clientOrPool.query(
      `SELECT * FROM recipient_preferences
       WHERE customer_id = $1 AND recipient = $2 AND channel = $3`,
      [customerId, recipient, channel]
    );
    return result.rows[0] || null;
  }

  /**
   * Upserts a recipient preference record.
   * Atomic ON CONFLICT prevents race conditions during concurrent preference updates.
   */
  async upsertPreference(
    clientOrPool: pg.PoolClient | pg.Pool = pool,
    customerId: string,
    recipient: string,
    channel: "email" | "sms",
    enabled: boolean
  ): Promise<RecipientPreferenceRecord> {
    const result = await clientOrPool.query(
      `INSERT INTO recipient_preferences (customer_id, recipient, channel, enabled, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (customer_id, recipient, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING *`,
      [customerId, recipient, channel, enabled]
    );
    return result.rows[0];
  }

  /**
   * Lists all preferences configured for a given recipient under a specific tenant.
   */
  async listPreferences(
    clientOrPool: pg.PoolClient | pg.Pool = pool,
    customerId: string,
    recipient: string
  ): Promise<RecipientPreferenceRecord[]> {
    const result = await clientOrPool.query(
      `SELECT * FROM recipient_preferences
       WHERE customer_id = $1 AND recipient = $2
       ORDER BY channel ASC`,
      [customerId, recipient]
    );
    return result.rows;
  }
}
