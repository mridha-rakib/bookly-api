import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessHoursController } from "./business-hours.controller.js";
import { BusinessHoursRepository } from "./business-hours.repository.js";
import { businessHoursParamsSchema, putBusinessHoursBodySchema } from "./business-hours.schema.js";
import { BusinessHoursService } from "./business-hours.service.js";

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate — Business opening hours are a Business Profile/settings surface: Owner-only, no
 * BusinessAccess-linked read/write, no Supervisor access (same rationale as
 * business-booking-settings).
 */
export const createBusinessHoursRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const service = new BusinessHoursService(new BusinessHoursRepository(), new BusinessRepository());
  const controller = new BusinessHoursController(service);

  router.get(
    "/:businessId/opening-hours",
    validateRequest({ params: businessHoursParamsSchema }),
    asyncHandler(controller.get),
  );
  router.put(
    "/:businessId/opening-hours",
    validateRequest({ params: businessHoursParamsSchema, body: putBusinessHoursBodySchema }),
    asyncHandler(controller.put),
  );

  return router;
};
