import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("Relay Health API", () => {
    it("returns a healthy service status", async () => {
        const response = await request(app).get("/v1/health");

        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
        expect(response.body.service).toBe("relay");
        expect(response.body.timestamp).toBeDefined();
    });

    it("returns 404 for unknown routes", async () => {
        const response = await request(app).get("/v1/unknown");

        expect(response.status).toBe(404);
        expect(response.body.code).toBe("NOT_FOUND");
    });
});