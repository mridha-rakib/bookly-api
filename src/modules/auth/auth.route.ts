import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessService } from "../business/business.service.js";
import { BusinessAccessRepository } from "../business/business-access.repository.js";
import { BusinessLinkVerificationRepository } from "../business/business-link-verification.repository.js";
import { BusinessOnboardingRepository } from "../business-onboarding/business-onboarding.repository.js";
import { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { createEmailOtpProvider } from "../verification/email-otp.provider.js";
import { createPhoneOtpProvider } from "../verification/phone-otp.provider.js";
import { AuthController } from "./auth.controller.js";
import { createAuthenticateAccessTokenMiddleware, requireActiveUser } from "./auth.middleware.js";
import {
  businessDetailsBodySchema,
  categorySelectionBodySchema,
  entryBodySchema,
  loginBodySchema,
  professionalEntryBodySchema,
  profileBodySchema,
  progressQuerySchema,
  sessionBodySchema,
  verifyEmailOtpBodySchema,
  verifyPhoneOtpBodySchema,
  visitTypeBodySchema,
} from "./auth.schema.js";
import { AuthService } from "./auth.service.js";
import { Argon2PasswordHasher } from "./password-hasher.js";
import { TokenService } from "./token.service.js";

const authRateLimit = (limit: number, windowMs = 15 * 60 * 1000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many authentication requests"),
  });

export const createAuthRoute = (): Router => {
  const router = Router();
  const userRepository = new UserRepository();
  const registrationSessionRepository = new RegistrationSessionRepository();
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
  const businessOnboardingRepository = new BusinessOnboardingRepository();
  const businessOnboardingService = new BusinessOnboardingService(businessOnboardingRepository);
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authService = new AuthService(
    userRepository,
    registrationSessionRepository,
    businessOnboardingRepository,
    businessOnboardingService,
    businessRepository,
    new Argon2PasswordHasher(),
    createEmailOtpProvider(),
    createPhoneOtpProvider(),
    tokenService,
    businessService,
  );
  const controller = new AuthController(authService);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const entryLimiter = authRateLimit(env.AUTH_ENTRY_RATE_LIMIT_MAX);
  const loginLimiter = authRateLimit(env.AUTH_LOGIN_RATE_LIMIT_MAX);
  const otpSendLimiter = authRateLimit(env.AUTH_OTP_SEND_RATE_LIMIT_MAX, 60 * 60 * 1000);
  const otpVerifyLimiter = authRateLimit(env.AUTH_OTP_VERIFY_RATE_LIMIT_MAX);
  const refreshLimiter = authRateLimit(env.AUTH_REFRESH_RATE_LIMIT_MAX);

  router.post(
    "/customer/entry",
    entryLimiter,
    validateRequest({ body: entryBodySchema }),
    asyncHandler(controller.customerEntry),
  );
  router.post(
    "/professional/entry",
    entryLimiter,
    validateRequest({ body: professionalEntryBodySchema }),
    asyncHandler(controller.professionalEntry),
  );
  router.post(
    "/customer/login",
    loginLimiter,
    validateRequest({ body: loginBodySchema }),
    asyncHandler(controller.customerLogin),
  );
  router.post(
    "/professional/login",
    loginLimiter,
    validateRequest({ body: loginBodySchema }),
    asyncHandler(controller.professionalLogin),
  );
  router.post(
    "/super-admin/login",
    loginLimiter,
    validateRequest({ body: loginBodySchema }),
    asyncHandler(controller.superAdminLogin),
  );

  router.post(
    "/customer/register/send-email-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendEmailOtp),
  );
  router.post(
    "/customer/register/resend-email-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendEmailOtp),
  );
  router.post(
    "/customer/register/verify-email-otp",
    otpVerifyLimiter,
    validateRequest({ body: verifyEmailOtpBodySchema }),
    asyncHandler(controller.verifyEmailOtp),
  );
  router.post(
    "/customer/register/profile",
    validateRequest({ body: profileBodySchema }),
    asyncHandler(controller.submitProfile),
  );
  router.post(
    "/customer/register/send-phone-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendPhoneOtp),
  );
  router.post(
    "/customer/register/resend-phone-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendPhoneOtp),
  );
  router.post(
    "/customer/register/verify-phone-otp-complete",
    otpVerifyLimiter,
    validateRequest({ body: verifyPhoneOtpBodySchema }),
    asyncHandler(controller.completeCustomer),
  );
  router.get(
    "/customer/register/progress",
    validateRequest({ query: progressQuerySchema }),
    asyncHandler(controller.progress),
  );

  router.post(
    "/professional/register/visit-type",
    validateRequest({ body: visitTypeBodySchema }),
    asyncHandler(controller.saveVisitType),
  );
  router.post(
    "/professional/register/send-email-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendEmailOtp),
  );
  router.post(
    "/professional/register/resend-email-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendEmailOtp),
  );
  router.post(
    "/professional/register/verify-email-otp",
    otpVerifyLimiter,
    validateRequest({ body: verifyEmailOtpBodySchema }),
    asyncHandler(controller.verifyEmailOtp),
  );
  router.post(
    "/professional/register/profile",
    validateRequest({ body: profileBodySchema }),
    asyncHandler(controller.submitProfile),
  );
  router.post(
    "/professional/register/send-phone-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendPhoneOtp),
  );
  router.post(
    "/professional/register/resend-phone-otp",
    otpSendLimiter,
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.sendPhoneOtp),
  );
  router.post(
    "/professional/register/verify-phone-otp",
    otpVerifyLimiter,
    validateRequest({ body: verifyPhoneOtpBodySchema }),
    asyncHandler(controller.verifyProfessionalPhone),
  );
  router.post(
    "/professional/register/business-details",
    validateRequest({ body: businessDetailsBodySchema }),
    asyncHandler(controller.saveBusinessDetails),
  );
  router.post(
    "/professional/register/categories",
    validateRequest({ body: categorySelectionBodySchema }),
    asyncHandler(controller.saveCategories),
  );
  router.post(
    "/professional/register/complete",
    validateRequest({ body: sessionBodySchema }),
    asyncHandler(controller.completeBusinessOwner),
  );
  router.get(
    "/professional/register/progress",
    validateRequest({ query: progressQuerySchema }),
    asyncHandler(controller.progress),
  );

  router.post("/refresh", refreshLimiter, asyncHandler(controller.refresh));
  router.post("/logout", asyncHandler(controller.logout));
  router.get("/me", authenticate, requireActiveUser(), asyncHandler(controller.me));

  return router;
};
