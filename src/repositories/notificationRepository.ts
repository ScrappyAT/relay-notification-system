import pg from "pg";
import { pool } from "../database/pool.js";

export class NotificationRepository {
  async create(client: pg.PoolClient, data: {
    customerId: string;
    recipient: string;
    channel: string;
    payload: any;
    status?: string;
  }) {
    const result = await client.query(
      `INSERT INTO notifications (customer_id, recipient, channel, payload, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.customerId,
        data.recipient,
        data.channel,
        JSON.stringify(data.payload),
        data.status || "pending",
      ]
    );
    return result.rows[0];
  }

  async findById(id: string) {
    const result = await pool.query(
      "SELECT * FROM notifications WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async updateStatus(client: pg.PoolClient, id: string, status: string) {
    const result = await client.query(
      `UPDATE notifications SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  }

  async markQueued(client: pg.PoolClient, id: string) {
    const result = await client.query(
      `UPDATE notifications SET status = 'queued', updated_at = NOW() 
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id]
    );
    return result.rows[0];
  }
}
