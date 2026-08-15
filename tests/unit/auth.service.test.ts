import mongoose, { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../src/modules/auth/auth.service.js";
import type { PasswordHasher } from "../../src/modules/auth/password-hasher.js";
import type { TokenService } from "../../src/modules/auth/token.service.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessService } from "../../src/modules/business/business.service.js";
import type { BusinessOnboardingRepository } from "../../src/modules/business-onboarding/business-onboarding.repository.js";
import type { BusinessOnboardingService } from "../../src/modules/business-onboarding/business-onboarding.service.js";
import type { RegistrationSessionRepository } from "../../src/modules/registration-session/registration-session.repository.js";
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
    findProfileByUserId: vi.fn(),
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
    ...(overrides["tokenService"] as object | undefined),
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
    { hash: vi.fn(), verify: vi.fn() } as unknown as PasswordHasher,
    { sendOtp: vi.fn() } as unknown as EmailOtpProvider,
    { sendOtp: vi.fn(), verifyOtp: vi.fn().mockResolvedValue(true) } as unknown as PhoneOtpProvider,
    tokenService as unknown as TokenService,
    businessService as unknown as BusinessService,
  );

  return { service, userRepository, registrationSessionRepository, tokenService, businessService };
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
