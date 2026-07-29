import { Router } from "express";

import type { HealthController } from "./health.controller.js";

export const createLivenessHealthRoute = (healthController: HealthController): Router => {
  const router = Router();

  router.get("/", healthController.getLiveness);

  return router;
};

export const createReadinessHealthRoute = (healthController: HealthController): Router => {
  const router = Router();

  router.get("/", healthController.getReadiness);

  return router;
};
