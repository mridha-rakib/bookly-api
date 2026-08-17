import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { ServiceCategoryRepository } from "../services/service-category.repository.js";
import { AddonController } from "./addon.controller.js";
import { AddonRepository } from "./addon.repository.js";
import {
  addonBusinessParamsSchema,
  addonIdParamsSchema,
  createAddonBodySchema,
  listAddonsQuerySchema,
  restoreAddonBodySchema,
  updateAddonBodySchema,
  updateAddonStatusBodySchema,
} from "./addon.schema.js";
import { AddonService } from "./addon.service.js";
import { AddonServiceAssignmentRepository } from "./addon-service-assignment.repository.js";
import { addonServiceIdParamsSchema } from "./addon-service-assignment.schema.js";

/**
 * Mounted inside business.route.ts, underneath its existing
 * `requireRoles(["BUSINESS_OWNER"])` gate — Add-ons are BUSINESS_OWNER-only management
 * functionality end to end (same product rule as Services): Supervisor/Staff never reach
 * these handlers, and ownership is re-checked per request in AddonService (no BusinessAccess
 * fallback — see addon.service.ts requireOwnedBusiness).
 */
export const createAddonsRoute = (): Router => {
  const router = Router({ mergeParams: true });

  const businessRepository = new BusinessRepository();
  const service = new AddonService(
    new AddonRepository(),
    new AddonServiceAssignmentRepository(),
    businessRepository,
    new ServiceCategoryRepository(),
    new ServiceRepository(),
  );
  const controller = new AddonController(service);

  router.get(
    "/:businessId/addons",
    validateRequest({ params: addonBusinessParamsSchema, query: listAddonsQuerySchema }),
    asyncHandler(controller.list),
  );
  router.post(
    "/:businessId/addons",
    validateRequest({ params: addonBusinessParamsSchema, body: createAddonBodySchema }),
    asyncHandler(controller.create),
  );
  router.get(
    "/:businessId/addons/:addonId",
    validateRequest({ params: addonIdParamsSchema }),
    asyncHandler(controller.getById),
  );
  router.patch(
    "/:businessId/addons/:addonId",
    validateRequest({ params: addonIdParamsSchema, body: updateAddonBodySchema }),
    asyncHandler(controller.update),
  );
  router.patch(
    "/:businessId/addons/:addonId/status",
    validateRequest({ params: addonIdParamsSchema, body: updateAddonStatusBodySchema }),
    asyncHandler(controller.updateStatus),
  );
  router.delete(
    "/:businessId/addons/:addonId",
    validateRequest({ params: addonIdParamsSchema }),
    asyncHandler(controller.archive),
  );
  router.post(
    "/:businessId/addons/:addonId/restore",
    validateRequest({ params: addonIdParamsSchema, body: restoreAddonBodySchema }),
    asyncHandler(controller.restore),
  );

  // Service Edit / View's "Assigned Add-ons" section — read-only in this phase, relationship
  // changes go through the Add-on's own "Assign to services" field (see addon.service.ts).
  router.get(
    "/:businessId/services/:serviceId/addons",
    validateRequest({ params: addonServiceIdParamsSchema }),
    asyncHandler(controller.listForService),
  );

  return router;
};
