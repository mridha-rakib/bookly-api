import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { createEmailOtpProvider } from "../verification/email-otp.provider.js";
import { BusinessController } from "./business.controller.js";
import { BusinessRepository } from "./business.repository.js";
import {
  businessIdParamsSchema,
  requestLinkVerificationBodySchema,
  updateBusinessBodySchema,
  verificationIdParamsSchema,
  verifyLinkVerificationBodySchema,
} from "./business.schema.js";
import { BusinessService } from "./business.service.js";
import { BusinessAccessRepository } from "./business-access.repository.js";
import { BusinessLinkVerificationRepository } from "./business-link-verification.repository.js";

export const createBusinessRoute = (): Router => {
  const router = Router();
  const userRepository = new UserRepository();
  const businessRepository = new BusinessRepository();
  const businessAccessRepository = new BusinessAccessRepository();
  const businessLinkVerificationRepository = new BusinessLinkVerificationRepository();
  const businessService = new BusinessService(
    businessRepository,
    businessAccessRepository,
    userRepository,
    businessLinkVerificationRepository,
    createEmailOtpProvider(),
  );
  const controller = new BusinessController(businessService);
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  // Business Profile is a Business Owner surface only; no product rule authorizes
  // STAFF/SUPERVISOR/CUSTOMER access to it in this phase.
  router.use(authenticate, requireActiveUser(), requireRoles(["BUSINESS_OWNER"]));

  router.get("/my-profile", asyncHandler(controller.getMyProfile));

  router.post(
    "/links/verification",
    validateRequest({ body: requestLinkVerificationBodySchema }),
    asyncHandler(controller.requestLinkVerification),
  );
  router.post(
    "/links/verification/:verificationId/resend",
    validateRequest({ params: verificationIdParamsSchema }),
    asyncHandler(controller.resendLinkVerification),
  );
  router.post(
    "/links/verification/:verificationId/verify",
    validateRequest({ params: verificationIdParamsSchema, body: verifyLinkVerificationBodySchema }),
    asyncHandler(controller.verifyLinkVerification),
  );
  router.delete(
    "/links/:businessId",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.unlink),
  );

  router.get(
    "/:businessId",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.getById),
  );
  router.patch(
    "/:businessId",
    validateRequest({ params: businessIdParamsSchema, body: updateBusinessBodySchema }),
    asyncHandler(controller.update),
  );

  return router;
};
