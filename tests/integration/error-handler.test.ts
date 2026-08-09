import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../../src/common/errors/app-error.js";
import { sendSuccess } from "../../src/common/http/responses.js";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { requestIdMiddleware } from "../../src/common/middleware/request-id.js";
import { validateRequest } from "../../src/common/middleware/validate-request.js";

const createValidationApp = () => {
  const app = express();

  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post(
    "/validate",
    validateRequest({
      body: z.object({
        name: z.string().min(2),
      }),
    }),
    (request, response) => {
      sendSuccess(response, 200, "Validated", request.validated?.body);
    },
  );
  app.use(createErrorHandler({ isProduction: false }));

  return app;
};

describe("validation and error handling", () => {
  it("preserves a valid request id and replaces unsafe request ids", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/request-id", (request, response) => {
      response.json({ requestId: request.id });
    });

    const validResponse = await request(app)
      .get("/request-id")
      .set("x-request-id", "req_123.test-1")
      .expect(200);

    expect(validResponse.body.requestId).toBe("req_123.test-1");
    expect(validResponse.headers["x-request-id"]).toBe("req_123.test-1");

    const unsafeResponse = await request(app)
      .get("/request-id")
      .set("x-request-id", "invalid request id")
      .expect(200);

    expect(unsafeResponse.body.requestId).not.toBe("invalid request id");
    expect(unsafeResponse.body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("stores validated request data for downstream handlers", async () => {
    const app = createValidationApp();

    const response = await request(app).post("/validate").send({ name: "Bookly" }).expect(200);

    expect(response.body).toEqual({
      success: true,
      message: "Validated",
      data: {
        name: "Bookly",
      },
    });
  });

  it("returns stable Zod validation errors", async () => {
    const app = createValidationApp();

    const response = await request(app).post("/validate").send({ name: "" }).expect(400);

    expect(response.body).toMatchObject({
      success: false,
      message: "Validation failed",
      errors: [
        {
          path: "name",
          code: "too_small",
        },
      ],
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it("returns operational application errors through the global handler", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/conflict", () => {
      throw new AppError("State conflict", 409);
    });
    app.use(createErrorHandler({ isProduction: false }));

    const response = await request(app).get("/conflict").expect(409);

    expect(response.body).toMatchObject({
      success: false,
      message: "State conflict",
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it("does not leak stack traces or sensitive messages for unexpected production errors", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/boom", () => {
      throw new Error("sensitive path C:\\secret\\file.txt");
    });
    app.use(createErrorHandler({ isProduction: true }));

    const response = await request(app).get("/boom").expect(500);

    expect(response.body).toMatchObject({
      success: false,
      message: "Internal server error",
    });
    expect(response.body.stack).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("C:\\secret");
  });
});
