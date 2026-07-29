import { Router } from "express";

import type { DatabaseStateReader } from "../database/database-manager.js";
import { HealthController } from "../modules/health/health.controller.js";
import { HealthRepository } from "../modules/health/health.repository.js";
import { createReadinessHealthRoute } from "../modules/health/health.route.js";
import { HealthService } from "../modules/health/health.service.js";

export const createApiRouter = (databaseStateReader: DatabaseStateReader): Router => {
  const router = Router();
  const healthRepository = new HealthRepository(databaseStateReader);
  const healthService = new HealthService(healthRepository);
  const healthController = new HealthController(healthService);

  router.use("/health", createReadinessHealthRoute(healthController));

  return router;
};
