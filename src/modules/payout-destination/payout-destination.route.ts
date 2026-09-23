import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { Argon2PasswordHasher } from "../auth/password-hasher.js";
import { BusinessRepository } from "../business/business.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { createEmailOtpProvider } from "../verification/email-otp.provider.js";
import { PayoutDestinationController } from "./payout-destination.controller.js";
import { PayoutDestinationRepository } from "./payout-destination.repository.js";
import {
  payoutDestinationBusinessParamsSchema,
  requestPayoutStepUpOtpBodySchema,
  updatePayoutDestinationBodySchema,
  verifyPayoutStepUpOtpBodySchema,
} from "./payout-destination.schema.js";
import { PayoutDestinationService } from "./payout-destination.service.js";
import { PayoutDestinationStepUpRepository } from "./payout-destination-step-up.repository.js";

/**
 * Same per-IP throttle factory/options shape as auth.route.ts's `authRateLimit` and
 * business.route.ts's `businessLinkOtpRateLimit` — deliberately a reuse of the established
 * express-rate-limit pattern rather than a new limiting mechanism. The OTP-send bucket uses the
 * one-hour window the auth module's `otpSendLimiter` uses; verify uses the 15-minute default.
 */
const payoutStepUpRateLimit = (limit: number, windowMs = 15 * 60 * 1000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many verification requests. Please try again later."),
  });

/**
 * Mounted inside business.route.ts, underneath its existing
 * `requireRoles(["BUSINESS_OWNER"])` gate — mirroring createFinanceRoute exactly. SUPERVISOR and
 * STAFF therefore get 403 at the router gate and never reach a handler, and
 * PayoutDestinationService.requireOwnedPayoutDestinationBusiness additionally verifies the actor
 * actually OWNS the requested businessId (defense in depth, same as FinanceService).
 *
 * There is NO delete route and NO transfer/withdrawal route: this module stores and reads
 * destination data only. Super Admin's masked read and the explicit reveal live in
 * super-admin.route.ts, under that router's SUPER_ADMIN gate.
 */
export const createPayoutDestinationRoute = (): Router => {
  const router = Router({ mergeParams: true });

  const service = new PayoutDestinationService(
    new BusinessRepository(),
    new UserRepository(),
    new PayoutDestinationRepository(),
    new PayoutDestinationStepUpRepository(),
    new Argon2PasswordHasher(),
    createEmailOtpProvider(),
  );
  const controller = new PayoutDestinationController(service);

  // Same per-IP budgets as the auth module's own OTP send/verify limiters.
  const otpSendLimiter = payoutStepUpRateLimit(env.AUTH_OTP_SEND_RATE_LIMIT_MAX, 60 * 60 * 1000);
  const otpVerifyLimiter = payoutStepUpRateLimit(env.AUTH_OTP_VERIFY_RATE_LIMIT_MAX);

  router.get(
    "/:businessId/payout-destination",
    validateRequest({ params: payoutDestinationBusinessParamsSchema }),
    asyncHandler(controller.get),
  );

  // Create-or-replace, one handler. No POST/PUT/DELETE variants.
  router.patch(
    "/:businessId/payout-destination",
    validateRequest({
      params: payoutDestinationBusinessParamsSchema,
      body: updatePayoutDestinationBodySchema,
    }),
    asyncHandler(controller.update),
  );

  // --- OAuth-only Owner step-up (a password account uses `stepUp.currentPassword` instead and
  // is rejected by these two endpoints) ---
  router.post(
    "/:businessId/payout-destination/step-up/otp/request",
    otpSendLimiter,
    validateRequest({
      params: payoutDestinationBusinessParamsSchema,
      body: requestPayoutStepUpOtpBodySchema,
    }),
    asyncHandler(controller.requestStepUpOtp),
  );
  router.post(
    "/:businessId/payout-destination/step-up/otp/verify",
    otpVerifyLimiter,
    validateRequest({
      params: payoutDestinationBusinessParamsSchema,
      body: verifyPayoutStepUpOtpBodySchema,
    }),
    asyncHandler(controller.verifyStepUpOtp),
  );

  return router;
};

/** Reused by super-admin.route.ts for the reveal endpoint — see its own env var comment. */
export const superAdminPayoutRevealRateLimit = () =>
  payoutStepUpRateLimit(env.SUPER_ADMIN_PAYOUT_REVEAL_RATE_LIMIT_MAX);
