import express from "express";
import mongoose, { type ClientSession } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { AuthError } from "../../../src/modules/auth/auth.errors.js";
import {
  businessDetailsBodySchema,
  categorySelectionBodySchema,
  professionalEntryBodySchema,
  profileBodySchema,
  verifyEmailOtpBodySchema,
  verifyPhoneOtpBodySchema,
} from "../../../src/modules/auth/auth.schema.js";
import { AuthService } from "../../../src/modules/auth/auth.service.js";
import { sha256 } from "../../../src/modules/auth/auth.utils.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessService } from "../../../src/modules/business/business.service.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessLinkVerificationRepository } from "../../../src/modules/business/business-link-verification.repository.js";
import { BusinessOnboardingRepository } from "../../../src/modules/business-onboarding/business-onboarding.repository.js";
import { BusinessOnboardingService } from "../../../src/modules/business-onboarding/business-onboarding.service.js";
import {
  type RegistrationPortal,
  RegistrationSessionModel,
} from "../../../src/modules/registration-session/registration-session.model.js";
import { RegistrationSessionRepository } from "../../../src/modules/registration-session/registration-session.repository.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import {
  CustomerProfileModel,
  UserModel,
  UserProfileModel,
} from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../../src/modules/verification/email-otp.provider.js";
import type { PhoneOtpProvider } from "../../../src/modules/verification/phone-otp.provider.js";
import { seedSuperAdmin } from "../../../src/scripts/seed-super-admin.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
};

type AuthServiceParts = {
  authService: AuthService;
  emailProvider: CapturingEmailOtpProvider;
  phoneProvider: TestPhoneOtpProvider;
  userRepository: UserRepository;
  sessionRepository: SessionRepository;
};

const context = { userAgent: "vitest", ipAddress: "127.0.0.1" };
const testPassword = "correct-password";

class CapturingEmailOtpProvider implements EmailOtpProvider {
  public lastCode = "";

  public async sendOtp(input: { to: string; code: string }): Promise<void> {
    this.lastCode = input.code;
  }
}

class TestPhoneOtpProvider implements PhoneOtpProvider {
  public async sendOtp(): Promise<{ providerVerificationId?: string }> {
    return { providerVerificationId: "test-verification-id" };
  }

  public async verifyOtp(input: { toE164: string; code: string }): Promise<boolean> {
    return input.code === "1234";
  }
}

class FailingUserProfileRepository extends UserRepository {
  public override async createProfile(
    ..._args: Parameters<UserRepository["createProfile"]>
  ): ReturnType<UserRepository["createProfile"]> {
    throw new Error("forced profile failure");
  }
}

class FailingSessionRepository extends SessionRepository {
  public override async create(
    ..._args: Parameters<SessionRepository["create"]>
  ): ReturnType<SessionRepository["create"]> {
    throw new Error("forced session failure");
  }
}

class FailingBusinessRepository extends BusinessRepository {
  public override async create(
    ..._args: Parameters<BusinessRepository["create"]>
  ): ReturnType<BusinessRepository["create"]> {
    throw new Error("forced business failure");
  }
}

const createAuthService = (
  overrides: {
    userRepository?: UserRepository;
    businessRepository?: BusinessRepository;
    sessionRepository?: SessionRepository;
  } = {},
): AuthServiceParts => {
  const userRepository = overrides.userRepository ?? new UserRepository();
  const registrationSessionRepository = new RegistrationSessionRepository();
  const businessOnboardingRepository = new BusinessOnboardingRepository();
  const businessOnboardingService = new BusinessOnboardingService(businessOnboardingRepository);
  const businessRepository = overrides.businessRepository ?? new BusinessRepository();
  const businessAccessRepository = new BusinessAccessRepository();
  const businessLinkVerificationRepository = new BusinessLinkVerificationRepository();
  const sessionRepository = overrides.sessionRepository ?? new SessionRepository();
  const emailProvider = new CapturingEmailOtpProvider();
  const phoneProvider = new TestPhoneOtpProvider();
  const businessService = new BusinessService(
    businessRepository,
    businessAccessRepository,
    userRepository,
    businessLinkVerificationRepository,
    emailProvider,
  );

  return {
    authService: new AuthService(
      userRepository,
      registrationSessionRepository,
      businessOnboardingRepository,
      businessOnboardingService,
      businessRepository,
      new Argon2PasswordHasher(),
      emailProvider,
      phoneProvider,
      new TokenService(sessionRepository),
      businessService,
    ),
    emailProvider,
    phoneProvider,
    userRepository,
    sessionRepository,
  };
};

