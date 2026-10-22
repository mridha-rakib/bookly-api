import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { ServiceCategoryRepository } from "../services/service-category.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { PackageController } from "./package.controller.js";
import { PackageRepository } from "./package.repository.js";
import {
  archivePackageQuerySchema,
  createPackageBodySchema,
  listPackagesQuerySchema,
  packageBusinessParamsSchema,
  packageIdParamsSchema,
  restorePackageBodySchema,
  updatePackageBodySchema,
  updatePackageStatusBodySchema,
} from "./package.schema.js";
import { PackageService } from "./package.service.js";

/** Mounted inside the existing Business Owner/auth/active-user/approved-Business gates. */
export const createPackagesRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const controller = new PackageController(
    new PackageService(
      new PackageRepository(),
      new BusinessRepository(),
      new ServiceRepository(),
      new ServiceCategoryRepository(),
      new StaffRepository(),
      new BusinessTravelSettingsRepository(),
    ),
  );
  const base = "/:businessId/packages";
  const detail = `${base}/:packageId`;
  router.get(
    base,
    validateRequest({ params: packageBusinessParamsSchema, query: listPackagesQuerySchema }),
    asyncHandler(controller.list),
  );
  router.post(
    base,
    validateRequest({ params: packageBusinessParamsSchema, body: createPackageBodySchema }),
    asyncHandler(controller.create),
  );
  router.get(
    detail,
    validateRequest({ params: packageIdParamsSchema }),
    asyncHandler(controller.detail),
  );
  router.patch(
    detail,
    validateRequest({ params: packageIdParamsSchema, body: updatePackageBodySchema }),
    asyncHandler(controller.update),
  );
  router.patch(
    `${detail}/status`,
    validateRequest({ params: packageIdParamsSchema, body: updatePackageStatusBodySchema }),
    asyncHandler(controller.status),
  );
  router.delete(
    detail,
    validateRequest({ params: packageIdParamsSchema, query: archivePackageQuerySchema }),
    asyncHandler(controller.archive),
  );
  router.post(
    `${detail}/restore`,
    validateRequest({ params: packageIdParamsSchema, body: restorePackageBodySchema }),
    asyncHandler(controller.restore),
  );
  return router;
};
