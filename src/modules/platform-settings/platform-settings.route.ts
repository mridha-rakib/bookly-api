import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { PlatformSettingsController } from "./platform-settings.controller.js";
import { PlatformSettingsRepository } from "./platform-settings.repository.js";
import { PlatformSettingsService } from "./platform-settings.service.js";

/**
 * Genuinely anonymous — mirrors createPublicContentRoute (no `authenticate` in the chain).
 * Exposes ONLY `maxServicesPerBooking`, so the customer / business booking UIs can mirror the
 * server-authoritative limit (the backend still validates independently on every create).
 * Nothing financial and no category windows are exposed here.
 */
export const createPlatformConfigRoute = (): Router => {
  const router = Router();
  const controller = new PlatformSettingsController(
    new PlatformSettingsService(new PlatformSettingsRepository()),
  );

  router.get("/booking-config", asyncHandler(controller.getPublicBookingConfig));

  return router;
};
