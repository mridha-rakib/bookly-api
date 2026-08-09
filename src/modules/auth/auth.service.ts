import mongoose, { type ClientSession, Types } from "mongoose";
import { env } from "../../config/env.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessOnboardingRepository } from "../business-onboarding/business-onboarding.repository.js";
import type { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import type {
  RegistrationPortal,
  RegistrationSessionDocument,
} from "../registration-session/registration-session.model.js";
import type { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import { professionalRoles, type UserRole } from "../user/user.types.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import type { PhoneOtpProvider } from "../verification/phone-otp.provider.js";
import { AuthError } from "./auth.errors.js";
import type {
  BusinessDetailsBody,
  CategorySelectionBody,
  EntryBody,
  LoginBody,
  ProfessionalEntryBody,
  ProfileBody,
  VerifyEmailOtpBody,
  VerifyPhoneOtpBody,
  VisitTypeBody,
} from "./auth.schema.js";
import {
  addMinutes,
  generateNumericOtp,
  normalizeEmail,
  normalizePhoneNumber,
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

    this.assertResendAllowed(
      session.phoneVerification.resendTimestamps,
      session.phoneVerification.sentAt,
    );
    const result = await this.phoneOtpProvider.sendOtp({ toE164: session.phone.e164 });
    const now = new Date();
    session.phoneVerification.sentAt = now;
    if (result.providerVerificationId) {
      session.phoneVerification.providerVerificationId = result.providerVerificationId;
    }
    session.phoneVerification.resendTimestamps = this.pruneRecentResends([
      ...session.phoneVerification.resendTimestamps,
      now,
    ]);
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
    return this.completeCustomer(session, context);
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
        const business = await this.businessRepository.create(
          {
            ownerUserId: user._id,
            name: businessDetails.businessName,
            ownerName: businessDetails.ownerName,
            email: session.normalizedEmail,
            phone: businessDetails.phone,
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

    return authResult;
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
    const business =
      user.role === "BUSINESS_OWNER"
        ? await this.businessRepository.findByOwnerUserId(user._id)
        : null;

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
    this.assertResendAllowed(
      session.emailVerification.resendTimestamps,
      session.emailVerification.sentAt,
    );

    const code = generateNumericOtp(env.OTP_LENGTH);
    await this.emailOtpProvider.sendOtp({ to: session.normalizedEmail, code });

    const now = new Date();
    session.emailVerification.otpHash = this.hashOtp(session, code);
    session.emailVerification.otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);
    session.emailVerification.sentAt = now;
    session.emailVerification.resendTimestamps = this.pruneRecentResends([
      ...session.emailVerification.resendTimestamps,
      now,
    ]);
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

  private assertResendAllowed(timestamps: Date[], sentAt?: Date): void {
    const now = new Date();

    if (sentAt && now.getTime() - sentAt.getTime() < env.OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      throw new AuthError("OTP_RESEND_COOLDOWN", 429);
    }

    if (this.pruneRecentResends(timestamps).length >= env.OTP_MAX_RESENDS_PER_HOUR) {
      throw new AuthError("OTP_RESEND_LIMIT_EXCEEDED", 429);
    }
  }

  private pruneRecentResends(timestamps: Date[]): Date[] {
    const cutoff = Date.now() - oneHourMs;
    return timestamps.filter((timestamp) => timestamp.getTime() >= cutoff);
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
