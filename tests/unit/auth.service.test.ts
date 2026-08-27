import mongoose, { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../src/config/env.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { sha256 } from "../../src/modules/auth/auth.utils.js";
import type { PasswordHasher } from "../../src/modules/auth/password-hasher.js";
import type { TokenService } from "../../src/modules/auth/token.service.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessService } from "../../src/modules/business/business.service.js";
import type { BusinessOnboardingRepository } from "../../src/modules/business-onboarding/business-onboarding.repository.js";
import type { BusinessOnboardingService } from "../../src/modules/business-onboarding/business-onboarding.service.js";
import type { ClientIdentityService } from "../../src/modules/client/client-identity.service.js";
import type { ContactChangeChallengeRepository } from "../../src/modules/contact-change/contact-change-challenge.repository.js";
import type { RegistrationSessionRepository } from "../../src/modules/registration-session/registration-session.repository.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import type { EmailOtpProvider } from "../../src/modules/verification/email-otp.provider.js";
import type { PhoneOtpProvider } from "../../src/modules/verification/phone-otp.provider.js";

const createDbSession = () => ({
  withTransaction: vi.fn(async (callback: () => Promise<void>) => {
    await callback();
  }),
  endSession: vi.fn(),
});

const createRegistrationSession = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  portal: "CUSTOMER",
  intendedRole: "CUSTOMER",
  normalizedEmail: "customer@example.com",
  isActive: true,
  currentStep: "PHONE_OTP_SENT",
  emailVerification: { verifiedAt: new Date(), attempts: 0, resendTimestamps: [] },
  phoneVerification: { attempts: 0, resendTimestamps: [] },
  personalProfile: { firstName: "Jane", lastName: "Doe", gender: "female" },
  phone: { countryCode: "+357", nationalNumber: "12345678", e164: "+35712345678" },
  passwordHash: "hashed-password",
  expiresAt: new Date(Date.now() + 60_000),
  save: vi.fn(),
  ...overrides,
});

