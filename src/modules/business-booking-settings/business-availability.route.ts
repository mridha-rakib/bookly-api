import { Router } from "express";
import { z } from "zod";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { AuthError } from "../auth/auth.errors.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireApprovedBusiness,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { businessIdParamsSchema } from "../business/business.schema.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import {
  type AvailabilityRulesBody,
  availabilityRulesBodySchema,
  type ChangeBlocksBody,
  changeBlocksBodySchema,
} from "./business-availability.rules.js";
import { BusinessAvailabilityService } from "./business-availability.service.js";

export function createBusinessAvailabilityRoute(): Router {
  const router = Router();
  const service = new BusinessAvailabilityService();
  const auth = createAuthenticateAccessTokenMiddleware(
    new TokenService(new SessionRepository()),
    new UserRepository(),
  );
  const approved = requireApprovedBusiness(new BusinessRepository());
  // Per-route gates let unrelated Staff routes fall through to their own authorization.
  for (const name of ["availability-rules", "calendar-blocks"] as const) {
    const roles = requireRoles(
      name === "availability-rules" ? ["BUSINESS_OWNER"] : ["BUSINESS_OWNER", "SUPERVISOR"],
    );
    router.get(
      `/:businessId/${name}`,
      auth,
      requireActiveUser(),
      roles,
      validateRequest({ params: businessIdParamsSchema }),
      asyncHandler(async (request, response) => {
        const params = request.validated?.params as { businessId: string };
        const businessId = params.businessId;
        const actor = request.auth;
        if (!actor) throw new AuthError("SESSION_EXPIRED", 401);
        const result =
          name === "availability-rules"
            ? await service.getRules(actor.userId, actor.role, businessId)
            : await service.getBlocks(actor.userId, actor.role, businessId);
        sendSuccess(response, 200, "Business availability", result);
      }),
    );
    router.put(
      `/:businessId/${name}`,
      auth,
      requireActiveUser(),
      roles,
      validateRequest({
        params: businessIdParamsSchema,
        body:
          name === "availability-rules"
            ? availabilityRulesBodySchema.extend({ publicVisible: z.boolean() })
            : changeBlocksBodySchema,
      }),
      approved,
      asyncHandler(async (request, response) => {
        const params = request.validated?.params as { businessId: string };
        const businessId = params.businessId;
        const actor = request.auth;
        if (!actor) throw new AuthError("SESSION_EXPIRED", 401);
        const result =
          name === "availability-rules"
            ? await service.updateRules(
                actor.userId,
                actor.role,
                businessId,
                request.validated?.body as AvailabilityRulesBody & { publicVisible: boolean },
              )
            : await service.changeBlocks(
                actor.userId,
                actor.role,
                businessId,
                request.validated?.body as ChangeBlocksBody,
              );
        sendSuccess(response, 200, "Business availability saved", result);
      }),
    );
  }
  return router;
}
