import pg from "pg";

export class OutboxRepository {
  async create(client: pg.PoolClient, data: {
    notificationId: string;
    eventType: string;
  }) {
    const result = await client.query(
      `INSERT INTO outbox_events (notification_id, event_type)
       VALUES ($1, $2)
       RETURNING *`,
      [data.notificationId, data.eventType]
    );
    return result.rows[0];
  }
}