const createAuthService = (overrides: Record<string, unknown> = {}) => {
  const userRepository = {
    findByEmail: vi.fn().mockResolvedValue(null),
    findByEmailWithPassword: vi.fn(),
    findByIdWithPassword: vi.fn(),
    findById: vi.fn(),
    findManyByIds: vi.fn().mockResolvedValue([]),
    findProfilesByUserIds: vi.fn().mockResolvedValue([]),
    updateLastLogin: vi.fn(),
    updateRole: vi.fn(),
    updateEmail: vi.fn(),
    updateProfile: vi.fn(),
    create: vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      normalizedEmail: "customer@example.com",
      role: "CUSTOMER",
      status: "ACTIVE",
    }),
    createProfile: vi.fn(),
    createCustomerProfile: vi.fn(),
    findCustomerProfileByUserId: vi.fn().mockResolvedValue(null),
    upsertCustomerProfile: vi.fn(),
    updatePasswordHash: vi.fn(),
    commitEmailChange: vi.fn(),
    updatePhoneVerifiedAt: vi.fn(),
    findProfileByUserId: vi.fn(),
    findVerifiedCustomerByEmail: vi.fn().mockResolvedValue(null),
    findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue(null),
    listByRole: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    countByRole: vi.fn().mockResolvedValue(0),
    findRecentlyCreated: vi.fn().mockResolvedValue([]),
    countCreatedByMonth: vi.fn().mockResolvedValue([]),
    ...(overrides["userRepository"] as object | undefined),
  };
  const registrationSessionRepository = {
    create: vi.fn(),
    createOrReuseActive: vi.fn(async (input) => ({
      _id: new Types.ObjectId(),
      currentStep: input.currentStep,
    })),
    findCompletableById: vi.fn().mockResolvedValue(createRegistrationSession()),
    findActiveById: vi.fn().mockResolvedValue(createRegistrationSession()),
    findActiveByEmailAndPortal: vi.fn(),
    save: vi.fn(),
    markCompleted: vi.fn(),
    ...(overrides["registrationSessionRepository"] as object | undefined),
  };
  const businessRepository = {
    create: vi.fn(),
    findByOwnerUserId: vi.fn(),
    ...(overrides["businessRepository"] as object | undefined),
  };
  const businessService = {
    createOwnedBusiness: vi.fn((input: unknown) => businessRepository.create(input)),
    ...(overrides["businessService"] as object | undefined),
  };
  const tokenService = {
    createAccessToken: vi.fn().mockResolvedValue("access-token"),
    createRefreshSession: vi.fn().mockResolvedValue({
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getAccessTokenExpiresAt: vi.fn(() => new Date(Date.now() + 60_000)),
    rotateRefreshToken: vi.fn(),
    revokeRefreshToken: vi.fn(),
    revokeAllSessionsForUser: vi.fn(),
    ...(overrides["tokenService"] as object | undefined),
  };
  const staffRepository = {
    findActiveByUserId: vi.fn().mockResolvedValue(null),
    ...(overrides["staffRepository"] as object | undefined),
  };
  const clientIdentityService = {
    resolveContactLinkState: vi.fn().mockResolvedValue({ linkState: "UNLINKED" }),
    linkEligibleClientsForNewCustomer: vi.fn().mockResolvedValue(undefined),
    ...(overrides["clientIdentityService"] as object | undefined),
  };
  const contactChangeChallengeRepository = {
    findActive: vi.fn().mockResolvedValue(null),
    upsertEmailChallenge: vi.fn(),
    upsertPhoneChallenge: vi.fn(),
    incrementAttempts: vi.fn(),
    claimAndDelete: vi.fn(),
    ...(overrides["contactChangeChallengeRepository"] as object | undefined),
  };

  const passwordHasher = {
    hash: vi.fn().mockResolvedValue("hashed-password"),
    verify: vi.fn().mockResolvedValue(true),
    ...(overrides["passwordHasher"] as object | undefined),
  };
  const emailOtpProvider = {
    sendOtp: vi.fn(),
    sendNotice: vi.fn().mockResolvedValue(undefined),
    ...(overrides["emailOtpProvider"] as object | undefined),
  };
  const phoneOtpProvider = {
    sendOtp: vi.fn().mockResolvedValue({}),
    verifyOtp: vi.fn().mockResolvedValue(true),
    ...(overrides["phoneOtpProvider"] as object | undefined),
  };

  const service = new AuthService(
    userRepository,
    registrationSessionRepository as unknown as RegistrationSessionRepository,
    { findByRegistrationSessionId: vi.fn() } as unknown as BusinessOnboardingRepository,
    {
      saveVisitType: vi.fn(),
      saveBusinessDetails: vi.fn(),
      saveCategories: vi.fn(),
    } as unknown as BusinessOnboardingService,
    businessRepository as unknown as BusinessRepository,
    passwordHasher as unknown as PasswordHasher,
    emailOtpProvider as unknown as EmailOtpProvider,
    phoneOtpProvider as unknown as PhoneOtpProvider,
    tokenService as unknown as TokenService,
    businessService as unknown as BusinessService,
    staffRepository as unknown as StaffRepository,
    clientIdentityService as unknown as ClientIdentityService,
    contactChangeChallengeRepository as unknown as ContactChangeChallengeRepository,
  );

  return {
    service,
    userRepository,
    registrationSessionRepository,
    tokenService,
    businessService,
    staffRepository,
    clientIdentityService,
    passwordHasher,
    contactChangeChallengeRepository,
    emailOtpProvider,
    phoneOtpProvider,
  };
};

describe("AuthService repairs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("branches existing customer and professional users without creating accounts", async () => {
    const owner = {
      _id: new Types.ObjectId(),
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      normalizedEmail: "owner@example.com",
    };
    const { service, userRepository, registrationSessionRepository } = createAuthService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(owner) },
    });

    await expect(service.professionalEntry({ email: "owner@example.com" })).resolves.toEqual({
      nextStep: "PASSWORD_LOGIN",
    });
    await expect(service.customerEntry({ email: "owner@example.com" })).resolves.toEqual({
      nextStep: "PORTAL_MISMATCH",
    });
    expect(userRepository.findByEmail).toHaveBeenCalledTimes(2);
    expect(registrationSessionRepository.createOrReuseActive).not.toHaveBeenCalled();
  });

  it("creates customer account without an empty CustomerProfile and stores Session in transaction", async () => {
    const dbSession = createDbSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(dbSession as unknown as never);
    const { service, userRepository, registrationSessionRepository, tokenService } =
      createAuthService();

    const result = await service.verifyCustomerPhoneAndComplete(
      { sessionId: new Types.ObjectId().toHexString(), code: "1234" },
      {},
    );

    expect(result).toMatchObject({ accessToken: "access-token" });
    expect(userRepository.createCustomerProfile).not.toHaveBeenCalled();
    expect(registrationSessionRepository.markCompleted).toHaveBeenCalled();
    expect(tokenService.createRefreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.any(Types.ObjectId) }),
      dbSession,
    );
  });

  it("triggers best-effort Client identity linking, post-commit, with the new Customer's verified email/phone", async () => {
    const dbSession = createDbSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(dbSession as unknown as never);
    const { service, clientIdentityService } = createAuthService();

    await service.verifyCustomerPhoneAndComplete(
      { sessionId: new Types.ObjectId().toHexString(), code: "1234" },
      {},
    );
    // The linking call is fire-and-forget (never awaited by the caller) — flush microtasks so
    // it has actually run before asserting on it.
    await Promise.resolve();
    await Promise.resolve();

    expect(clientIdentityService.linkEligibleClientsForNewCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedEmail: "customer@example.com",
        phoneE164: "+35712345678",
      }),
    );
  });

  it("still returns a successful registration result even if Client identity linking fails", async () => {
    const dbSession = createDbSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(dbSession as unknown as never);
    const { service } = createAuthService({
      clientIdentityService: {
        linkEligibleClientsForNewCustomer: vi.fn().mockRejectedValue(new Error("boom")),
      },
    });

    // Must not reject and must not block — an ambiguous/failed Client match is never allowed
    // to fail the Customer's own registration.
    await expect(
      service.verifyCustomerPhoneAndComplete(
        { sessionId: new Types.ObjectId().toHexString(), code: "1234" },
        {},
      ),
    ).resolves.toMatchObject({ accessToken: "access-token" });
  });

  it("rejects a completed customer retry without creating duplicate permanent records", async () => {
    const userId = new Types.ObjectId();
    const { service, userRepository, registrationSessionRepository, tokenService } =
      createAuthService({
        registrationSessionRepository: {
          findCompletableById: vi.fn().mockResolvedValue(
            createRegistrationSession({
              currentStep: "COMPLETED",
              completedUserId: userId,
            }),
          ),
        },
        userRepository: {
          findById: vi.fn().mockResolvedValue({
            _id: userId,
            normalizedEmail: "customer@example.com",
            role: "CUSTOMER",
            status: "ACTIVE",
          }),
        },
      });

    await expect(
      service.verifyCustomerPhoneAndComplete(
        { sessionId: new Types.ObjectId().toHexString(), code: "1234" },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(userRepository.create).not.toHaveBeenCalled();
    expect(registrationSessionRepository.markCompleted).not.toHaveBeenCalled();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });

  it("revokes the refresh token backing the current session on logout", async () => {
    const { service, tokenService } = createAuthService();

    await service.logout("a-refresh-token");

    expect(tokenService.revokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith("a-refresh-token");
  });

  it("treats logout without a refresh token as a safe no-op", async () => {
    const { service, tokenService } = createAuthService();

    await expect(service.logout(undefined)).resolves.toBeUndefined();

    expect(tokenService.revokeRefreshToken).not.toHaveBeenCalled();
  });
});

describe("AuthService.updateMyProfile", () => {
  it("allow-lists firstName/lastName/gender to UserProfile and upserts address/dateOfBirth to CustomerProfile", async () => {
    const userId = new Types.ObjectId();
    const profileId = new Types.ObjectId();
    const { service, userRepository } = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue({
          _id: userId,
          normalizedEmail: "customer@example.com",
          role: "CUSTOMER",
          status: "ACTIVE",
        }),
        findProfileByUserId: vi.fn().mockResolvedValue({
          _id: profileId,
          firstName: "Jane",
          lastName: "Doe",
          gender: "female",
        }),
        findCustomerProfileByUserId: vi.fn().mockResolvedValue({
          address: "Limassol, Cyprus",
          dateOfBirth: "1990-01-01",
        }),
      },
    });

    const result = await service.updateMyProfile(userId.toHexString(), {
      firstName: "Janet",
      address: "Nicosia, Cyprus",
    });

    expect(userRepository.updateProfile).toHaveBeenCalledWith(profileId, { firstName: "Janet" });
    expect(userRepository.upsertCustomerProfile).toHaveBeenCalledWith(userId, {
      address: "Nicosia, Cyprus",
    });
    expect(result.profile).toMatchObject({ address: "Limassol, Cyprus" });
  });

  it("rejects updates for a user with no session-backed profile", async () => {
    const userId = new Types.ObjectId();
    const { service } = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue({ _id: userId, role: "CUSTOMER" }),
        findProfileByUserId: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.updateMyProfile(userId.toHexString(), { firstName: "Janet" }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("persists a Super Admin name + defaultLanguage change to UserProfile in one update", async () => {
    const userId = new Types.ObjectId();
    const profileId = new Types.ObjectId();
    const { service, userRepository } = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue({
          _id: userId,
          normalizedEmail: "admin@example.com",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
        }),
        findProfileByUserId: vi.fn().mockResolvedValue({
          _id: profileId,
          firstName: "Root",
          lastName: "Admin",
          gender: "other",
          defaultLanguage: "EN",
        }),
      },
    });

    const result = await service.updateMyProfile(userId.toHexString(), {
      firstName: "Georgino",
      lastName: "Mansour",
      defaultLanguage: "GR",
    });

    expect(userRepository.updateProfile).toHaveBeenCalledWith(profileId, {
      firstName: "Georgino",
      lastName: "Mansour",
      defaultLanguage: "GR",
    });
    expect(userRepository.upsertCustomerProfile).not.toHaveBeenCalled();
    expect(result.profile).toMatchObject({ defaultLanguage: "EN" });
  });
});

