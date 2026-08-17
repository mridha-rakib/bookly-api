import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsController } from "./business-booking-settings.controller.js";
import { BusinessBookingSettingsRepository } from "./business-booking-settings.repository.js";
import {
  businessBookingSettingsParamsSchema,
  updateBusinessBookingSettingsBodySchema,
} from "./business-booking-settings.schema.js";
import { BusinessBookingSettingsService } from "./business-booking-settings.service.js";

export const createBusinessBookingSettingsRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const service = new BusinessBookingSettingsService(
    new BusinessBookingSettingsRepository(),
    new BusinessRepository(),
  );
  const controller = new BusinessBookingSettingsController(service);

  router.get(
    "/:businessId/booking-settings",
    validateRequest({ params: businessBookingSettingsParamsSchema }),
    asyncHandler(controller.get),
  );
  router.put(
    "/:businessId/booking-settings",
    validateRequest({
      params: businessBookingSettingsParamsSchema,
      body: updateBusinessBookingSettingsBodySchema,
    }),
    asyncHandler(controller.update),
  );

  return router;
};
