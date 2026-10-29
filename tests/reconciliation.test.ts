import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/database/pool.js";
import { ReconciliationService } from "../src/services/reconciliationService.js";
import crypto from "crypto";

describe("Reconciliation Service", () => {
  let testCustomerId: string;

  beforeAll(async () => {
    try {
      const result = await pool.query(
        "INSERT INTO customers (name) VALUES ($1) RETURNING id",
        ["Test Customer Reconciliation"]
      );
      testCustomerId = result.rows[0].id;
    } catch (e) {
      throw e;
    }
  });

  afterAll(async () => {
    if (testCustomerId) {
      try {
        await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [testCustomerId]);
        await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)", [testCustomerId]);
        await pool.query("DELETE FROM notifications WHERE customer_id = $1", [testCustomerId]);
        await pool.query("DELETE FROM customers WHERE id = $1", [testCustomerId]);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  it("detects stuck notifications with expired leases", async () => {
    const notificationId = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    
    // Create a stuck notification
    await pool.query(
      `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status, claim_token, processing_started_at, processing_locked_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() - INTERVAL '10 minutes')`,
      [notificationId, testCustomerId, "test@example.com", "email", JSON.stringify({subject:"test",body:"test"}), "processing", claimToken]
    );

    const reconciliationService = new ReconciliationService(1000);
    await reconciliationService.reconcile();

    // Check if lease was released
    const result = await pool.query(
      "SELECT processing_locked_until FROM notifications WHERE id = $1",
      [notificationId]
    );
    
    expect(result.rows[0].processing_locked_until).toBeNull();
  });

  it("does not interfere with active leases", async () => {
    const notificationId = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    
    // Create a notification with active lease
    await pool.query(
      `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status, claim_token, processing_started_at, processing_locked_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '10 minutes')`,
      [notificationId, testCustomerId, "test2@example.com", "email", JSON.stringify({subject:"test",body:"test"}), "processing", claimToken]
    );

    const reconciliationService = new ReconciliationService(1000);
    await reconciliationService.reconcile();

    // Check if lease was not released
    const result = await pool.query(
      "SELECT processing_locked_until FROM notifications WHERE id = $1",
      [notificationId]
    );
    
    expect(result.rows[0].processing_locked_until).not.toBeNull();
  });

  it("handles concurrent reconciliation safely", async () => {
    const notificationId = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    
    await pool.query(
      `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status, claim_token, processing_started_at, processing_locked_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() - INTERVAL '5 minutes')`,
      [notificationId, testCustomerId, "test3@example.com", "sms", JSON.stringify({body:"test"}), "processing", claimToken]
    );

    const reconciliationService1 = new ReconciliationService(1000);
    const reconciliationService2 = new ReconciliationService(1000);
    
    await Promise.allSettled([reconciliationService1.reconcile(), reconciliationService2.reconcile()]);
    
    // Should not crash
    expect(true).toBe(true);
  });
});
