import type { RequestHandler } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { HealthService } from "./health.service.js";

export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  public readonly getLiveness: RequestHandler = (_request, response) => {
    sendSuccess(response, 200, "Service is live", this.healthService.getLiveness());
  };

  public readonly getReadiness: RequestHandler = (_request, response) => {
    const readiness = this.healthService.getReadiness();
    const statusCode = this.healthService.isReady() ? 200 : 503;

    sendSuccess(
      response,
      statusCode,
      statusCode === 200 ? "Service is ready" : "Service is not ready",
      readiness,
    );
  };
}
