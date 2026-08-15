import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { businessIdParamsSchema } from "../business/business.schema.js";
import { BusinessAccessRepository } from "../business/business-access.repository.js";
import { BusinessTravelSettingsController } from "./business-travel-settings.controller.js";
import { BusinessTravelSettingsRepository } from "./business-travel-settings.repository.js";
import { updateBusinessTravelSettingsBodySchema } from "./business-travel-settings.schema.js";
import { BusinessTravelSettingsService } from "./business-travel-settings.service.js";

export const createBusinessTravelSettingsRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const service = new BusinessTravelSettingsService(
    new BusinessTravelSettingsRepository(),
    new BusinessRepository(),
    new BusinessAccessRepository(),
  );
  const controller = new BusinessTravelSettingsController(service);

  router.get(
    "/:businessId/travel-settings",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.get),
  );
  router.put(
    "/:businessId/travel-settings",
    validateRequest({
      params: businessIdParamsSchema,
      body: updateBusinessTravelSettingsBodySchema,
    }),
    asyncHandler(controller.update),
  );

  return router;
};
