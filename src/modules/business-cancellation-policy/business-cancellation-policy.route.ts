import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessCancellationPolicyController } from "./business-cancellation-policy.controller.js";
import { BusinessCancellationPolicyRepository } from "./business-cancellation-policy.repository.js";
import {
  cancellationPolicyParamsSchema,
  putCancellationPolicyBodySchema,
} from "./business-cancellation-policy.schema.js";
import { BusinessCancellationPolicyService } from "./business-cancellation-policy.service.js";

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate — cancellation/no-show fee policy is a Business Profile/settings surface: Owner-only,
 * no BusinessAccess-linked read/write, no Supervisor access (same rationale as
 * business-hours). Persistence and validation only in this phase — no charge execution route
 * exists here or anywhere yet.
 */
export const createBusinessCancellationPolicyRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const service = new BusinessCancellationPolicyService(
    new BusinessCancellationPolicyRepository(),
    new BusinessRepository(),
  );
  const controller = new BusinessCancellationPolicyController(service);

  router.get(
    "/:businessId/cancellation-policy",
    validateRequest({ params: cancellationPolicyParamsSchema }),
    asyncHandler(controller.get),
  );
  router.put(
    "/:businessId/cancellation-policy",
    validateRequest({
      params: cancellationPolicyParamsSchema,
      body: putCancellationPolicyBodySchema,
    }),
    asyncHandler(controller.put),
  );

  return router;
};