const indexesFor = async (model: typeof UserModel): Promise<DbIndex[]> =>
  (await model.collection.indexes()) as DbIndex[];

const assertAuthError = (error: unknown, code: string, statusCode?: number): void => {
  expect(error).toBeInstanceOf(AuthError);
  const authError = error as AuthError;
  expect(authError.details?.[0]?.code).toBe(code);
  if (statusCode) {
    expect(authError.statusCode).toBe(statusCode);
  }
  expect(authError.message).not.toContain("MongoServerError");
};

const completeCustomer = async (
  email: string,
  parts = createAuthService(),
): Promise<
  AuthServiceParts & { sessionId: string; result: Awaited<ReturnType<AuthService["refresh"]>> }
> => {
  const entry = await parts.authService.customerEntry({ email });
  expect(entry.nextStep).toBe("EMAIL_VERIFICATION");
  const sessionId = entry.sessionId ?? "";

  await parts.authService.sendEmailOtp({ sessionId });
  await parts.authService.verifyEmailOtp(
    verifyEmailOtpBodySchema.parse({ sessionId, code: parts.emailProvider.lastCode }),
  );
  await parts.authService.submitProfile(
    profileBodySchema.parse({
      sessionId,
      firstName: "Jane",
      lastName: "Customer",
      gender: "female",
      countryCode: "+357",
      nationalNumber: "99112233",
      password: testPassword,
      agreeTerms: true,
      termsVersion: "2026-08",
    }),
  );
  await parts.authService.sendPhoneOtp({ sessionId });
  const result = await parts.authService.verifyCustomerPhoneAndComplete(
    verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
    context,
  );

  return { ...parts, sessionId, result };
};

const completeBusinessOwner = async (
  email: string,
  visitTypeInput: "location" | "travel" = "location",
  parts = createAuthService(),
): Promise<
  AuthServiceParts & {
    sessionId: string;
    result: Awaited<ReturnType<AuthService["completeBusinessOwner"]>>;
  }
> => {
  const professionalEntry = await parts.authService.professionalEntry(
    professionalEntryBodySchema.parse({ email, visitType: visitTypeInput }),
  );
  expect(professionalEntry.nextStep).toBe("EMAIL_VERIFICATION");
  const sessionId = professionalEntry.sessionId ?? "";

  await parts.authService.sendEmailOtp({ sessionId });
  await parts.authService.verifyEmailOtp(
    verifyEmailOtpBodySchema.parse({ sessionId, code: parts.emailProvider.lastCode }),
  );
  await parts.authService.submitProfile(
    profileBodySchema.parse({
      sessionId,
      firstName: "Blake",
      lastName: "Owner",
      gender: "other",
      countryCode: "+357",
      nationalNumber: "99223344",
      password: testPassword,
      agreeTerms: true,
    }),
  );
  await parts.authService.sendPhoneOtp({ sessionId });
  await parts.authService.verifyProfessionalPhone(
    verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
  );
  await parts.authService.saveBusinessDetails(
    businessDetailsBodySchema.parse({
      sessionId,
      businessName: "Bookly Test Studio",
      ownerName: "Blake Owner",
      city: "Larnaca",
      countryCode: "+357",
      nationalNumber: "99887766",
      area: "Center",
      streetName: "Integration",
      streetNumber: "42",
      briefDesc: "Database backed integration test business",
      coordinates: { lat: 34.9, lng: 33.6 },
      searchQuery: "Larnaca Center",
    }),
  );
  await parts.authService.saveCategories(
    categorySelectionBodySchema.parse({
      sessionId,
      selectedCategory: "Wellness",
      selectedSubcategories: ["Massage", "Spa"],
    }),
  );
  const result = await parts.authService.completeBusinessOwner({ sessionId }, context);

  return { ...parts, sessionId, result };
};

const createSessionDocument = async (
  portal: RegistrationPortal,
  normalizedEmail: string,
  isActive: boolean,
  expiresAt = new Date(Date.now() + 60_000),
) =>
  RegistrationSessionModel.create({
    portal,
    intendedRole: portal === "CUSTOMER" ? "CUSTOMER" : "BUSINESS_OWNER",
    normalizedEmail,
    isActive,
    currentStep: isActive ? "EMAIL_ENTRY" : "COMPLETED",
    emailVerification: { attempts: 0, resendTimestamps: [] },
    phoneVerification: { attempts: 0, resendTimestamps: [] },
    expiresAt,
  });

