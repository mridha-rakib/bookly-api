import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffAvatarRepository } from "../staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { ServiceController } from "./service.controller.js";
import { ServiceRepository } from "./service.repository.js";
import {
  createServiceBodySchema,
  createServiceCategoryBodySchema,
  listServiceCategoriesQuerySchema,
  listServicesQuerySchema,
  restoreServiceBodySchema,
  serviceBusinessParamsSchema,
  serviceCategoryIdParamsSchema,
  serviceIdParamsSchema,
  updateServiceBodySchema,
  updateServiceCategoryBodySchema,
  updateServiceStatusBodySchema,
} from "./service.schema.js";
import { ServiceService } from "./service.service.js";
import { ServiceCategoryRepository } from "./service-category.repository.js";

/**
 * Mounted inside business.route.ts, underneath its existing
 * `requireRoles(["BUSINESS_OWNER"])` gate — Services (and their custom categories) are
 * BUSINESS_OWNER-only management functionality end to end (confirmed product rule):
 * Supervisor/Staff never reach these handlers, and ownership is re-checked per request in
 * ServiceService (no BusinessAccess fallback — see service.service.ts requireOwnedBusiness).
 */
export const createServicesRoute = (): Router => {
  const router = Router({ mergeParams: true });

  const businessRepository = new BusinessRepository();
  const staffRepository = new StaffRepository();
  const staffAvatarService = new StaffAvatarService(
    new StaffAvatarRepository(),
    businessRepository,
    staffRepository,
    createDeferredStorageServiceFromEnv(),
    { maxUploadBytes: env.STAFF_AVATAR_MAX_UPLOAD_BYTES },
  );
  const service = new ServiceService(
    new ServiceRepository(),
    new ServiceCategoryRepository(),
    businessRepository,
    new BusinessTravelSettingsRepository(),
    staffRepository,
    new UserRepository(),
    staffAvatarService,
  );
  const controller = new ServiceController(service);

  // --- Service Categories ---

  router.get(
    "/:businessId/service-categories",
    validateRequest({
      params: serviceBusinessParamsSchema,
      query: listServiceCategoriesQuerySchema,
    }),
    asyncHandler(controller.listCategories),
  );
  router.post(
    "/:businessId/service-categories",
    validateRequest({ params: serviceBusinessParamsSchema, body: createServiceCategoryBodySchema }),
    asyncHandler(controller.createCategory),
  );
  router.patch(
    "/:businessId/service-categories/:categoryId",
    validateRequest({
      params: serviceCategoryIdParamsSchema,
      body: updateServiceCategoryBodySchema,
    }),
    asyncHandler(controller.updateCategory),
  );

  // --- Services ---

  router.get(
    "/:businessId/services",
    validateRequest({ params: serviceBusinessParamsSchema, query: listServicesQuerySchema }),
    asyncHandler(controller.list),
  );
  router.post(
    "/:businessId/services",
    validateRequest({ params: serviceBusinessParamsSchema, body: createServiceBodySchema }),
    asyncHandler(controller.create),
  );
  router.get(
    "/:businessId/services/:serviceId",
    validateRequest({ params: serviceIdParamsSchema }),
    asyncHandler(controller.getById),
  );
  router.patch(
    "/:businessId/services/:serviceId",
    validateRequest({ params: serviceIdParamsSchema, body: updateServiceBodySchema }),
    asyncHandler(controller.update),
  );
  router.patch(
    "/:businessId/services/:serviceId/status",
    validateRequest({ params: serviceIdParamsSchema, body: updateServiceStatusBodySchema }),
    asyncHandler(controller.updateStatus),
  );
  router.delete(
    "/:businessId/services/:serviceId",
    validateRequest({ params: serviceIdParamsSchema }),
    asyncHandler(controller.archive),
  );
  router.post(
    "/:businessId/services/:serviceId/restore",
    validateRequest({ params: serviceIdParamsSchema, body: restoreServiceBodySchema }),
    asyncHandler(controller.restore),
  );

  return router;
};