describe("AuthService.getMe", () => {
  it("echoes the stored defaultLanguage and defaults legacy profiles to EN", async () => {
    const userId = new Types.ObjectId();
    const withLanguage = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue({
          _id: userId,
          normalizedEmail: "admin@example.com",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
        }),
        findProfileByUserId: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          firstName: "Root",
          lastName: "Admin",
          gender: "other",
          defaultLanguage: "GR",
        }),
      },
    });
    await expect(withLanguage.service.getMe(userId.toHexString())).resolves.toMatchObject({
      profile: { fullName: "Root Admin", defaultLanguage: "GR" },
    });

    const legacy = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue({
          _id: userId,
          normalizedEmail: "admin@example.com",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
        }),
        findProfileByUserId: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          firstName: "Root",
          lastName: "Admin",
          gender: "other",
        }),
      },
    });
    await expect(legacy.service.getMe(userId.toHexString())).resolves.toMatchObject({
      profile: { defaultLanguage: "EN" },
    });
  });
});

describe("AuthService.changeMyPassword", () => {
  it("verifies the current password and stores the new hash", async () => {
    const userId = new Types.ObjectId();
    const { service, userRepository, passwordHasher } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue({ _id: userId, passwordHash: "old-hash" }),
      },
      passwordHasher: {
        verify: vi.fn().mockResolvedValue(true),
        hash: vi.fn().mockResolvedValue("new-hash"),
      },
    });

    await service.changeMyPassword(userId.toHexString(), {
      currentPassword: "old-password",
      newPassword: "new-password",
    });

    expect(passwordHasher.verify).toHaveBeenCalledWith("old-hash", "old-password");
    expect(passwordHasher.hash).toHaveBeenCalledWith("new-password");
    expect(userRepository.updatePasswordHash).toHaveBeenCalledWith(userId, "new-hash");
  });

  it("rejects an incorrect current password without touching the stored hash", async () => {
    const userId = new Types.ObjectId();
    const { service, userRepository } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue({ _id: userId, passwordHash: "old-hash" }),
      },
      passwordHasher: { verify: vi.fn().mockResolvedValue(false) },
    });

    await expect(
      service.changeMyPassword(userId.toHexString(), {
        currentPassword: "wrong-password",
        newPassword: "new-password",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(userRepository.updatePasswordHash).not.toHaveBeenCalled();
  });
});

