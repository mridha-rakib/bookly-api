import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { AppointmentReminderRepository } from "../appointment-reminder/appointment-reminder.repository.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessService } from "../business/business.service.js";
import { BusinessAccessRepository } from "../business/business-access.repository.js";
import { BusinessLinkVerificationRepository } from "../business/business-link-verification.repository.js";
import { BusinessOnboardingRepository } from "../business-onboarding/business-onboarding.repository.js";
import { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import { ClientRepository } from "../client/client.repository.js";
import { ClientIdentityService } from "../client/client-identity.service.js";
import { ContactChangeChallengeRepository } from "../contact-change/contact-change-challenge.repository.js";
import { CustomerAvatarError } from "../customer-avatar/customer-avatar.errors.js";
import { CustomerAvatarService } from "../customer-avatar/customer-avatar.service.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { FavoriteRepository } from "../favorite/favorite.repository.js";
import { BusinessRegisteredNotifier } from "../notification/business-registered.notifier.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import { ReviewRepository } from "../review/review.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { createEmailOtpProvider } from "../verification/email-otp.provider.js";
import { createPhoneOtpProvider } from "../verification/phone-otp.provider.js";
import { AuthController } from "./auth.controller.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "./auth.middleware.js";
import {
  businessDetailsBodySchema,
  categorySelectionBodySchema,
  changeMyPasswordBodySchema,
  deleteMyAccountBodySchema,
  entryBodySchema,
  loginBodySchema,
  professionalEntryBodySchema,
  profileBodySchema,
  progressQuerySchema,
  requestEmailChangeBodySchema,
  requestPhoneChangeBodySchema,
  sessionBodySchema,
  updateMyProfileBodySchema,
  verifyEmailChangeBodySchema,
  verifyEmailOtpBodySchema,
  verifyPhoneChangeBodySchema,
  verifyPhoneOtpBodySchema,
  visitTypeBodySchema,
} from "./auth.schema.js";
import { AuthService } from "./auth.service.js";
import { Argon2PasswordHasher } from "./password-hasher.js";
import { TokenService } from "./token.service.js";

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.CUSTOMER_AVATAR_MAX_UPLOAD_BYTES,
    files: 1,
  },
});

// Single multipart `file` field, mirroring the Staff avatar endpoint. Maps multer's size-limit
// rejection to the same domain error the service raises so the client sees one consistent code.
const uploadSingleAvatarImage: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  avatarUpload.single("file")(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new CustomerAvatarError("CUSTOMER_AVATAR_TOO_LARGE", 413));
      return;
    }

    next(error);
  });
};

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
  const staffRepository = new StaffRepository();
  const clientRepository = new ClientRepository();
  const clientIdentityService = new ClientIdentityService(userRepository, clientRepository);
  const contactChangeChallengeRepository = new ContactChangeChallengeRepository();
  const emailOutboxService = new EmailOutboxService();
  const customerAvatarService = new CustomerAvatarService(
    userRepository,
    createDeferredStorageServiceFromEnv(),
    { maxUploadBytes: env.CUSTOMER_AVATAR_MAX_UPLOAD_BYTES },
  );
  // Account-closure collaborators (DELETE /auth/me). Passed as trailing optional args to
  // AuthService — see its constructor.
  const bookingRepository = new BookingRepository();
  const reviewRepository = new ReviewRepository();
  const favoriteRepository = new FavoriteRepository();
  const appointmentReminderRepository = new AppointmentReminderRepository();
  const customerPaymentProfileRepository = new CustomerPaymentProfileRepository();
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
    staffRepository,
    clientIdentityService,
    contactChangeChallengeRepository,
    new BusinessRegisteredNotifier(emailOutboxService),
    customerAvatarService,
    bookingRepository,
    reviewRepository,
    favoriteRepository,
    appointmentReminderRepository,
    clientRepository,
    customerPaymentProfileRepository,
    emailOutboxService,
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
  // Phase 1 — Super Admin Settings → Admin Account reuses this exact route for name/language
  // edits (schema allow-lists the fields; address/dateOfBirth are CUSTOMER-only sinks the admin
  // UI never sends). BUSINESS_OWNER/SUPERVISOR/STAFF stay excluded.
  router.patch(
    "/me",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER", "SUPER_ADMIN"]),
    validateRequest({ body: updateMyProfileBodySchema }),
    asyncHandler(controller.updateMe),
  );
  // Phase 1 — Super Admin "Change Password" reuses this secure Argon2 verify+rehash path
  // as-is (no session revocation, matching the existing behavior for CUSTOMER).
  router.patch(
    "/me/password",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER", "SUPER_ADMIN"]),
    loginLimiter,
    validateRequest({ body: changeMyPasswordBodySchema }),
    asyncHandler(controller.changeMyPassword),
  );

  // Customer account closure (soft delete + anonymization). CUSTOMER-only; acts on
  // request.auth.userId only. `loginLimiter` caps password brute-forcing through this route,
  // matching /me/password.
  router.delete(
    "/me",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    loginLimiter,
    validateRequest({ body: deleteMyAccountBodySchema }),
    asyncHandler(controller.deleteMe),
  );

  // Customer self-service avatar. CUSTOMER-only (SUPER_ADMIN excluded — no Super Admin avatar
  // surface exists); acts on request.auth.userId only, never a client-supplied id. multer runs
  // after the auth/role gates so an unauthenticated or wrong-role caller is rejected before any
  // multipart body is buffered into memory.
  router.put(
    "/me/avatar",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    uploadSingleAvatarImage,
    asyncHandler(controller.updateMyAvatar),
  );

  // Batch 18 — Customer email/phone self-change. Reuses the same otpSendLimiter/otpVerifyLimiter
  // instances the registration flow already uses rather than inventing a second rate limiter;
  // the per-challenge resend-cooldown/attempt-cap logic (assertOtpResendAllowed, OTP_MAX_
  // VERIFICATION_ATTEMPTS) is the actual per-identity throttle underneath.
  router.post(
    "/me/email/change-request",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    otpSendLimiter,
    validateRequest({ body: requestEmailChangeBodySchema }),
    asyncHandler(controller.requestEmailChange),
  );
  router.post(
    "/me/email/verify",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    otpVerifyLimiter,
    validateRequest({ body: verifyEmailChangeBodySchema }),
    asyncHandler(controller.verifyEmailChange),
  );
  router.post(
    "/me/phone/change-request",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    otpSendLimiter,
    validateRequest({ body: requestPhoneChangeBodySchema }),
    asyncHandler(controller.requestPhoneChange),
  );
  router.post(
    "/me/phone/verify",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    otpVerifyLimiter,
    validateRequest({ body: verifyPhoneChangeBodySchema }),
    asyncHandler(controller.verifyPhoneChange),
  );

  return router;
};
