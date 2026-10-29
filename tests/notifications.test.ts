import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/database/pool.js";
import crypto from "crypto";

describe("Relay Notifications API", () => {
  let testCustomerId: string;

  beforeAll(async () => {
    // Create a test customer
    const result = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING id",
      ["Test Customer"]
    );
    testCustomerId = result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    try {
      await pool.query("DELETE FROM idempotency_keys WHERE customer_id = $1", [testCustomerId]);
      await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id = $1)", [testCustomerId]);
      await pool.query("DELETE FROM notifications WHERE customer_id = $1", [testCustomerId]);
      await pool.query("DELETE FROM customers WHERE id = $1", [testCustomerId]);
    } catch (e) {
      // Ignore cleanup errors
    }
    await pool.end();
  });

  it("successfully submits an email notification", async () => {
    const idempotencyKey = crypto.randomUUID();
    const response = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "test@example.com",
        channel: "email",
        payload: {
          subject: "Test Subject",
          body: "Hello World",
        },
      });

    expect(response.status).toBe(202);
    expect(response.body.id).toBeDefined();
    expect(response.body.customerId).toBe(testCustomerId);
    expect(response.body.recipient).toBe("test@example.com");
    expect(response.body.channel).toBe("email");
    expect(response.body.status).toBe("pending");
  });

  it("successfully submits an SMS notification", async () => {
    const idempotencyKey = crypto.randomUUID();
    const response = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "+1234567890",
        channel: "sms",
        payload: {
          body: "Hello SMS",
        },
      });

    expect(response.status).toBe(202);
    expect(response.body.id).toBeDefined();
    expect(response.body.channel).toBe("sms");
  });

  it("rejects invalid request", async () => {
    const idempotencyKey = crypto.randomUUID();
    const response = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "invalid-email",
        channel: "email",
        payload: {
          subject: "Test",
          body: "Hello",
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.errors).toBeDefined();
  });

  it("rejects missing idempotency key", async () => {
    const response = await request(app)
      .post("/v1/notifications")
      .send({
        customerId: testCustomerId,
        recipient: "test@example.com",
        channel: "email",
        payload: {
          subject: "Test",
          body: "Hello",
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("returns existing notification for repeated identical requests", async () => {
    const idempotencyKey = crypto.randomUUID();
    const requestBody = {
      customerId: testCustomerId,
      recipient: "repeat@example.com",
      channel: "email" as const,
      payload: {
        subject: "Repeat Test",
        body: "Same message",
      },
    };

    const firstResponse = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send(requestBody);

    expect(firstResponse.status).toBe(202);
    const firstId = firstResponse.body.id;

    const secondResponse = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send(requestBody);

    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body.id).toBe(firstId); // Same notification returned
  });

  it("returns 409 conflict for same idempotency key with different payload", async () => {
    const idempotencyKey = crypto.randomUUID();
    
    const firstResponse = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "conflict@example.com",
        channel: "email",
        payload: {
          subject: "First",
          body: "First message",
        },
      });

    expect(firstResponse.status).toBe(202);

    const secondResponse = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: testCustomerId,
        recipient: "conflict@example.com",
        channel: "email",
        payload: {
          subject: "Second",
          body: "Different message",
        },
      });

    expect(secondResponse.status).toBe(409);
    expect(secondResponse.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("handles concurrent duplicate requests safely", async () => {
    const idempotencyKey = crypto.randomUUID();
    const requestBody = {
      customerId: testCustomerId,
      recipient: "concurrent@example.com",
      channel: "email" as const,
      payload: {
        subject: "Concurrent",
        body: "Test concurrent",
      },
    };

    // Send multiple concurrent requests with same idempotency key
    const promises = Array(3).fill(null).map(() =>
      request(app)
        .post("/v1/notifications")
        .set("Idempotency-Key", idempotencyKey)
        .send(requestBody)
    );

    const responses = await Promise.all(promises);
    
    // All should return 202 (either created or replayed)
    responses.forEach((response) => {
      expect(response.status).toBe(202);
    });
    
    // All should return the same notification ID
    const ids = responses.map((r) => r.body.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("rolls back transaction on failure", async () => {
    // Try to create notification with non-existent customer to trigger rollback
    const idempotencyKey = crypto.randomUUID();
    const fakeCustomerId = crypto.randomUUID();
    
    const response = await request(app)
      .post("/v1/notifications")
      .set("Idempotency-Key", idempotencyKey)
      .send({
        customerId: fakeCustomerId,
        recipient: "rollback@example.com",
        channel: "email",
        payload: {
          subject: "Rollback",
          body: "Test rollback",
        },
      });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("CUSTOMER_NOT_FOUND");
  });
});
