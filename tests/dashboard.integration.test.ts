import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { pool } from "../src/database/pool.js";

describe("Dashboard real PostgreSQL reads", () => {
  let customerId: string;
  let otherId: string;
  const enabled = env.DASHBOARD_ENABLED;
  beforeAll(async () => {
    env.DASHBOARD_ENABLED = true;
    customerId = (await pool.query("INSERT INTO customers(name) VALUES ('Dashboard integration A') RETURNING id")).rows[0].id;
    otherId = (await pool.query("INSERT INTO customers(name) VALUES ('Dashboard integration B') RETURNING id")).rows[0].id;
    for (const [tenant, recipient, channel, status] of [
      [customerId, "dashboard-alpha@example.com", "email", "provider_accepted"],
      [customerId, "+15550000000", "sms", "failed"],
      [otherId, "dashboard-other@example.com", "email", "pending"],
    ]) await pool.query("INSERT INTO notifications(customer_id,recipient,channel,status,payload) VALUES ($1,$2,$3,$4,'{}')", [tenant,recipient,channel,status]);
    await pool.query("INSERT INTO recipient_preferences(customer_id,recipient,channel,enabled) VALUES ($1,'dashboard-alpha@example.com','email',false)", [customerId]);
  });
  afterAll(async () => {
    env.DASHBOARD_ENABLED = enabled;
    const ids = [customerId, otherId].filter(Boolean);
    await pool.query("DELETE FROM recipient_preferences WHERE customer_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM notifications WHERE customer_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [ids]);
  });
  it("computes scoped totals and zero-filled daily activity from stored data", async () => {
    const response = await request(app).get(`/v1/dashboard/overview?customerId=${customerId}&days=7`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total:2, accepted:1, delivered:0, failed:1, email:1, sms:1 });
    expect(response.body.activity).toHaveLength(7);
    expect(response.body.activity.reduce((sum: number, d: {email:number;sms:number}) => sum + d.email + d.sms, 0)).toBe(2);
  });
  it("filters, paginates, scopes tenants and excludes payloads", async () => {
    const response = await request(app).get(`/v1/dashboard/notifications?customerId=${customerId}&channel=email&status=provider_accepted&search=ALPHA&limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].recipient).toBe("dashboard-alpha@example.com");
    expect(response.body.notifications[0]).not.toHaveProperty("payload");
    const empty = await request(app).get(`/v1/dashboard/notifications?customerId=${customerId}&page=5&limit=1`);
    expect(empty.body).toMatchObject({notifications:[],total:2,page:5});
  });
  it("treats SQL-like search text as literal data", async () => {
    const response = await request(app).get(`/v1/dashboard/notifications?customerId=${customerId}`).query({search:"' OR 1=1 --"});
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(0);
  });
  it("returns only saved preferences for the selected tenant", async () => {
    const response = await request(app).get(`/v1/dashboard/preferences?customerId=${customerId}`);
    expect(response.status).toBe(200);
    expect(response.body.preferences).toHaveLength(1);
    expect(response.body.preferences[0].enabled).toBe(false);
    const other = await request(app).get(`/v1/dashboard/preferences?customerId=${otherId}`);
    expect(other.body.preferences).toEqual([]);
    const emptyPage = await request(app).get(`/v1/dashboard/preferences?customerId=${customerId}&page=5&limit=1`);
    expect(emptyPage.body).toMatchObject({preferences:[],total:1});
  });
  it("reads actual queue, dependency and process state", async () => {
    const response = await request(app).get("/v1/dashboard/monitoring");
    expect(response.status).toBe(200);
    expect(response.body.database).toBe("healthy");
    expect(response.body.outbox.pending).toBeGreaterThanOrEqual(0);
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.body).not.toHaveProperty("lastErrorMessage");
  });
});
