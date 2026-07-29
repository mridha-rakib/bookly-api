import request from "supertest";
import { describe, expect, it } from "vitest";

import { ExpressApplication } from "../../src/app/app.js";
import { FakeDatabaseStateReader } from "../helpers/fake-database-state-reader.js";

const createApp = (databaseStateReader = new FakeDatabaseStateReader()) =>
  new ExpressApplication(databaseStateReader).app;

describe("health and infrastructure routes", () => {
  it("GET /health returns process liveness without requiring database readiness", async () => {
    const app = createApp(new FakeDatabaseStateReader("disconnected"));

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      success: true,
      message: "Service is live",
      data: {
        application: "Bookly API",
        environment: "test",
        version: "v1",
        status: "ok",
      },
    });
    expect(response.body.data).not.toHaveProperty("database");
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /api/v1/health returns readiness when MongoDB is connected", async () => {
    const app = createApp(new FakeDatabaseStateReader("connected"));

    const response = await request(app).get("/api/v1/health").expect(200);

    expect(response.body).toMatchObject({
      success: true,
      message: "Service is ready",
      data: {
        status: "ready",
        database: {
          state: "connected",
        },
      },
    });
  });

  it("GET /api/v1/health returns 503 when MongoDB is disconnected", async () => {
    const app = createApp(new FakeDatabaseStateReader("disconnected"));

    const response = await request(app).get("/api/v1/health").expect(503);

    expect(response.body).toMatchObject({
      success: true,
      message: "Service is not ready",
      data: {
        status: "not_ready",
        database: {
          state: "disconnected",
        },
      },
    });
  });

  it("serves generated OpenAPI JSON and Swagger docs when enabled", async () => {
    const app = createApp();

    const openApiResponse = await request(app).get("/openapi.json").expect(200);
    const docsResponse = await request(app).get("/docs").expect(200);

    expect(openApiResponse.body.openapi).toBe("3.0.0");
    expect(openApiResponse.body.paths).toHaveProperty("/health");
    expect(openApiResponse.body.paths).toHaveProperty("/api/v1/health");
    expect(docsResponse.text).toContain("SwaggerUIBundle");
  });

  it("returns a consistent 404 response", async () => {
    const app = createApp();

    const response = await request(app).get("/missing").expect(404);

    expect(response.body).toMatchObject({
      success: false,
      message: "Route GET /missing not found",
    });
    expect(response.body.requestId).toBeTruthy();
    expect(response.body.errors).toBeUndefined();
  });
});