describe("AuthService.requestEmailChange", () => {
  const userId = new Types.ObjectId();
  const baseUser = {
    _id: userId,
    normalizedEmail: "current@example.com",
    passwordHash: "old-hash",
  };

  it("sends an OTP to the new email without touching the current email", async () => {
    const { service, userRepository, contactChangeChallengeRepository, emailOtpProvider } =
      createAuthService({
        userRepository: { findByIdWithPassword: vi.fn().mockResolvedValue(baseUser) },
      });

    const result = await service.requestEmailChange(userId.toHexString(), {
      currentPassword: "correct-password",
      newEmail: "New@Example.com",
    });

    expect(emailOtpProvider.sendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ to: "new@example.com", purpose: "EMAIL_CHANGE" }),
    );
    expect(contactChangeChallengeRepository.upsertEmailChallenge).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ newNormalizedEmail: "new@example.com" }),
    );
    expect(userRepository.commitEmailChange).not.toHaveBeenCalled();
    expect(result.expiresAt).toBeTruthy();
  });

  it("rejects with the wrong current password and never sends an OTP", async () => {
    const { service, contactChangeChallengeRepository } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue(baseUser),
      },
      passwordHasher: { verify: vi.fn().mockResolvedValue(false) },
    });

    await expect(
      service.requestEmailChange(userId.toHexString(), {
        currentPassword: "wrong-password",
        newEmail: "new@example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(contactChangeChallengeRepository.upsertEmailChallenge).not.toHaveBeenCalled();
  });

  it("rejects requesting a change to the same current email", async () => {
    const { service } = createAuthService({
      userRepository: { findByIdWithPassword: vi.fn().mockResolvedValue(baseUser) },
    });

    await expect(
      service.requestEmailChange(userId.toHexString(), {
        currentPassword: "correct-password",
        newEmail: "current@example.com",
      }),
    ).rejects.toMatchObject({ details: [{ code: "CONTACT_UNCHANGED" }] });
  });

  it("rejects a new email already registered to another account", async () => {
    const { service } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue(baseUser),
        findByEmail: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      },
    });

    await expect(
      service.requestEmailChange(userId.toHexString(), {
        currentPassword: "correct-password",
        newEmail: "taken@example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("AuthService.verifyEmailChange", () => {
  const userId = new Types.ObjectId();
  const challengeId = new Types.ObjectId();
  const baseUser = { _id: userId, normalizedEmail: "current@example.com" };

  const hashChallengeOtp = (code: string) =>
    sha256(`${userId}:EMAIL_CHANGE:new@example.com:${code}:${env.OTP_HASH_SECRET}`);

  const buildChallenge = (code: string, overrides: Record<string, unknown> = {}) => ({
    _id: challengeId,
    newNormalizedEmail: "new@example.com",
    otpHash: hashChallengeOtp(code),
    otpExpiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    ...overrides,
  });

  it("commits the new email, revokes other sessions, and notifies the old email on a correct OTP", async () => {
    const challenge = buildChallenge("1234");

    const {
      service,
      userRepository,
      tokenService,
      contactChangeChallengeRepository,
      emailOtpProvider,
    } = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue(baseUser),
        findByEmail: vi.fn().mockResolvedValue(null),
        findProfileByUserId: vi.fn().mockResolvedValue({ phone: { e164: "+35799999999" } }),
      },
      contactChangeChallengeRepository: {
        findActive: vi.fn().mockResolvedValue(challenge),
        claimAndDelete: vi.fn().mockResolvedValue(challenge),
      },
    });

    await service.verifyEmailChange(userId.toHexString(), { code: "1234" });

    expect(contactChangeChallengeRepository.claimAndDelete).toHaveBeenCalledWith(challengeId);
    expect(userRepository.commitEmailChange).toHaveBeenCalledWith(userId, "new@example.com");
    expect(tokenService.revokeAllSessionsForUser).toHaveBeenCalledWith(userId);
    expect(emailOtpProvider.sendNotice).toHaveBeenCalledWith(
      expect.objectContaining({ to: "current@example.com" }),
    );
  });

  it("rejects a wrong OTP, increments attempts, and never commits", async () => {
    const challenge = buildChallenge("1234", { otpHash: "not-a-real-hash" });
    const { service, userRepository, contactChangeChallengeRepository } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: { findActive: vi.fn().mockResolvedValue(challenge) },
    });

    await expect(
      service.verifyEmailChange(userId.toHexString(), { code: "9999" }),
    ).rejects.toMatchObject({ statusCode: 400, details: [{ code: "OTP_INVALID" }] });
    expect(contactChangeChallengeRepository.incrementAttempts).toHaveBeenCalledWith(challengeId);
    expect(userRepository.commitEmailChange).not.toHaveBeenCalled();
  });

  it("rejects an expired challenge", async () => {
    const challenge = buildChallenge("1234", {
      otpHash: "irrelevant",
      otpExpiresAt: new Date(Date.now() - 1000),
    });
    const { service } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: { findActive: vi.fn().mockResolvedValue(challenge) },
    });

    await expect(
      service.verifyEmailChange(userId.toHexString(), { code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_EXPIRED" }] });
  });

  it("rejects when there is no active challenge", async () => {
    const { service } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: { findActive: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.verifyEmailChange(userId.toHexString(), { code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "CONTACT_CHANGE_NOT_FOUND" }] });
  });

  it("rejects a replayed challenge that another request already consumed (claim race)", async () => {
    const challenge = buildChallenge("1234");
    const { service, userRepository } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: {
        findActive: vi.fn().mockResolvedValue(challenge),
        // Simulates a concurrent verify already having deleted the row.
        claimAndDelete: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.verifyEmailChange(userId.toHexString(), { code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "CONTACT_CHANGE_NOT_FOUND" }] });
    expect(userRepository.commitEmailChange).not.toHaveBeenCalled();
  });
});

