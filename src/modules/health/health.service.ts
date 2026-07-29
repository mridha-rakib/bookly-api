import { env } from "../../config/env.js";
import type { HealthRepository } from "./health.repository.js";
import type { LivenessHealth, ReadinessHealth } from "./health.types.js";

export class HealthService {
  public constructor(private readonly healthRepository: HealthRepository) {}

  public getLiveness(): LivenessHealth {
    return {
      application: env.APP_NAME,
      environment: env.NODE_ENV,
      version: env.API_VERSION,
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  public getReadiness(): ReadinessHealth {
    const databaseState = this.healthRepository.getDatabaseConnectionState();

    return {
      application: env.APP_NAME,
      environment: env.NODE_ENV,
      version: env.API_VERSION,
      status: databaseState === "connected" ? "ready" : "not_ready",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: {
        state: databaseState,
      },
    };
  }

  public isReady(): boolean {
    return this.healthRepository.getDatabaseConnectionState() === "connected";
  }
}
