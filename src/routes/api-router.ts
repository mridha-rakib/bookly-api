import { Router } from "express";

import type { DatabaseStateReader } from "../database/database-manager.js";
import { createAuthRoute } from "../modules/auth/auth.route.js";
import { createBusinessRoute } from "../modules/business/business.route.js";
import { createClientRoute } from "../modules/client/client.route.js";
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
  router.use("/auth", createAuthRoute());
  // createClientRoute() is mounted first: it applies auth per-route (not a blanket gate), so
  // it only intercepts requests it actually owns (/:businessId/clients...) and everything else
  // falls through untouched to createBusinessRoute()'s stricter BUSINESS_OWNER-only gate below.
  // Registering it after would be broken — createBusinessRoute()'s router-wide
  // requireRoles(["BUSINESS_OWNER"]) would reject SUPERVISOR before this router is ever reached.
  router.use("/businesses", createClientRoute());
  router.use("/businesses", createBusinessRoute());

  return router;
};