describe("AuthService.requestPhoneChange", () => {
  const userId = new Types.ObjectId();
  const baseUser = { _id: userId, passwordHash: "old-hash" };
  const currentProfile = { phone: { e164: "+35799999999" } };

  it("sends an OTP to the new phone via the phone provider without committing it", async () => {
    const { service, userRepository, contactChangeChallengeRepository, phoneOtpProvider } =
      createAuthService({
        userRepository: {
          findByIdWithPassword: vi.fn().mockResolvedValue(baseUser),
          findProfileByUserId: vi.fn().mockResolvedValue(currentProfile),
        },
        phoneOtpProvider: {
          sendOtp: vi.fn().mockResolvedValue({ providerVerificationId: "verif-1" }),
        },
      });

    await service.requestPhoneChange(userId.toHexString(), {
      currentPassword: "correct-password",
      countryCode: "+357",
      nationalNumber: "12345678",
    });

    expect(phoneOtpProvider.sendOtp).toHaveBeenCalledWith({ toE164: "+35712345678" });
    expect(contactChangeChallengeRepository.upsertPhoneChallenge).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ newPhone: expect.objectContaining({ e164: "+35712345678" }) }),
    );
    expect(userRepository.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects requesting a change to the same current phone", async () => {
    const { service } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue(baseUser),
        findProfileByUserId: vi.fn().mockResolvedValue(currentProfile),
      },
    });

    await expect(
      service.requestPhoneChange(userId.toHexString(), {
        currentPassword: "correct-password",
        countryCode: "+357",
        nationalNumber: "99999999",
      }),
    ).rejects.toMatchObject({ details: [{ code: "CONTACT_UNCHANGED" }] });
  });

  it("rejects a phone already registered to another verified customer", async () => {
    const { service } = createAuthService({
      userRepository: {
        findByIdWithPassword: vi.fn().mockResolvedValue(baseUser),
        findProfileByUserId: vi.fn().mockResolvedValue(currentProfile),
        findVerifiedCustomerByPhoneE164: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      },
    });

    await expect(
      service.requestPhoneChange(userId.toHexString(), {
        currentPassword: "correct-password",
        countryCode: "+357",
        nationalNumber: "12345678",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("AuthService.verifyPhoneChange", () => {
  const userId = new Types.ObjectId();
  const challengeId = new Types.ObjectId();
  const baseUser = { _id: userId, normalizedEmail: "current@example.com" };
  const newPhone = { countryCode: "+357", nationalNumber: "12345678", e164: "+35712345678" };
  const profile = { _id: new Types.ObjectId() };

  it("commits the new phone on a correct OTP and never revokes sessions", async () => {
    const challenge = {
      _id: challengeId,
      newPhone,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const { service, userRepository, tokenService, phoneOtpProvider } = createAuthService({
      userRepository: {
        findById: vi.fn().mockResolvedValue(baseUser),
        findProfileByUserId: vi.fn().mockResolvedValue(profile),
      },
      contactChangeChallengeRepository: {
        findActive: vi.fn().mockResolvedValue(challenge),
        claimAndDelete: vi.fn().mockResolvedValue(challenge),
      },
    });

    await service.verifyPhoneChange(userId.toHexString(), { code: "1234" });

    expect(phoneOtpProvider.verifyOtp).toHaveBeenCalledWith({
      toE164: "+35712345678",
      code: "1234",
    });
    expect(userRepository.updateProfile).toHaveBeenCalledWith(profile._id, { phone: newPhone });
    expect(userRepository.updatePhoneVerifiedAt).toHaveBeenCalledWith(userId, expect.any(Date));
    expect(tokenService.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it("rejects a wrong OTP, increments attempts, and never commits", async () => {
    const challenge = {
      _id: challengeId,
      newPhone,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const { service, userRepository, contactChangeChallengeRepository } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: { findActive: vi.fn().mockResolvedValue(challenge) },
      phoneOtpProvider: { verifyOtp: vi.fn().mockResolvedValue(false) },
    });

    await expect(
      service.verifyPhoneChange(userId.toHexString(), { code: "0000" }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_INVALID" }] });
    expect(contactChangeChallengeRepository.incrementAttempts).toHaveBeenCalledWith(challengeId);
    expect(userRepository.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects when there is no active challenge", async () => {
    const { service } = createAuthService({
      userRepository: { findById: vi.fn().mockResolvedValue(baseUser) },
      contactChangeChallengeRepository: { findActive: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.verifyPhoneChange(userId.toHexString(), { code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "CONTACT_CHANGE_NOT_FOUND" }] });
  });
});
