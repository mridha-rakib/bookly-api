import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { buildErrorResponse } from "../common/http/responses.js";
import { createErrorHandler } from "../common/middleware/error-handler.js";
import { httpLoggerMiddleware } from "../common/middleware/http-logger.js";
import { notFoundMiddleware } from "../common/middleware/not-found.js";
import { requestIdMiddleware } from "../common/middleware/request-id.js";
import { env } from "../config/env.js";
import { createSwaggerHtml, openApiDocument } from "../config/openapi.js";
import type { DatabaseStateReader } from "../database/database-manager.js";
import { HealthController } from "../modules/health/health.controller.js";
import { HealthRepository } from "../modules/health/health.repository.js";
import { createLivenessHealthRoute } from "../modules/health/health.route.js";
import { HealthService } from "../modules/health/health.service.js";
import { createStripeWebhookRoute } from "../modules/stripe-webhook/stripe-webhook.route.js";
import { createApiRouter } from "../routes/api-router.js";

export class ExpressApplication {
  public readonly app: Express;

  public constructor(private readonly databaseStateReader: DatabaseStateReader) {
    this.app = express();
    this.configure();
  }

  private configure(): void {
    this.app.set("trust proxy", env.TRUST_PROXY);

    this.app.use(requestIdMiddleware);
    this.app.use(httpLoggerMiddleware);
    this.app.use(helmet());
    this.app.use(this.createCorsMiddleware());
    this.app.use(compression());

    // MUST be mounted before express.json() below — Stripe webhook signature verification
    // needs the exact raw request bytes (see stripe-webhook.route.ts's own comment). This is
    // the one deliberate exception to "every route goes through createApiRouter" in this
    // codebase; every other route is completely unaffected.
    const apiPrefix = `/api/${env.API_VERSION}`;
    this.app.use(`${apiPrefix}/payments/webhooks`, createStripeWebhookRoute());

    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "1mb" }));

    const healthController = this.createHealthController();
    this.app.use("/health", createLivenessHealthRoute(healthController));

    this.registerDocumentationRoutes();
    this.app.use(apiPrefix, this.createRateLimiter(), createApiRouter(this.databaseStateReader));

    this.app.use(notFoundMiddleware);
    this.app.use(createErrorHandler());
  }

  private createHealthController(): HealthController {
    const healthRepository = new HealthRepository(this.databaseStateReader);
    const healthService = new HealthService(healthRepository);
    return new HealthController(healthService);
  }

  private createCorsMiddleware() {
    return cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (env.CORS_ORIGINS.includes("*") && env.NODE_ENV !== "production") {
          callback(null, true);
          return;
        }

        if (env.CORS_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("CORS origin is not allowed"));
      },
      credentials: true,
    });
  }

  private createRateLimiter() {
    return rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: buildErrorResponse("Too many requests"),
    });
  }

  private registerDocumentationRoutes(): void {
    if (!env.API_DOCS_ENABLED) {
      return;
    }

    this.app.get("/openapi.json", (_request, response) => {
      response.json(openApiDocument);
    });

    this.app.get("/docs", (_request, response) => {
      response.type("html").send(createSwaggerHtml());
    });
  }
}
