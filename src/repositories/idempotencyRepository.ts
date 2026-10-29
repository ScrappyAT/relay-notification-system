import pg from "pg";
import { pool } from "../database/pool.js";

export class IdempotencyRepository {
  async findReadOnly(customerId: string, idempotencyKey: string) {
    const result = await pool.query(
      `SELECT * FROM idempotency_keys 
       WHERE customer_id = $1 AND idempotency_key = $2`,
      [customerId, idempotencyKey]
    );
    return result.rows[0] || null;
  }

  async findByKey(client: pg.PoolClient, customerId: string, idempotencyKey: string) {
    const result = await client.query(
      `SELECT * FROM idempotency_keys 
       WHERE customer_id = $1 AND idempotency_key = $2`,
      [customerId, idempotencyKey]
    );
    return result.rows[0] || null;
  }

  async create(client: pg.PoolClient, data: {
    customerId: string;
    idempotencyKey: string;
    requestHash: string;
    notificationId: string;
  }) {
    const result = await client.query(
      `INSERT INTO idempotency_keys (customer_id, idempotency_key, request_hash, notification_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.customerId, data.idempotencyKey, data.requestHash, data.notificationId]
    );
    return result.rows[0];
  }
}
