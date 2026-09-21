import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { PlatformSettingsController } from "./platform-settings.controller.js";
import { PlatformSettingsRepository } from "./platform-settings.repository.js";
import { PlatformSettingsService } from "./platform-settings.service.js";

/**
 * Genuinely anonymous — mirrors createPublicContentRoute (no `authenticate` in the chain).
 * `booking-config` exposes ONLY `maxServicesPerBooking`, so the customer / business booking UIs
 * can mirror the server-authoritative limit (the backend still validates independently on every
 * create) — nothing financial and no category windows are exposed there.
 *
 * `business-taxonomy` is the ONE canonical, read-only Business Owner registration category +
 * subcategory tree (see business-taxonomy.ts). GET only, deliberately — there is no admin
 * create/update/delete for this taxonomy.
 */
export const createPlatformConfigRoute = (): Router => {
  const router = Router();
  const controller = new PlatformSettingsController(
    new PlatformSettingsService(new PlatformSettingsRepository()),
  );

  router.get("/booking-config", asyncHandler(controller.getPublicBookingConfig));
  router.get("/business-taxonomy", asyncHandler(controller.getBusinessTaxonomy));

  return router;
};
