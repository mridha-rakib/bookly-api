import type { Request } from "express";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { createAddonsRoute } from "../addons/addon.route.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { normalizeEmail } from "../auth/auth.utils.js";
import { TokenService } from "../auth/token.service.js";
import { createBusinessBookingSettingsRoute } from "../business-booking-settings/business-booking-settings.route.js";
import { createBusinessCancellationPolicyRoute } from "../business-cancellation-policy/business-cancellation-policy.route.js";
import { createBusinessHoursRoute } from "../business-hours/business-hours.route.js";
import { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import { createBusinessMediaRoute } from "../business-media/business-media.route.js";
import { createBusinessTravelSettingsRoute } from "../business-travel-settings/business-travel-settings.route.js";
import { createFinanceRoute } from "../finance/finance.route.js";
import { createServicesRoute } from "../services/service.route.js";
import { SessionRepository } from "../session/session.repository.js";
import { createStaffRoute } from "../staff/staff.route.js";
import { createStaffAvatarRoute } from "../staff-avatar/staff-avatar.route.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
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

/**
 * Per-IP throttle for the business-link OTP-email endpoints, mirroring auth.route.ts's
 * authRateLimit factory exactly (same options shape, same generic message — never anything
 * that would let a caller distinguish "target exists" from "target doesn't exist" by rate-
 * limit response alone).
 */
export const businessLinkOtpRateLimit = (limit: number, windowMs = 60 * 60 * 1000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many verification requests. Please try again later."),
  });

/**
 * Per-target-email throttle on top of the per-IP one above: requestLinkVerification takes an
 * attacker-chosen email in the body (unlike /resend and /verify, which only take a
 * verificationId the caller already owns), so it is the one endpoint where a single victim
 * email could otherwise be flooded with OTP mail from many different source IPs. Falls back
 * to the IP-derived key when the body has no usable email so a malformed request still counts
 * against *some* bucket rather than bypassing this limiter entirely.
 */
export const businessLinkOtpPerEmailRateLimit = (limit: number, windowMs = 60 * 60 * 1000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many verification requests. Please try again later."),
    keyGenerator: (req: Request) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      return email ? `email:${normalizeEmail(email)}` : ipKeyGenerator(req.ip ?? "unknown");
    },
  });

export const createBusinessRoute = (): Router => {
  const router = Router();
  const userRepository = new UserRepository();
  const businessRepository = new BusinessRepository();
  const businessAccessRepository = new BusinessAccessRepository();
  const businessLinkVerificationRepository = new BusinessLinkVerificationRepository();
  const businessMediaRepository = new BusinessMediaRepository();
  const storageService = createDeferredStorageServiceFromEnv();
  const businessService = new BusinessService(
    businessRepository,
    businessAccessRepository,
    userRepository,
    businessLinkVerificationRepository,
    createEmailOtpProvider(),
    businessMediaRepository,
    storageService,
  );
  const controller = new BusinessController(businessService);
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const linkOtpSendLimiter = businessLinkOtpRateLimit(env.BUSINESS_LINK_OTP_SEND_RATE_LIMIT_MAX);
  const linkOtpSendPerEmailLimiter = businessLinkOtpPerEmailRateLimit(
    env.BUSINESS_LINK_OTP_SEND_PER_EMAIL_RATE_LIMIT_MAX,
  );

  // Business Profile is a Business Owner surface only; no product rule authorizes
  // STAFF/SUPERVISOR/CUSTOMER access to it in this phase.
  router.use(authenticate, requireActiveUser(), requireRoles(["BUSINESS_OWNER"]));

  router.get("/my-profile", asyncHandler(controller.getMyProfile));
  router.use(createBusinessMediaRoute());
  router.use(createBusinessTravelSettingsRoute());
  router.use(createBusinessBookingSettingsRoute());
  router.use(createBusinessHoursRoute());
  router.use(createBusinessCancellationPolicyRoute());
  router.use(createServicesRoute());
  router.use(createAddonsRoute());
  router.use(createStaffRoute());
  router.use(createStaffAvatarRoute());
  router.use(createFinanceRoute());

  router.post(
    "/links/verification",
    linkOtpSendLimiter,
    linkOtpSendPerEmailLimiter,
    validateRequest({ body: requestLinkVerificationBodySchema }),
    asyncHandler(controller.requestLinkVerification),
  );
  router.post(
    "/links/verification/:verificationId/resend",
    linkOtpSendLimiter,
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
