import mongoose, { type ClientSession, Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessService } from "../business/business.service.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessOnboardingRepository } from "../business-onboarding/business-onboarding.repository.js";
import type { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import type { ClientIdentityService } from "../client/client-identity.service.js";
import type { ContactChangeChallengeRepository } from "../contact-change/contact-change-challenge.repository.js";
import type {
  CustomerAvatarService,
  CustomerAvatarUpload,
} from "../customer-avatar/customer-avatar.service.js";
import type { BusinessRegisteredNotificationPort } from "../notification/business-registered.notifier.js";
import type {
  RegistrationPortal,
  RegistrationSessionDocument,
} from "../registration-session/registration-session.model.js";
import type { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  professionalRoles,
  resolveNotificationPreferences,
  type UserRole,
} from "../user/user.types.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import type { PhoneOtpProvider } from "../verification/phone-otp.provider.js";
import { AuthError } from "./auth.errors.js";
import type {
  BusinessDetailsBody,
  CategorySelectionBody,
  ChangeMyPasswordBody,
  EntryBody,
  LoginBody,
  ProfessionalEntryBody,
  ProfileBody,
  RequestEmailChangeBody,
  RequestPhoneChangeBody,
  UpdateMyProfileBody,
  VerifyEmailChangeBody,
  VerifyEmailOtpBody,
  VerifyPhoneChangeBody,
  VerifyPhoneOtpBody,
  VisitTypeBody,
} from "./auth.schema.js";
import {
  addMinutes,
  assertOtpResendAllowed,
  generateNumericOtp,
  normalizeEmail,
  normalizePhoneNumber,
  pruneRecentTimestamps,
  safeCompare,
  sha256,
} from "./auth.utils.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { TokenService } from "./token.service.js";

type RequestContext = {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

type AuthResult = {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: {
    id: string;
    email: string;
    role: UserRole;
    status: string;
  };
  refreshToken: string;
};

const nextStepValues = {
  PASSWORD_LOGIN: "PASSWORD_LOGIN",
  EMAIL_VERIFICATION: "EMAIL_VERIFICATION",
  PORTAL_MISMATCH: "PORTAL_MISMATCH",
} as const;

const oneHourMs = 60 * 60 * 1000;

export class AuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly registrationSessionRepository: RegistrationSessionRepository,
    private readonly businessOnboardingRepository: BusinessOnboardingRepository,
    private readonly businessOnboardingService: BusinessOnboardingService,
    private readonly businessRepository: BusinessRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly emailOtpProvider: EmailOtpProvider,
    private readonly phoneOtpProvider: PhoneOtpProvider,
    private readonly tokenService: TokenService,
    private readonly businessService: BusinessService,
    private readonly staffRepository: StaffRepository,
    private readonly clientIdentityService: ClientIdentityService,
    private readonly contactChangeChallengeRepository: ContactChangeChallengeRepository,
    // Stage D mailing — optional + trailing (same pattern as the booking services). Enqueues
    // the INTERNAL "new business registration" notification from completeBusinessOwner's
    // post-commit tail. Absent in the auth test/integration construction sites — a safe no-op.
    private readonly businessRegisteredNotifier?: BusinessRegisteredNotificationPort,
    // Customer avatar (PUT /auth/me/avatar + the avatarUrl in getMe). Optional + trailing so
    // the existing auth test/integration construction sites keep working unchanged; when it is
    // absent, getMe simply omits avatarUrl and updateMyAvatar is unreachable (route not wired).
    private readonly customerAvatarService?: CustomerAvatarService,
  ) {}

  public async customerEntry(input: EntryBody) {
    return this.entry("CUSTOMER", normalizeEmail(input.email));
  }

  public async professionalEntry(input: ProfessionalEntryBody) {
    const result = await this.entry("PROFESSIONAL", normalizeEmail(input.email));

    if (result.nextStep === nextStepValues.EMAIL_VERIFICATION && input.visitType) {
      const session = await this.getRegistrationSession(result.sessionId);
      await this.saveProfessionalVisitType({
        sessionId: String(session._id),
        visitType: input.visitType,
      });
    }

    return result;
  }

  public async login(
    portal: "CUSTOMER" | "PROFESSIONAL" | "SUPER_ADMIN",
    input: LoginBody,
    context: RequestContext,
  ): Promise<AuthResult> {
    const normalizedEmail = normalizeEmail(input.email);
    const user = await this.userRepository.findByEmailWithPassword(normalizedEmail);

    if (!user) {
      throw new AuthError("INVALID_CREDENTIALS", 401);
    }

    if (!this.roleMatchesPortal(user.role, portal)) {
      throw new AuthError("PORTAL_MISMATCH", 409);
    }

    const passwordValid = await this.passwordHasher.verify(user.passwordHash, input.password);

    if (!passwordValid) {
      throw new AuthError("INVALID_CREDENTIALS", 401);
    }

    if (user.status === "SUSPENDED") {
      throw new AuthError("USER_SUSPENDED", 403);
    }

    await this.userRepository.updateLastLogin(user._id);
    return this.issueAuthResult(user._id, user.normalizedEmail, user.role, user.status, context);
  }

  public async sendEmailOtp(input: {
    sessionId: string;
  }): Promise<{ sessionId: string; expiresAt: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureStep(session, ["EMAIL_ENTRY", "VISIT_TYPE_SELECTED", "EMAIL_OTP_SENT"]);
    await this.issueEmailOtp(session);
    return {
      sessionId: String(session._id),
      expiresAt: session.emailVerification.otpExpiresAt?.toISOString() ?? "",
    };
  }

  public async verifyEmailOtp(
    input: VerifyEmailOtpBody,
  ): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureStep(session, ["EMAIL_OTP_SENT"]);

    if (!session.emailVerification.otpHash || !session.emailVerification.otpExpiresAt) {
      throw new AuthError("OTP_INVALID", 400);
    }

    if (session.emailVerification.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    if (session.emailVerification.otpExpiresAt <= new Date()) {
      throw new AuthError("OTP_EXPIRED", 400);
    }

    const submittedHash = this.hashOtp(session, input.code);

    if (!safeCompare(submittedHash, session.emailVerification.otpHash)) {
      session.emailVerification.attempts += 1;
      await this.registrationSessionRepository.save(session);
      throw new AuthError("OTP_INVALID", 400);
    }

    session.emailVerification.verifiedAt = new Date();
    session.emailVerification.otpHash = undefined;
    session.currentStep = "EMAIL_VERIFIED";
    await this.registrationSessionRepository.save(session);

    return { sessionId: String(session._id), nextStep: "PROFILE" };
  }

  public async submitProfile(input: ProfileBody): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureStep(session, ["EMAIL_VERIFIED"]);

    if (!session.emailVerification.verifiedAt) {
      throw new AuthError("EMAIL_NOT_VERIFIED", 400);
    }

    const nationalNumber = input.nationalNumber ?? input.phone;

    if (!nationalNumber) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 400, [
        { path: "nationalNumber", message: "Phone number is required", code: "required" },
      ]);
    }

    session.personalProfile = {
      firstName: input.firstName,
      lastName: input.lastName,
      gender: input.gender,
    };
    session.phone = normalizePhoneNumber(input.countryCode, nationalNumber);
    session.passwordHash = await this.passwordHasher.hash(input.password);
    if (input.agreeTerms !== false) {
      session.termsAcceptedAt = new Date();
    }
    if (input.termsVersion) {
      session.termsVersion = input.termsVersion;
    }
    session.currentStep = "PROFILE_SUBMITTED";
    await this.registrationSessionRepository.save(session);

    return { sessionId: String(session._id), nextStep: "PHONE_VERIFICATION" };
  }

  public async sendPhoneOtp(input: { sessionId: string }): Promise<{ sessionId: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureStep(session, ["PROFILE_SUBMITTED", "PHONE_OTP_SENT"]);

    if (!session.phone) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 400);
    }

    assertOtpResendAllowed(
      session.phoneVerification.resendTimestamps,
      session.phoneVerification.sentAt,
    );
    const result = await this.phoneOtpProvider.sendOtp({ toE164: session.phone.e164 });
    const now = new Date();
    session.phoneVerification.sentAt = now;
    if (result.providerVerificationId) {
      session.phoneVerification.providerVerificationId = result.providerVerificationId;
    }
    session.phoneVerification.resendTimestamps = pruneRecentTimestamps(
      [...session.phoneVerification.resendTimestamps, now],
      oneHourMs,
    );
    session.phoneVerification.attempts = 0;
    session.currentStep = "PHONE_OTP_SENT";
    await this.registrationSessionRepository.save(session);

    return { sessionId: String(session._id) };
  }

  public async verifyCustomerPhoneAndComplete(
    input: VerifyPhoneOtpBody,
    context: RequestContext,
  ): Promise<AuthResult> {
    const existingSession = await this.getRegistrationSessionForCompletion(input.sessionId);

    if (existingSession.currentStep === "COMPLETED") {
      throw new AuthError("REGISTRATION_ALREADY_COMPLETED", 409);
    }

    const session = await this.verifyPhoneOtp(input);
    const authResult = await this.completeCustomer(session, context);

    // Best-effort, post-commit — see client-identity.service.ts. Never blocks registration:
    // an ambiguous/failed match just leaves existing Business Client rows exactly as they
    // were (still UNLINKED), nothing here is allowed to fail the response the user is waiting on.
    if (session.phone?.e164) {
      this.clientIdentityService
        .linkEligibleClientsForNewCustomer({
          userId: new Types.ObjectId(authResult.user.id),
          normalizedEmail: authResult.user.email,
          phoneE164: session.phone.e164,
        })
        .catch((error: unknown) => {
          logger.error(
            { err: error, userId: authResult.user.id },
            "Client identity linking failed",
          );
        });
    }

    return authResult;
  }

  public async verifyProfessionalPhone(
    input: VerifyPhoneOtpBody,
  ): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.verifyPhoneOtp(input);
    session.currentStep = "PHONE_VERIFIED";
    await this.registrationSessionRepository.save(session);
    return { sessionId: String(session._id), nextStep: "BUSINESS_DETAILS" };
  }

  public async saveProfessionalVisitType(
    input: VisitTypeBody,
  ): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureProfessionalSession(session);
    this.ensureStep(session, ["EMAIL_ENTRY", "VISIT_TYPE_SELECTED"]);
    session.businessVisitType = input.visitType;
    session.currentStep = "VISIT_TYPE_SELECTED";
    const draft = await this.businessOnboardingService.saveVisitType(session._id, input.visitType);
    session.businessOnboardingDraftId = draft._id;
    await this.registrationSessionRepository.save(session);
    return { sessionId: String(session._id), nextStep: "EMAIL_VERIFICATION" };
  }

  public async saveBusinessDetails(
    input: BusinessDetailsBody,
  ): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureProfessionalSession(session);
    this.ensureStep(session, ["PHONE_VERIFIED", "BUSINESS_DETAILS_SUBMITTED"]);
    const draft = await this.businessOnboardingService.saveBusinessDetails(session._id, input);
    session.businessOnboardingDraftId = draft._id;
    session.currentStep = "BUSINESS_DETAILS_SUBMITTED";
    await this.registrationSessionRepository.save(session);
    return { sessionId: String(session._id), nextStep: "CATEGORIES" };
  }

  public async saveCategories(
    input: CategorySelectionBody,
  ): Promise<{ sessionId: string; nextStep: string }> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureProfessionalSession(session);
    this.ensureStep(session, ["BUSINESS_DETAILS_SUBMITTED", "CATEGORIES_SUBMITTED"]);
    const draft = await this.businessOnboardingService.saveCategories(session._id, input);
    session.businessOnboardingDraftId = draft._id;
    session.currentStep = "CATEGORIES_SUBMITTED";
    await this.registrationSessionRepository.save(session);
    return { sessionId: String(session._id), nextStep: "COMPLETE" };
  }

  public async completeBusinessOwner(
    input: { sessionId: string },
    context: RequestContext,
  ): Promise<AuthResult & { business: { id: string; status: string } }> {
    const session = await this.getRegistrationSessionForCompletion(input.sessionId);

    if (session.completedUserId) {
      throw new AuthError("REGISTRATION_ALREADY_COMPLETED", 409);
    }

    this.ensureProfessionalSession(session);
    this.ensureStep(session, ["CATEGORIES_SUBMITTED"]);
    this.ensureFinalCommonData(session);

    const draft = await this.businessOnboardingRepository.findByRegistrationSessionId(session._id);

    const businessDetails = draft?.businessDetails;
    const categorySelection = draft?.categorySelection;
    const businessVisitType = session.businessVisitType;

    if (!businessDetails || !categorySelection || !businessVisitType) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 400);
    }

    if (await this.userRepository.findByEmail(session.normalizedEmail)) {
      throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
    }

    const dbSession = await mongoose.startSession();
    let authResult: (AuthResult & { business: { id: string; status: string } }) | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const user = await this.userRepository.create(
          {
            normalizedEmail: session.normalizedEmail,
            passwordHash: session.passwordHash ?? "",
            role: "BUSINESS_OWNER",
            status: "ACTIVE",
            ...(session.emailVerification.verifiedAt
              ? { emailVerifiedAt: session.emailVerification.verifiedAt }
              : {}),
            ...(session.phoneVerification.verifiedAt
              ? { phoneVerifiedAt: session.phoneVerification.verifiedAt }
              : {}),
          },
          dbSession,
        );
        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName: session.personalProfile?.firstName ?? "",
            lastName: session.personalProfile?.lastName ?? "",
            gender: session.personalProfile?.gender ?? "other",
            phone: session.phone ?? businessDetails.phone,
            ...(session.termsAcceptedAt ? { termsAcceptedAt: session.termsAcceptedAt } : {}),
            ...(session.termsVersion ? { termsVersion: session.termsVersion } : {}),
          },
          dbSession,
        );
        const address = {
          city: businessDetails.city,
          area: businessDetails.address.area,
          streetName: businessDetails.address.streetName,
          streetNumber: businessDetails.address.streetNumber,
          ...(businessDetails.address.floorUnit
            ? { floorUnit: businessDetails.address.floorUnit }
            : {}),
          ...(businessDetails.address.aptRoom ? { aptRoom: businessDetails.address.aptRoom } : {}),
        };
        // Owner identity/contact fields must come from the registration session (profile
        // submission + phone-OTP verification), never from the client-supplied business
        // details payload — those fields are still accepted there for backward
        // compatibility (older clients, the persisted draft), but are no longer trusted
        // for the actual Business record. `ensureFinalCommonData` above already
        // guarantees `personalProfile`/`phone` are present at this point.
        const ownerName = [session.personalProfile?.firstName, session.personalProfile?.lastName]
          .filter(Boolean)
          .join(" ");
        const business = await this.businessService.createOwnedBusiness(
          {
            ownerUserId: user._id,
            name: businessDetails.businessName,
            ownerName,
            email: session.normalizedEmail,
            phone: session.phone ?? businessDetails.phone,
            visitType: businessVisitType,
            address,
            ...(businessDetails.location ? { location: businessDetails.location } : {}),
            briefDescription: businessDetails.briefDescription,
            category: categorySelection.category,
            subcategories: categorySelection.subcategories,
          },
          dbSession,
        );
        await this.registrationSessionRepository.markCompleted(
          session._id,
          user._id,
          business._id,
          dbSession,
        );
        authResult = {
          ...(await this.issueAuthResult(
            user._id,
            user.normalizedEmail,
            user.role,
            user.status,
            context,
            dbSession,
          )),
          business: {
            id: String(business._id),
            status: "PENDING",
          },
        };
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new AuthError("DATABASE_TRANSACTION_UNAVAILABLE", 503, [
          {
            message:
              "MongoDB transactions are not available; use a replica set or retry with transaction support enabled.",
            code: "TRANSACTION_UNAVAILABLE",
          },
        ]);
      }
      await this.throwStableDuplicateCompletionError(error, session._id);
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!authResult) {
      throw new Error("Business owner completion failed");
    }

    // Stage D mailing — enqueue the INTERNAL "new business registration" notification strictly
    // AFTER the registration transaction has committed. Best-effort: never throws, so a
    // notification problem cannot undo a successfully registered business.
    await this.dispatchBusinessRegisteredNotification({
      businessId: authResult.business.id,
      status: authResult.business.status,
      businessName: businessDetails.businessName,
      ownerFirstName: session.personalProfile?.firstName,
      ownerLastName: session.personalProfile?.lastName,
      ownerEmail: session.normalizedEmail,
      phone: (session.phone ?? businessDetails.phone)?.e164,
      category: categorySelection.category,
      city: businessDetails.city,
    });

    return authResult;
  }

  private async dispatchBusinessRegisteredNotification(input: {
    businessId: string;
    status: string;
    businessName: string;
    ownerFirstName?: string | undefined;
    ownerLastName?: string | undefined;
    ownerEmail: string;
    phone?: string | undefined;
    category?: string | undefined;
    city?: string | undefined;
  }): Promise<void> {
    if (!this.businessRegisteredNotifier) {
      return;
    }
    const ownerName =
      [input.ownerFirstName, input.ownerLastName].filter(Boolean).join(" ") || input.ownerEmail;
    await this.businessRegisteredNotifier.notifyBusinessRegistered({
      businessId: input.businessId,
      businessName: input.businessName,
      ownerName,
      ownerEmail: input.ownerEmail,
      phone: input.phone,
      category: input.category,
      city: input.city,
      status: input.status,
      registeredAt: new Date(),
    });
  }

  public async refresh(refreshToken: string): Promise<AuthResult> {
    try {
      const rotated = await this.tokenService.rotateRefreshToken(refreshToken);
      const user = await this.userRepository.findById(rotated.userId);

      if (!user) {
        await this.tokenService.revokeRefreshToken(rotated.refreshToken);
        throw new AuthError("SESSION_EXPIRED", 401);
      }

      if (user.status === "SUSPENDED") {
        await this.tokenService.revokeRefreshToken(rotated.refreshToken);
        throw new AuthError("USER_SUSPENDED", 403);
      }

      const accessToken = await this.tokenService.createAccessToken({
        userId: user._id,
        role: user.role,
      });

      return {
        accessToken,
        accessTokenExpiresAt: this.tokenService.getAccessTokenExpiresAt().toISOString(),
        refreshToken: rotated.refreshToken,
        user: {
          id: String(user._id),
          email: user.normalizedEmail,
          role: user.role,
          status: user.status,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message === "REFRESH_TOKEN_REUSED") {
        throw new AuthError("REFRESH_TOKEN_REUSED", 401);
      }

      if (error instanceof Error && error.message === "SESSION_EXPIRED") {
        throw new AuthError("SESSION_EXPIRED", 401);
      }

      throw error;
    }
  }

  public async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) {
      await this.tokenService.revokeRefreshToken(refreshToken);
    }
  }

  public async getMe(userId: string) {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const profile = await this.userRepository.findProfileByUserId(user._id);
    const business = await this.resolveMeBusiness(user._id, user.role);
    const customerProfile =
      user.role === "CUSTOMER"
        ? await this.userRepository.findCustomerProfileByUserId(user._id)
        : null;
    // Ready-to-render URL for the Customer's uploaded avatar (undefined when none / when the
    // avatar service is not wired). Storage stays the source of truth; nothing is cached here.
    const avatarUrl = customerProfile
      ? await this.customerAvatarService?.resolveAvatarUrl(customerProfile)
      : undefined;

    return {
      user: {
        id: String(user._id),
        email: user.normalizedEmail,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
        phoneVerifiedAt: user.phoneVerifiedAt?.toISOString(),
      },
      profile: profile
        ? {
            firstName: profile.firstName,
            lastName: profile.lastName,
            fullName: `${profile.firstName} ${profile.lastName}`.trim(),
            gender: profile.gender,
            phone: profile.phone,
            // Profiles created before this field existed read back as "EN" rather than undefined.
            defaultLanguage: profile.defaultLanguage ?? "EN",
            // Always fully populated: an absent stored sub-doc / sub-field resolves to the
            // product default here, so the frontend never has to know about "absent".
            notifications: resolveNotificationPreferences(profile.notifications),
            address: customerProfile?.address,
            dateOfBirth: customerProfile?.dateOfBirth,
            avatarUrl,
          }
        : null,
      business: business
        ? {
            id: String(business._id),
            name: business.name,
            status: business.status,
            visitType: normalizeBusinessVisitType(business.visitType),
          }
        : null,
    };
  }

  /**
   * Batch 17 — Customer Profile self-edit. Phase 1 — also the Super Admin Settings → Admin
   * Account name/language edit (same route, gated CUSTOMER + SUPER_ADMIN). Allow-lists exactly
   * firstName/lastName/gender/defaultLanguage (UserProfile) and address/dateOfBirth
   * (CustomerProfile — upserted since no signup path ever creates that row; never sent by the
   * Super Admin UI). Deliberately excludes email/phone/role/status/internal IDs; the request
   * schema itself (`.strict()`) already rejects any other field.
   */
  public async updateMyProfile(
    userId: string,
    input: UpdateMyProfileBody,
  ): Promise<Awaited<ReturnType<AuthService["getMe"]>>> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const profile = await this.userRepository.findProfileByUserId(user._id);

    if (!profile) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const { firstName, lastName, gender, defaultLanguage, address, dateOfBirth, notifications } =
      input;

    if (
      firstName !== undefined ||
      lastName !== undefined ||
      gender !== undefined ||
      defaultLanguage !== undefined ||
      notifications !== undefined
    ) {
      await this.userRepository.updateProfile(profile._id, {
        ...(firstName !== undefined ? { firstName } : {}),
        ...(lastName !== undefined ? { lastName } : {}),
        ...(gender !== undefined ? { gender } : {}),
        ...(defaultLanguage !== undefined ? { defaultLanguage } : {}),
        ...(notifications !== undefined ? { notifications } : {}),
      });
    }

    if (address !== undefined || dateOfBirth !== undefined) {
      await this.userRepository.upsertCustomerProfile(user._id, {
        ...(address !== undefined ? { address } : {}),
        ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
      });
    }

    return this.getMe(userId);
  }

  /**
   * Customer self-service avatar upload/replace. The acting user is always the authenticated
   * session user (`userId` from request.auth) — never a client-supplied id. All storage,
   * validation and write-new-then-retire-old logic lives in CustomerAvatarService; this method
   * only delegates and then returns the same full getMe payload the profile mutations return,
   * so the frontend gets the persisted avatarUrl without a second request.
   */
  public async updateMyAvatar(
    userId: string,
    file: CustomerAvatarUpload | undefined,
  ): Promise<Awaited<ReturnType<AuthService["getMe"]>>> {
    if (!this.customerAvatarService) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    await this.customerAvatarService.uploadOrReplaceAvatar(userId, file);

    return this.getMe(userId);
  }

  public async changeMyPassword(userId: string, input: ChangeMyPasswordBody): Promise<void> {
    const user = await this.userRepository.findByIdWithPassword(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const isValid = await this.passwordHasher.verify(user.passwordHash, input.currentPassword);

    if (!isValid) {
      throw new AuthError("INVALID_CURRENT_PASSWORD", 400);
    }

    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    await this.userRepository.updatePasswordHash(user._id, passwordHash);
  }

  /**
   * Batch 18 — step 1 of Customer email self-change. Never touches User.normalizedEmail; only
   * sends an OTP to the NEW address and records the pending challenge. The current verified
   * email remains authoritative (and the only one that can log in) until `verifyEmailChange`
   * succeeds.
   */
  public async requestEmailChange(
    userId: string,
    input: RequestEmailChangeBody,
  ): Promise<{ expiresAt: string }> {
    const user = await this.userRepository.findByIdWithPassword(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    if (!(await this.passwordHasher.verify(user.passwordHash, input.currentPassword))) {
      throw new AuthError("INVALID_CURRENT_PASSWORD", 400);
    }

    const newNormalizedEmail = normalizeEmail(input.newEmail);

    if (newNormalizedEmail === user.normalizedEmail) {
      throw new AuthError("CONTACT_UNCHANGED", 400);
    }

    if (await this.userRepository.findByEmail(newNormalizedEmail)) {
      throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
    }

    const existingChallenge = await this.contactChangeChallengeRepository.findActive(
      user._id,
      "EMAIL_CHANGE",
    );
    assertOtpResendAllowed(existingChallenge?.resendTimestamps ?? [], existingChallenge?.sentAt);

    const code = generateNumericOtp(env.OTP_LENGTH);
    await this.emailOtpProvider.sendOtp({ to: newNormalizedEmail, code, purpose: "EMAIL_CHANGE" });

    const now = new Date();
    const otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);
    await this.contactChangeChallengeRepository.upsertEmailChallenge(user._id, {
      newNormalizedEmail,
      otpHash: this.hashContactChangeOtp(user._id, "EMAIL_CHANGE", newNormalizedEmail, code),
      otpExpiresAt,
      sentAt: now,
      resendTimestamps: pruneRecentTimestamps(
        [...(existingChallenge?.resendTimestamps ?? []), now],
        oneHourMs,
      ),
      expiresAt: otpExpiresAt,
    });

    return { expiresAt: otpExpiresAt.toISOString() };
  }

  /**
   * Batch 18 — step 2. Only on a correct, unexpired, not-already-consumed OTP does the new email
   * actually get committed (atomically, with a fresh `emailVerifiedAt`). Also revokes the
   * Customer's other sessions and best-effort notifies the OLD email address — both confirmed via
   * AskUserQuestion, neither blocks the response if they fail.
   */
  public async verifyEmailChange(
    userId: string,
    input: VerifyEmailChangeBody,
  ): Promise<Awaited<ReturnType<AuthService["getMe"]>>> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const challenge = await this.contactChangeChallengeRepository.findActive(
      user._id,
      "EMAIL_CHANGE",
    );

    if (!challenge?.otpHash || !challenge.otpExpiresAt || !challenge.newNormalizedEmail) {
      throw new AuthError("CONTACT_CHANGE_NOT_FOUND", 400);
    }

    if (challenge.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    if (challenge.otpExpiresAt <= new Date()) {
      throw new AuthError("OTP_EXPIRED", 400);
    }

    const submittedHash = this.hashContactChangeOtp(
      user._id,
      "EMAIL_CHANGE",
      challenge.newNormalizedEmail,
      input.code,
    );

    if (!safeCompare(submittedHash, challenge.otpHash)) {
      await this.contactChangeChallengeRepository.incrementAttempts(challenge._id);
      throw new AuthError("OTP_INVALID", 400);
    }

    // Atomic claim: only the caller that actually deletes the row commits — a concurrent
    // duplicate verify (or a replay of an already-consumed challenge) gets CONTACT_CHANGE_NOT_FOUND.
    const claimed = await this.contactChangeChallengeRepository.claimAndDelete(challenge._id);

    if (!claimed?.newNormalizedEmail) {
      throw new AuthError("CONTACT_CHANGE_NOT_FOUND", 400);
    }

    if (await this.userRepository.findByEmail(claimed.newNormalizedEmail)) {
      throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
    }

    const oldNormalizedEmail = user.normalizedEmail;

    try {
      await this.userRepository.commitEmailChange(user._id, claimed.newNormalizedEmail);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
      }
      throw error;
    }

    await this.tokenService.revokeAllSessionsForUser(user._id);

    this.emailOtpProvider
      .sendNotice({
        to: oldNormalizedEmail,
        subject: "Your Bookly email was changed",
        text: `Your Bookly account email was changed to ${claimed.newNormalizedEmail}. If you didn't make this change, please contact support immediately.`,
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error, userId: String(user._id) },
          "Email-change notice failed to send",
        );
      });

    // linkEligibleClientsForNewCustomer requires the customer's FULL current identity (both
    // fields) — passing only the just-changed email would make it treat every Client row that
    // matches solely on the (unchanged) phone as a partial/IDENTITY_CONFLICT match, corrupting
    // link state that has nothing to do with this email change.
    const profile = await this.userRepository.findProfileByUserId(user._id);
    if (profile?.phone?.e164) {
      this.linkClientIdentityBestEffort(user._id, {
        normalizedEmail: claimed.newNormalizedEmail,
        phoneE164: profile.phone.e164,
      });
    }

    return this.getMe(userId);
  }

  /** Batch 18 — step 1 of Customer phone self-change. Never touches the phone on UserProfile. */
  public async requestPhoneChange(
    userId: string,
    input: RequestPhoneChangeBody,
  ): Promise<{ expiresAt: string }> {
    const user = await this.userRepository.findByIdWithPassword(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    if (!(await this.passwordHasher.verify(user.passwordHash, input.currentPassword))) {
      throw new AuthError("INVALID_CURRENT_PASSWORD", 400);
    }

    const profile = await this.userRepository.findProfileByUserId(user._id);

    if (!profile) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const newPhone = normalizePhoneNumber(input.countryCode, input.nationalNumber);

    if (newPhone.e164 === profile.phone?.e164) {
      throw new AuthError("CONTACT_UNCHANGED", 400);
    }

    const conflict = await this.userRepository.findVerifiedCustomerByPhoneE164(newPhone.e164);
    if (conflict && String(conflict._id) !== String(user._id)) {
      throw new AuthError("PHONE_ALREADY_REGISTERED", 409);
    }

    const existingChallenge = await this.contactChangeChallengeRepository.findActive(
      user._id,
      "PHONE_CHANGE",
    );
    assertOtpResendAllowed(existingChallenge?.resendTimestamps ?? [], existingChallenge?.sentAt);

    const result = await this.phoneOtpProvider.sendOtp({ toE164: newPhone.e164 });

    const now = new Date();
    const expiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);
    await this.contactChangeChallengeRepository.upsertPhoneChallenge(user._id, {
      newPhone,
      providerVerificationId: result.providerVerificationId,
      sentAt: now,
      resendTimestamps: pruneRecentTimestamps(
        [...(existingChallenge?.resendTimestamps ?? []), now],
        oneHourMs,
      ),
      expiresAt,
    });

    return { expiresAt: expiresAt.toISOString() };
  }

  /**
   * Batch 18 — step 2. Twilio Verify owns OTP generation/expiry for phone (see phone-otp.
   * provider.ts), so verification is delegated to it; Bookly only enforces its own local attempt
   * cap and challenge-slot expiry before calling Twilio, matching the registration phone flow.
   * No session revocation / old-contact notice here — phone is not a login credential, unlike
   * email (loginBodySchema is email+password only).
   */
  public async verifyPhoneChange(
    userId: string,
    input: VerifyPhoneChangeBody,
  ): Promise<Awaited<ReturnType<AuthService["getMe"]>>> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const challenge = await this.contactChangeChallengeRepository.findActive(
      user._id,
      "PHONE_CHANGE",
    );

    if (!challenge?.newPhone) {
      throw new AuthError("CONTACT_CHANGE_NOT_FOUND", 400);
    }

    if (challenge.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    if (challenge.expiresAt <= new Date()) {
      throw new AuthError("OTP_EXPIRED", 400);
    }

    const verified = await this.phoneOtpProvider.verifyOtp({
      toE164: challenge.newPhone.e164,
      code: input.code,
    });

    if (!verified) {
      await this.contactChangeChallengeRepository.incrementAttempts(challenge._id);
      throw new AuthError("OTP_INVALID", 400);
    }

    const claimed = await this.contactChangeChallengeRepository.claimAndDelete(challenge._id);

    if (!claimed?.newPhone) {
      throw new AuthError("CONTACT_CHANGE_NOT_FOUND", 400);
    }

    const conflict = await this.userRepository.findVerifiedCustomerByPhoneE164(
      claimed.newPhone.e164,
    );
    if (conflict && String(conflict._id) !== String(user._id)) {
      throw new AuthError("PHONE_ALREADY_REGISTERED", 409);
    }

    const profile = await this.userRepository.findProfileByUserId(user._id);

    if (!profile) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    await this.userRepository.updateProfile(profile._id, { phone: claimed.newPhone });
    await this.userRepository.updatePhoneVerifiedAt(user._id, new Date());

    // Same full-identity requirement as verifyEmailChange above — pass the current (unchanged)
    // email alongside the new phone so unrelated Client rows are never mis-flagged.
    this.linkClientIdentityBestEffort(user._id, {
      normalizedEmail: user.normalizedEmail,
      phoneE164: claimed.newPhone.e164,
    });

    return this.getMe(userId);
  }

  /** Batch 18 — shared salt scheme for the two contact-change OTPs. Deliberately keyed by
   * userId+purpose+target (not a challenge document _id, which doesn't exist yet at issue time)
   * so the same hash can be recomputed identically at both issue and verify time. */
  private hashContactChangeOtp(
    userId: Types.ObjectId,
    purpose: "EMAIL_CHANGE",
    target: string,
    code: string,
  ): string {
    return sha256(`${userId}:${purpose}:${target}:${code}:${env.OTP_HASH_SECRET}`);
  }

  /** Best-effort, post-commit, non-blocking — identical pattern/rationale to
   * verifyCustomerPhoneAndComplete's post-registration linking. A newly-verified contact may now
   * match a Business-owned Client row; an ambiguous/failed match just leaves existing Client rows
   * exactly as they were. Never allowed to fail the change-verification response the user is
   * waiting on. */
  private linkClientIdentityBestEffort(
    userId: Types.ObjectId,
    contact: { normalizedEmail: string; phoneE164: string },
  ): void {
    this.clientIdentityService
      .linkEligibleClientsForNewCustomer({ userId, ...contact })
      .catch((error: unknown) => {
        logger.error({ err: error, userId: String(userId) }, "Client identity linking failed");
      });
  }

  /**
   * BUSINESS_OWNER resolves via Business.ownerUserId directly. SUPERVISOR/STAFF resolve via
   * their active StaffMembership — the same relationship the Client Management domain uses for
   * authorization (see client.service.ts requireBusinessAccess) — so the frontend can finally
   * learn a Supervisor's businessId from this endpoint (previously always null for every
   * non-owner role). CUSTOMER/SUPER_ADMIN have no business context.
   */
  private async resolveMeBusiness(userId: Types.ObjectId, role: UserRole) {
    if (role === "BUSINESS_OWNER") {
      return this.businessRepository.findByOwnerUserId(userId);
    }

    if (role === "SUPERVISOR" || role === "STAFF") {
      const membership = await this.staffRepository.findActiveByUserId(userId);
      if (!membership) {
        return null;
      }
      return this.businessRepository.findById(membership.businessId);
    }

    return null;
  }

  public async getProgress(sessionId: string) {
    const session = await this.getRegistrationSessionForCompletion(sessionId);
    return {
      sessionId: String(session._id),
      portal: session.portal,
      intendedRole: session.intendedRole,
      currentStep: session.currentStep,
      emailVerified: Boolean(session.emailVerification.verifiedAt),
      phoneVerified: Boolean(session.phoneVerification.verifiedAt),
      expiresAt: session.expiresAt.toISOString(),
      // Authoritative identity/contact data already captured earlier in registration
      // (profile submission + phone OTP verification), so later steps — e.g. the
      // Business Form — can hydrate read-only fields from the session instead of
      // asking the user to re-enter (or trusting a client-editable) name/phone/email.
      email: session.normalizedEmail,
      ...(session.personalProfile
        ? {
            firstName: session.personalProfile.firstName,
            lastName: session.personalProfile.lastName,
          }
        : {}),
      ...(session.phone
        ? {
            phone: {
              countryCode: session.phone.countryCode,
              nationalNumber: session.phone.nationalNumber,
            },
          }
        : {}),
    };
  }

  private async entry(portal: RegistrationPortal, normalizedEmail: string) {
    const existingUser = await this.userRepository.findByEmail(normalizedEmail);

    if (existingUser) {
      if (
        (portal === "CUSTOMER" && existingUser.role !== "CUSTOMER") ||
        (portal === "PROFESSIONAL" && !professionalRoles.includes(existingUser.role))
      ) {
        return { nextStep: nextStepValues.PORTAL_MISMATCH };
      }

      return { nextStep: nextStepValues.PASSWORD_LOGIN };
    }

    const session = await this.registrationSessionRepository.createOrReuseActive({
      portal,
      intendedRole: portal === "CUSTOMER" ? "CUSTOMER" : "BUSINESS_OWNER",
      normalizedEmail,
      currentStep: "EMAIL_ENTRY",
      expiresAt: new Date(Date.now() + env.REGISTRATION_SESSION_TTL_HOURS * oneHourMs),
    });

    return {
      nextStep: nextStepValues.EMAIL_VERIFICATION,
      sessionId: String(session._id),
      currentStep: session.currentStep,
    };
  }

  private async issueEmailOtp(session: RegistrationSessionDocument): Promise<void> {
    assertOtpResendAllowed(
      session.emailVerification.resendTimestamps,
      session.emailVerification.sentAt,
    );

    const code = generateNumericOtp(env.OTP_LENGTH);
    await this.emailOtpProvider.sendOtp({ to: session.normalizedEmail, code });

    const now = new Date();
    session.emailVerification.otpHash = this.hashOtp(session, code);
    session.emailVerification.otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);
    session.emailVerification.sentAt = now;
    session.emailVerification.resendTimestamps = pruneRecentTimestamps(
      [...session.emailVerification.resendTimestamps, now],
      oneHourMs,
    );
    session.emailVerification.attempts = 0;
    session.currentStep = "EMAIL_OTP_SENT";
    await this.registrationSessionRepository.save(session);
  }

  private async verifyPhoneOtp(input: VerifyPhoneOtpBody): Promise<RegistrationSessionDocument> {
    const session = await this.getRegistrationSession(input.sessionId);
    this.ensureStep(session, ["PHONE_OTP_SENT"]);

    if (!session.phone) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 400);
    }

    if (session.phoneVerification.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    const verified = await this.phoneOtpProvider.verifyOtp({
      toE164: session.phone.e164,
      code: input.code,
    });

    if (!verified) {
      session.phoneVerification.attempts += 1;
      await this.registrationSessionRepository.save(session);
      throw new AuthError("OTP_INVALID", 400);
    }

    session.phoneVerification.verifiedAt = new Date();
    await this.registrationSessionRepository.save(session);
    return session;
  }

  private async completeCustomer(
    session: RegistrationSessionDocument,
    context: RequestContext,
  ): Promise<AuthResult> {
    if (session.completedUserId) {
      throw new AuthError("REGISTRATION_ALREADY_COMPLETED", 409);
    }

    if (session.intendedRole !== "CUSTOMER") {
      throw new AuthError("PORTAL_MISMATCH", 409);
    }

    this.ensureFinalCommonData(session);

    if (await this.userRepository.findByEmail(session.normalizedEmail)) {
      throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
    }

    const dbSession = await mongoose.startSession();
    let authResult: AuthResult | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const user = await this.userRepository.create(
          {
            normalizedEmail: session.normalizedEmail,
            passwordHash: session.passwordHash ?? "",
            role: "CUSTOMER",
            status: "ACTIVE",
            ...(session.emailVerification.verifiedAt
              ? { emailVerifiedAt: session.emailVerification.verifiedAt }
              : {}),
            ...(session.phoneVerification.verifiedAt
              ? { phoneVerifiedAt: session.phoneVerification.verifiedAt }
              : {}),
          },
          dbSession,
        );
        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName: session.personalProfile?.firstName ?? "",
            lastName: session.personalProfile?.lastName ?? "",
            gender: session.personalProfile?.gender ?? "other",
            phone: session.phone ?? { countryCode: "", nationalNumber: "", e164: "" },
            ...(session.termsAcceptedAt ? { termsAcceptedAt: session.termsAcceptedAt } : {}),
            ...(session.termsVersion ? { termsVersion: session.termsVersion } : {}),
          },
          dbSession,
        );
        await this.registrationSessionRepository.markCompleted(
          session._id,
          user._id,
          undefined,
          dbSession,
        );
        authResult = await this.issueAuthResult(
          user._id,
          user.normalizedEmail,
          user.role,
          user.status,
          context,
          dbSession,
        );
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new AuthError("DATABASE_TRANSACTION_UNAVAILABLE", 503, [
          {
            message:
              "MongoDB transactions are not available; use a replica set or retry with transaction support enabled.",
            code: "TRANSACTION_UNAVAILABLE",
          },
        ]);
      }
      await this.throwStableDuplicateCompletionError(error, session._id);
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!authResult) {
      throw new Error("Customer completion failed");
    }

    return authResult;
  }

  private async issueAuthResult(
    userId: Types.ObjectId,
    email: string,
    role: UserRole,
    status: string,
    context: RequestContext,
    session?: ClientSession,
  ): Promise<AuthResult> {
    const accessToken = await this.tokenService.createAccessToken({ userId, role });
    const refreshInput = {
      userId,
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
    };
    const refreshSession = await this.tokenService.createRefreshSession(refreshInput, session);

    return {
      accessToken,
      accessTokenExpiresAt: this.tokenService.getAccessTokenExpiresAt().toISOString(),
      refreshToken: refreshSession.refreshToken,
      user: {
        id: String(userId),
        email,
        role,
        status,
      },
    };
  }

  private async getRegistrationSession(sessionId: string): Promise<RegistrationSessionDocument> {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new AuthError("REGISTRATION_SESSION_EXPIRED", 410);
    }

    const session = await this.registrationSessionRepository.findActiveById(sessionId);

    if (!session) {
      throw new AuthError("REGISTRATION_SESSION_EXPIRED", 410);
    }

    return session;
  }

  private async getRegistrationSessionForCompletion(
    sessionId: string,
  ): Promise<RegistrationSessionDocument> {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new AuthError("REGISTRATION_SESSION_EXPIRED", 410);
    }

    const session = await this.registrationSessionRepository.findCompletableById(sessionId);

    if (!session) {
      throw new AuthError("REGISTRATION_SESSION_EXPIRED", 410);
    }

    return session;
  }

  private ensureStep(session: RegistrationSessionDocument, allowedSteps: string[]): void {
    if (!allowedSteps.includes(session.currentStep)) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 409);
    }
  }

  private ensureProfessionalSession(session: RegistrationSessionDocument): void {
    if (session.portal !== "PROFESSIONAL" || session.intendedRole !== "BUSINESS_OWNER") {
      throw new AuthError("PORTAL_MISMATCH", 409);
    }
  }

  private ensureFinalCommonData(session: RegistrationSessionDocument): void {
    if (!session.emailVerification.verifiedAt) {
      throw new AuthError("EMAIL_NOT_VERIFIED", 400);
    }

    if (!session.phoneVerification.verifiedAt) {
      throw new AuthError("PHONE_NOT_VERIFIED", 400);
    }

    if (!session.personalProfile || !session.phone || !session.passwordHash) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 409);
    }
  }

  private roleMatchesPortal(
    role: UserRole,
    portal: "CUSTOMER" | "PROFESSIONAL" | "SUPER_ADMIN",
  ): boolean {
    if (portal === "CUSTOMER") {
      return role === "CUSTOMER";
    }

    if (portal === "PROFESSIONAL") {
      return professionalRoles.includes(role);
    }

    return role === "SUPER_ADMIN";
  }

  private hashOtp(session: RegistrationSessionDocument, code: string): string {
    return sha256(`${session._id}:${session.normalizedEmail}:${code}:${env.OTP_HASH_SECRET}`);
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }

  private async throwStableDuplicateCompletionError(
    error: unknown,
    sessionId: Types.ObjectId,
  ): Promise<void> {
    if (!this.isDuplicateKeyError(error)) {
      return;
    }

    const latestSession = await this.registrationSessionRepository.findCompletableById(sessionId);

    if (latestSession?.completedUserId) {
      throw new AuthError("REGISTRATION_ALREADY_COMPLETED", 409);
    }

    throw new AuthError("EMAIL_ALREADY_REGISTERED", 409);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