describe("database-backed authentication integration", () => {
  let databaseName = "";

  beforeAll(async () => {
    databaseName = await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("starts an isolated replica-set database with real transaction support", async () => {
    expect(databaseName).toMatch(/^bookly_auth_/);
    const admin = mongoose.connection.db?.admin();
    const status = await admin?.command({ replSetGetStatus: 1 });
    expect(status?.["ok"]).toBe(1);

    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        await UserModel.create(
          [
            {
              normalizedEmail: "tx-probe@example.com",
              passwordHash: "hash",
              role: "CUSTOMER",
              status: "ACTIVE",
              security: { passwordUpdatedAt: new Date() },
            },
          ],
          { session: dbSession },
        );
      });
    } finally {
      await dbSession.endSession();
    }

    expect(await UserModel.countDocuments({ normalizedEmail: "tx-probe@example.com" })).toBe(1);
  });

  it("creates and enforces user, registration-session, session, and business indexes", async () => {
    const userIndexes = await indexesFor(UserModel);
    const registrationIndexes = (await RegistrationSessionModel.collection.indexes()) as DbIndex[];
    const sessionIndexes = (await SessionModel.collection.indexes()) as DbIndex[];
    const businessIndexes = (await BusinessModel.collection.indexes()) as DbIndex[];

    expect(
      userIndexes.some((index) => index.key["normalizedEmail"] === 1 && index.unique === true),
    ).toBe(true);
    expect(
      registrationIndexes.some(
        (index) =>
          index.key["normalizedEmail"] === 1 &&
          index.key["portal"] === 1 &&
          index.key["isActive"] === 1 &&
          index.unique === true &&
          index.partialFilterExpression?.["isActive"] === true,
      ),
    ).toBe(true);
    expect(
      registrationIndexes.some(
        (index) => index.key["expiresAt"] === 1 && index.expireAfterSeconds === 0,
      ),
    ).toBe(true);
    expect(
      sessionIndexes.some(
        (index) => index.key["expiresAt"] === 1 && index.expireAfterSeconds === 0,
      ),
    ).toBe(true);
    expect(
      sessionIndexes.some((index) => index.key["refreshTokenHash"] === 1 && index.unique === true),
    ).toBe(true);
    expect(businessIndexes.some((index) => index.key["ownerUserId"] === 1)).toBe(true);

    const repository = new UserRepository();
    await repository.create({
      normalizedEmail: "duplicate@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await expect(
      repository.create({
        normalizedEmail: "duplicate@example.com",
        passwordHash: "hash-2",
        role: "CUSTOMER",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ code: 11000 });

    await createSessionDocument("CUSTOMER", "active@example.com", true);
    await expect(
      createSessionDocument("CUSTOMER", "active@example.com", true),
    ).rejects.toMatchObject({ code: 11000 });
    await createSessionDocument("CUSTOMER", "completed@example.com", false);
    await createSessionDocument("CUSTOMER", "completed@example.com", true);

    const expired = await createSessionDocument(
      "CUSTOMER",
      "expired@example.com",
      true,
      new Date(Date.now() - 10_000),
    );
    const active = await new RegistrationSessionRepository().createOrReuseActive({
      portal: "CUSTOMER",
      intendedRole: "CUSTOMER",
      normalizedEmail: "expired@example.com",
      currentStep: "EMAIL_ENTRY",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(active._id.equals(expired._id)).toBe(false);
    expect(
      await RegistrationSessionModel.countDocuments({ normalizedEmail: "expired@example.com" }),
    ).toBe(2);
  });

  it("normalizes duplicate-key errors through the API error envelope", async () => {
    const repository = new UserRepository();
    await repository.create({
      normalizedEmail: "envelope@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    let duplicateError: unknown;
    try {
      await repository.create({
        normalizedEmail: "envelope@example.com",
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
    } catch (error) {
      duplicateError = error;
    }

    const app = express();
    app.get("/duplicate", (_request, _response, next) => next(duplicateError));
    app.use(createErrorHandler({ isProduction: true }));

    const response = await request(app).get("/duplicate").expect(409);
    expect(response.body.errors[0].code).toBe("EMAIL_ALREADY_REGISTERED");
    expect(JSON.stringify(response.body)).not.toContain("normalizedEmail_1");
    expect(JSON.stringify(response.body)).not.toContain("MongoServerError");
  });

  it("completes customer registration transactionally without CustomerProfile or sensitive persistence", async () => {
    const { result, sessionId } = await completeCustomer("customer-db@example.com");

    expect(result.user).toMatchObject({
      email: "customer-db@example.com",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("refreshTokenHash");
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserProfileModel.countDocuments()).toBe(1);
    expect(await CustomerProfileModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(1);

    const user = await UserModel.findOne({ normalizedEmail: "customer-db@example.com" })
      .select("+passwordHash")
      .orFail();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toBe(testPassword);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);

    const completedSession = await RegistrationSessionModel.findById(sessionId)
      .select("+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId")
      .orFail();
    expect(completedSession.currentStep).toBe("COMPLETED");
    expect(completedSession.isActive).toBe(false);
    expect(completedSession.passwordHash).toBeUndefined();
    expect(completedSession.emailVerification.otpHash).toBeUndefined();
    expect(completedSession.phoneVerification.providerVerificationId).toBeUndefined();

    const storedSession = await SessionModel.findOne().select("+refreshTokenHash").orFail();
    expect(storedSession.refreshTokenHash).toHaveLength(64);
    expect(storedSession.refreshTokenHash).not.toBe(result.refreshToken);
    expect(await new Argon2PasswordHasher().verify(user.passwordHash, testPassword)).toBe(true);
  });

  it("rolls back customer completion when profile or initial session creation fails", async () => {
    const profileFailure = await completeCustomer("customer-rollback-profile@example.com", {
      ...createAuthService({ userRepository: new FailingUserProfileRepository() }),
    }).catch((error: unknown) => error);
    expect(profileFailure).toBeInstanceOf(Error);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await UserProfileModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);

    await clearIsolatedDatabase();
    const sessionFailure = await completeCustomer("customer-rollback-session@example.com", {
      ...createAuthService({ sessionRepository: new FailingSessionRepository() }),
    }).catch((error: unknown) => error);
    expect(sessionFailure).toBeInstanceOf(Error);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await UserProfileModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);
  });

  it("rejects repeated and concurrent customer completion without duplicate permanent records", async () => {
    const parts = createAuthService();
    const { sessionId } = await completeCustomer("customer-repeat@example.com", parts);

    await expect(
      parts.authService.verifyCustomerPhoneAndComplete({ sessionId, code: "1234" }, context),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserProfileModel.countDocuments()).toBe(1);
    expect(await SessionModel.countDocuments()).toBe(1);

    await clearIsolatedDatabase();
    const race = createAuthService();
    const entry = await race.authService.customerEntry({ email: "customer-race@example.com" });
    const raceSessionId = entry.sessionId ?? "";
    await race.authService.sendEmailOtp({ sessionId: raceSessionId });
    await race.authService.verifyEmailOtp({
      sessionId: raceSessionId,
      code: race.emailProvider.lastCode,
    });
    await race.authService.submitProfile(
      profileBodySchema.parse({
        sessionId: raceSessionId,
        firstName: "Race",
        lastName: "Customer",
        gender: "other",
        countryCode: "+357",
        nationalNumber: "99110022",
        password: testPassword,
      }),
    );
    await race.authService.sendPhoneOtp({ sessionId: raceSessionId });

    const outcomes = await Promise.allSettled([
      race.authService.verifyCustomerPhoneAndComplete(
        { sessionId: raceSessionId, code: "1234" },
        context,
      ),
      race.authService.verifyCustomerPhoneAndComplete(
        { sessionId: raceSessionId, code: "1234" },
        context,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assertAuthError(
      rejected?.status === "rejected" ? rejected.reason : undefined,
      "REGISTRATION_ALREADY_COMPLETED",
      409,
    );
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserProfileModel.countDocuments()).toBe(1);
    expect(await CustomerProfileModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it("completes Business Owner registration with canonical visit type and no CustomerProfile", async () => {
    const { result } = await completeBusinessOwner("owner-db@example.com", "location");

    expect(result.user).toMatchObject({
      email: "owner-db@example.com",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    expect(result.business.status).toBe("PENDING");
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await UserProfileModel.countDocuments()).toBe(1);
    expect(await CustomerProfileModel.countDocuments()).toBe(0);
    expect(await BusinessModel.countDocuments()).toBe(1);
    expect(await SessionModel.countDocuments()).toBe(1);

    const business = await BusinessModel.findOne().orFail();
    const user = await UserModel.findOne({ normalizedEmail: "owner-db@example.com" }).orFail();
    expect(business.ownerUserId.equals(user._id)).toBe(true);
    expect(business.visitType).toBe("AT_BUSINESS_LOCATION");
    expect(business.status).toBe("PENDING");
    expect(business.category).toBe("Wellness");
    expect(business.subcategories).toEqual(["Massage", "Spa"]);

    await clearIsolatedDatabase();
    await completeBusinessOwner("owner-travel@example.com", "travel");
    const travelBusiness = await BusinessModel.findOne().orFail();
    expect(travelBusiness.visitType).toBe("TRAVEL_TO_CUSTOMER");
  });

  it("ignores client-supplied ownerName/phone in business details and persists the registration session's verified identity instead", async () => {
    const parts = createAuthService();
    const professionalEntry = await parts.authService.professionalEntry(
      professionalEntryBodySchema.parse({
        email: "tamper-test@example.com",
        visitType: "location",
      }),
    );
    const sessionId = professionalEntry.sessionId ?? "";

    await parts.authService.sendEmailOtp({ sessionId });
    await parts.authService.verifyEmailOtp(
      verifyEmailOtpBodySchema.parse({ sessionId, code: parts.emailProvider.lastCode }),
    );
    await parts.authService.submitProfile(
      profileBodySchema.parse({
        sessionId,
        firstName: "Real",
        lastName: "Owner",
        gender: "other",
        countryCode: "+357",
        nationalNumber: "99770011",
        password: testPassword,
      }),
    );
    await parts.authService.sendPhoneOtp({ sessionId });
    await parts.authService.verifyProfessionalPhone(
      verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
    );

    // Simulates a tampered client request (e.g. via DevTools) sending a different owner
    // name and phone than what was verified during signup.
    await parts.authService.saveBusinessDetails(
      businessDetailsBodySchema.parse({
        sessionId,
        businessName: "Tamper Test Studio",
        ownerName: "Fake Owner Name",
        city: "Larnaca",
        countryCode: "+1",
        nationalNumber: "00000000",
        area: "Center",
        streetName: "Tamper",
        streetNumber: "1",
        briefDesc: "Business used to verify identity tampering is ignored",
      }),
    );
    await parts.authService.saveCategories(
      categorySelectionBodySchema.parse({
        sessionId,
        selectedCategory: "Wellness",
        selectedSubcategories: ["Spa"],
      }),
    );
    const result = await parts.authService.completeBusinessOwner({ sessionId }, context);

    const business = await BusinessModel.findOne({ ownerUserId: result.user.id }).orFail();
    expect(business.ownerName).toBe("Real Owner");
    expect(business.ownerName).not.toBe("Fake Owner Name");
    expect(business.phone.countryCode).toBe("+357");
    expect(business.phone.nationalNumber).toBe("99770011");
    expect(business.phone.countryCode).not.toBe("+1");
    expect(business.phone.nationalNumber).not.toBe("00000000");
    expect(business.email).toBe("tamper-test@example.com");
  });

  it("exposes authoritative identity/contact data through registration progress for Business Form hydration", async () => {
    const parts = createAuthService();
    const professionalEntry = await parts.authService.professionalEntry(
      professionalEntryBodySchema.parse({
        email: "progress-test@example.com",
        visitType: "location",
      }),
    );
    const sessionId = professionalEntry.sessionId ?? "";

    await parts.authService.sendEmailOtp({ sessionId });
    await parts.authService.verifyEmailOtp(
      verifyEmailOtpBodySchema.parse({ sessionId, code: parts.emailProvider.lastCode }),
    );

    const beforeProfile = await parts.authService.getProgress(sessionId);
    expect(beforeProfile.email).toBe("progress-test@example.com");
    expect(beforeProfile.firstName).toBeUndefined();
    expect(beforeProfile.phoneVerified).toBe(false);

    await parts.authService.submitProfile(
      profileBodySchema.parse({
        sessionId,
        firstName: "Progress",
        lastName: "Tester",
        gender: "other",
        countryCode: "+357",
        nationalNumber: "99330022",
        password: testPassword,
      }),
    );

    const afterProfile = await parts.authService.getProgress(sessionId);
    expect(afterProfile.firstName).toBe("Progress");
    expect(afterProfile.lastName).toBe("Tester");
    // Phone exists on the session already (captured with the profile) but is not yet
    // OTP-verified, so the frontend must not treat it as authoritative yet.
    expect(afterProfile.phoneVerified).toBe(false);

    await parts.authService.sendPhoneOtp({ sessionId });
    await parts.authService.verifyProfessionalPhone(
      verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
    );

    const afterPhoneVerified = await parts.authService.getProgress(sessionId);
    expect(afterPhoneVerified.phoneVerified).toBe(true);
    expect(afterPhoneVerified.phone).toEqual({ countryCode: "+357", nationalNumber: "99330022" });
    expect(afterPhoneVerified.email).toBe("progress-test@example.com");
  });

  it("rolls back Business Owner completion failures and rejects repeated/concurrent completion", async () => {
    const businessFailure = await completeBusinessOwner(
      "owner-rollback-business@example.com",
      "location",
      {
        ...createAuthService({ businessRepository: new FailingBusinessRepository() }),
      },
    ).catch((error: unknown) => error);
    expect(businessFailure).toBeInstanceOf(Error);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await BusinessModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);

    await clearIsolatedDatabase();
    const profileFailure = await completeBusinessOwner(
      "owner-rollback-profile@example.com",
      "location",
      {
        ...createAuthService({ userRepository: new FailingUserProfileRepository() }),
      },
    ).catch((error: unknown) => error);
    expect(profileFailure).toBeInstanceOf(Error);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await BusinessModel.countDocuments()).toBe(0);

    await clearIsolatedDatabase();
    const sessionFailure = await completeBusinessOwner(
      "owner-rollback-session@example.com",
      "location",
      {
        ...createAuthService({ sessionRepository: new FailingSessionRepository() }),
      },
    ).catch((error: unknown) => error);
    expect(sessionFailure).toBeInstanceOf(Error);
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await BusinessModel.countDocuments()).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);

    await clearIsolatedDatabase();
    const parts = createAuthService();
    const { sessionId } = await completeBusinessOwner(
      "owner-repeat@example.com",
      "location",
      parts,
    );
    await expect(
      parts.authService.completeBusinessOwner({ sessionId }, context),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await BusinessModel.countDocuments()).toBe(1);
    expect(await SessionModel.countDocuments()).toBe(1);

    await clearIsolatedDatabase();
    const race = createAuthService();
    const prepared = await prepareBusinessOwnerForCompletion("owner-race@example.com", race);
    const outcomes = await Promise.allSettled([
      race.authService.completeBusinessOwner({ sessionId: prepared }, context),
      race.authService.completeBusinessOwner({ sessionId: prepared }, context),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assertAuthError(
      rejected?.status === "rejected" ? rejected.reason : undefined,
      "REGISTRATION_ALREADY_COMPLETED",
      409,
    );
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await BusinessModel.countDocuments()).toBe(1);
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it("handles registration-start concurrency and cross-portal permanent email uniqueness", async () => {
    const service = createAuthService().authService;
    const customerStarts = await Promise.allSettled([
      service.customerEntry({ email: "start-race@example.com" }),
      service.customerEntry({ email: "start-race@example.com" }),
    ]);
    expect(customerStarts.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(
      await RegistrationSessionModel.countDocuments({
        normalizedEmail: "start-race@example.com",
        portal: "CUSTOMER",
        isActive: true,
      }),
    ).toBe(1);

    const professionalStarts = await Promise.allSettled([
      service.professionalEntry({ email: "pro-start-race@example.com" }),
      service.professionalEntry({ email: "pro-start-race@example.com" }),
    ]);
    expect(professionalStarts.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(
      await RegistrationSessionModel.countDocuments({
        normalizedEmail: "pro-start-race@example.com",
        portal: "PROFESSIONAL",
        isActive: true,
      }),
    ).toBe(1);

    await service.customerEntry({ email: "dual-temp@example.com" });
    await service.professionalEntry({ email: "dual-temp@example.com" });
    expect(
      await RegistrationSessionModel.countDocuments({ normalizedEmail: "dual-temp@example.com" }),
    ).toBe(2);

    await completeCustomer("cross-portal@example.com");
    await expect(service.professionalEntry({ email: "cross-portal@example.com" })).resolves.toEqual(
      {
        nextStep: "PORTAL_MISMATCH",
      },
    );
  });

  it("rejects expired sessions and invalid persisted step skipping", async () => {
    const expired = await createSessionDocument(
      "CUSTOMER",
      "expired-progress@example.com",
      true,
      new Date(Date.now() - 1_000),
    );
    const service = createAuthService().authService;

    await expect(service.sendEmailOtp({ sessionId: String(expired._id) })).rejects.toMatchObject({
      statusCode: 410,
    });

    const entry = await service.customerEntry({ email: "skip@example.com" });
    await expect(
      service.submitProfile(
        profileBodySchema.parse({
          sessionId: entry.sessionId,
          firstName: "Skip",
          lastName: "Step",
          gender: "other",
          countryCode: "+357",
          nationalNumber: "99112244",
          password: testPassword,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rotates refresh tokens atomically, detects reuse, and revokes the token family", async () => {
    const parts = await completeCustomer("refresh-db@example.com");
    const initialToken = parts.result.refreshToken;

    const refreshed = await parts.authService.refresh(initialToken);
    expect(refreshed.refreshToken).not.toBe(initialToken);
    expect(await SessionModel.countDocuments()).toBe(2);
    expect(await SessionModel.countDocuments({ revokedAt: { $exists: false } })).toBe(1);
    await expect(parts.authService.refresh(initialToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(await SessionModel.countDocuments({ revokedAt: { $exists: false } })).toBe(0);

    await clearIsolatedDatabase();
    const race = await completeCustomer("refresh-race@example.com");
    const outcomes = await Promise.allSettled([
      race.authService.refresh(race.result.refreshToken),
      race.authService.refresh(race.result.refreshToken),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await SessionModel.countDocuments()).toBe(2);
    expect(await SessionModel.countDocuments({ revokedAt: { $exists: false } })).toBe(1);
  });

  it("rejects expired, revoked, suspended, and missing-user refresh with persisted sessions", async () => {
    const parts = await completeCustomer("refresh-states@example.com");
    const user = await UserModel.findOne({
      normalizedEmail: "refresh-states@example.com",
    }).orFail();
    const tokenService = new TokenService(new SessionRepository());
    const expired = await tokenService.createRefreshSession({ userId: user._id });
    await SessionModel.updateOne(
      { refreshTokenHash: sha256(expired.refreshToken) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    await expect(parts.authService.refresh(expired.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });

    const revoked = await tokenService.createRefreshSession({ userId: user._id });
    await tokenService.revokeRefreshToken(revoked.refreshToken);
    await expect(parts.authService.refresh(revoked.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });

    const suspended = await tokenService.createRefreshSession({ userId: user._id });
    await UserModel.updateOne({ _id: user._id }, { $set: { status: "SUSPENDED" } });
    await expect(parts.authService.refresh(suspended.refreshToken)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await SessionModel.countDocuments({ revokedAt: { $exists: false } })).toBeGreaterThan(0);
    expect(
      await SessionModel.countDocuments({
        refreshTokenHash: sha256(suspended.refreshToken),
        revokedAt: { $exists: false },
      }),
    ).toBe(0);

    await UserModel.deleteOne({ _id: user._id });
    const missingUserToken = await tokenService.createRefreshSession({ userId: user._id });
    await expect(parts.authService.refresh(missingUserToken.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(
      await SessionModel.countDocuments({
        refreshTokenHash: sha256(missingUserToken.refreshToken),
        revokedAt: { $exists: false },
      }),
    ).toBe(0);
  });

  it("revokes only the current session on logout, leaving other sessions/users untouched, and is idempotent", async () => {
    const parts = await completeCustomer("logout-current-db@example.com");
    const currentToken = parts.result.refreshToken;
    const user = await UserModel.findOne({
      normalizedEmail: "logout-current-db@example.com",
    }).orFail();

    // A second session for the same user, simulating another logged-in device.
    const tokenService = new TokenService(new SessionRepository());
    const otherDeviceSession = await tokenService.createRefreshSession({ userId: user._id });

    // An unrelated user's session, which logout must never touch.
    const other = await completeCustomer("logout-other-user-db@example.com", parts);
    const otherUserToken = other.result.refreshToken;

    await parts.authService.logout(currentToken);

    expect(
      await SessionModel.findOne({ refreshTokenHash: sha256(currentToken) })
        .select("+refreshTokenHash")
        .orFail(),
    ).toMatchObject({ revokedAt: expect.any(Date) });
    expect(
      await SessionModel.findOne({
        refreshTokenHash: sha256(otherDeviceSession.refreshToken),
      })
        .select("+refreshTokenHash")
        .orFail(),
    ).toMatchObject({ revokedAt: undefined });
    expect(
      await SessionModel.findOne({ refreshTokenHash: sha256(otherUserToken) })
        .select("+refreshTokenHash")
        .orFail(),
    ).toMatchObject({ revokedAt: undefined });

    // The logged-out session cannot be revived through refresh...
    await expect(parts.authService.refresh(currentToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    // ...while the user's other device session remains a valid, independent session.
    await expect(parts.authService.refresh(otherDeviceSession.refreshToken)).resolves.toMatchObject(
      { user: { id: String(user._id) } },
    );

    // Repeated/racing logout calls, and logout without a token, never throw.
    await expect(parts.authService.logout(currentToken)).resolves.toBeUndefined();
    await expect(parts.authService.logout(undefined)).resolves.toBeUndefined();
    await expect(parts.authService.logout("not-a-real-refresh-token")).resolves.toBeUndefined();
  });

  it("database-tests Super Admin seed core behavior without CLI execution or fake phone", async () => {
    const logs: unknown[] = [];
    const logger = { info: (...input: unknown[]) => logs.push(input) };
    const userRepository = new UserRepository();
    const passwordHasher = new Argon2PasswordHasher();
    const config = {
      email: "Admin@Example.com",
      password: "super-secret-password",
      firstName: "Root",
      lastName: "Admin",
    };

    await expect(seedSuperAdmin(config, { userRepository, passwordHasher, logger })).resolves.toBe(
      "created",
    );
    const user = await UserModel.findOne({ normalizedEmail: "admin@example.com" })
      .select("+passwordHash")
      .orFail();
    const profile = await UserProfileModel.findOne({ userId: user._id }).orFail();
    expect(user.role).toBe("SUPER_ADMIN");
    expect(user.status).toBe("ACTIVE");
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toBe(config.password);
    expect(profile.firstName).toBe("Root");
    expect(profile.lastName).toBe("Admin");
    expect(profile.phone?.e164).toBeUndefined();
    expect(profile.phone?.countryCode).toBeUndefined();

    await expect(seedSuperAdmin(config, { userRepository, passwordHasher, logger })).resolves.toBe(
      "already_exists",
    );
    expect(await UserModel.countDocuments()).toBe(1);
    expect((await UserModel.findById(user._id).select("+passwordHash").orFail()).passwordHash).toBe(
      user.passwordHash,
    );

    await clearIsolatedDatabase();
    await userRepository.create({
      normalizedEmail: "admin@example.com",
      passwordHash: "customer-hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await expect(
      seedSuperAdmin(config, { userRepository, passwordHasher, logger }),
    ).rejects.toThrow("non-Super Admin");
    expect((await UserModel.findOne({ normalizedEmail: "admin@example.com" }).orFail()).role).toBe(
      "CUSTOMER",
    );

    await clearIsolatedDatabase();
    await expect(
      seedSuperAdmin(
        { email: "missing@example.com", firstName: "Missing", lastName: "Config" },
        { userRepository, passwordHasher, logger },
      ),
    ).rejects.toThrow("Missing required Super Admin seed environment values");
    expect(await UserModel.countDocuments()).toBe(0);
    expect(JSON.stringify(logs)).not.toContain(config.password);
  });

  it("reports transaction-unavailable behavior through a stable AuthError when sessions cannot transact", async () => {
    const parts = createAuthService();
    const entry = await parts.authService.customerEntry({ email: "no-transaction@example.com" });
    const sessionId = entry.sessionId ?? "";
    await parts.authService.sendEmailOtp({ sessionId });
    await parts.authService.verifyEmailOtp({ sessionId, code: parts.emailProvider.lastCode });
    await parts.authService.submitProfile(
      profileBodySchema.parse({
        sessionId,
        firstName: "No",
        lastName: "Transaction",
        gender: "other",
        countryCode: "+357",
        nationalNumber: "99001122",
        password: testPassword,
      }),
    );
    await parts.authService.sendPhoneOtp({ sessionId });

    const fakeSession = {
      withTransaction: async () => {
        throw new Error("Transaction numbers are only allowed on a replica set member or mongos");
      },
      endSession: async () => undefined,
    } as unknown as ClientSession;
    const startSessionSpy = vi.spyOn(mongoose, "startSession").mockResolvedValueOnce(fakeSession);

    await expect(
      parts.authService.verifyCustomerPhoneAndComplete(
        verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    startSessionSpy.mockRestore();
  });
});

const prepareBusinessOwnerForCompletion = async (
  email: string,
  parts: AuthServiceParts,
): Promise<string> => {
  const professionalEntry = await parts.authService.professionalEntry(
    professionalEntryBodySchema.parse({ email, visitType: "location" }),
  );
  const sessionId = professionalEntry.sessionId ?? "";
  await parts.authService.sendEmailOtp({ sessionId });
  await parts.authService.verifyEmailOtp({ sessionId, code: parts.emailProvider.lastCode });
  await parts.authService.submitProfile(
    profileBodySchema.parse({
      sessionId,
      firstName: "Race",
      lastName: "Owner",
      gender: "other",
      countryCode: "+357",
      nationalNumber: "99004455",
      password: testPassword,
    }),
  );
  await parts.authService.sendPhoneOtp({ sessionId });
  await parts.authService.verifyProfessionalPhone(
    verifyPhoneOtpBodySchema.parse({ sessionId, code: "1234" }),
  );
  await parts.authService.saveBusinessDetails(
    businessDetailsBodySchema.parse({
      sessionId,
      businessName: "Race Studio",
      ownerName: "Race Owner",
      city: "Larnaca",
      countryCode: "+357",
      nationalNumber: "99005566",
      area: "Center",
      streetName: "Race",
      streetNumber: "7",
      briefDesc: "Race business",
    }),
  );
  await parts.authService.saveCategories(
    categorySelectionBodySchema.parse({
      sessionId,
      selectedCategory: "Wellness",
      selectedSubcategories: ["Spa"],
    }),
  );
  return sessionId;
};
