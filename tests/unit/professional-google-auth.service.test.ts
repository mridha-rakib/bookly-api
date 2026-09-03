import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { RegistrationSessionRepository } from "../../src/modules/registration-session/registration-session.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/professional/oauth/google/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
  REGISTRATION_SESSION_TTL_HOURS: 24,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveProfessionalGoogleIdentity = vi.fn();
const buildProfessionalGoogleAuthUrl = vi.fn(
  (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
);

vi.mock("../../src/modules/professional-google-auth/professional-google-auth.client.js", () => ({
  resolveProfessionalGoogleIdentity,
  buildProfessionalGoogleAuthUrl,
  isProfessionalGoogleAuthConfigured: () => true,
}));

const { ProfessionalGoogleAuthService } = await import(
  "../../src/modules/professional-google-auth/professional-google-auth.service.js"
);
const { signProfessionalGoogleState } = await import(
  "../../src/modules/professional-google-auth/professional-google-auth.state.js"
);

const buildOwner = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "owner@gmail.com",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    authProviders: ["GOOGLE"],
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "GOOGLE",
    providerAccountId: "google-sub-1",
    email: "owner@gmail.com",
    emailVerified: true,
    linkedAt: new Date(),
    ...overrides,
  }) as LinkedAccountDocument;

const tokenService = {
  createAccessToken: vi.fn(async () => "access-token"),
  createRefreshSession: vi.fn(async () => ({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  })),
  getAccessTokenExpiresAt: vi.fn(() => new Date("2026-09-03T12:15:00.000Z")),
} as const;

const context = { userAgent: "vitest", ipAddress: "127.0.0.1" };

const makeService = (
  overrides: {
    user?: Partial<Record<keyof UserRepository, unknown>>;
    link?: Partial<Record<keyof LinkedAccountRepository, unknown>>;
    session?: Partial<Record<keyof RegistrationSessionRepository, unknown>>;
  } = {},
) => {
  const userRepository = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async () => null),
    ...overrides.user,
  } as unknown as UserRepository;

  const linkedAccountRepository = {
    findByProviderAccount: vi.fn(async () => null),
    ...overrides.link,
  } as unknown as LinkedAccountRepository;

  const registrationSessionRepository = {
    createGoogleProfessionalSession: vi.fn(async () => ({
      _id: new Types.ObjectId(),
      currentStep: "EMAIL_VERIFIED",
    })),
    save: vi.fn(async (s: unknown) => s),
    ...overrides.session,
  } as unknown as RegistrationSessionRepository;

  const businessOnboardingService = {
    saveVisitType: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  } as never;

  const service = new ProfessionalGoogleAuthService(
    userRepository,
    linkedAccountRepository,
    registrationSessionRepository,
    businessOnboardingService,
    tokenService as never,
  );

  return { service, userRepository, linkedAccountRepository, registrationSessionRepository };
};

const validInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signProfessionalGoogleState({ nonce, visitType: "AT_BUSINESS_LOCATION" });
  return { code: "auth-code", state, nonceCookie: nonce };
};

beforeEach(() => {
  vi.clearAllMocks();
  tokenService.createAccessToken.mockResolvedValue("access-token");
  tokenService.createRefreshSession.mockResolvedValue({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  });
});

describe("ProfessionalGoogleAuthService.buildAuthorization", () => {
  it("signs the nonce + visitType into the state and returns a consent URL", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization("TRAVEL_TO_CUSTOMER");
    expect(url).toContain("accounts.google.com");
    expect(nonce).toHaveLength(64);
  });
});

describe("completeCallback — guard failures return ERROR", () => {
  it("invalid state", async () => {
    const { service, linkedAccountRepository } = makeService();
    const result = await service.completeCallback(
      { code: "c", state: "forged", nonceCookie: "x" },
      context,
    );
    expect(result).toEqual({ type: "ERROR" });
    expect(linkedAccountRepository.findByProviderAccount).not.toHaveBeenCalled();
  });

  it("missing nonce cookie", async () => {
    const { service } = makeService();
    const state = await signProfessionalGoogleState({
      nonce: "n123",
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(
      await service.completeCallback({ code: "c", state, nonceCookie: undefined }, context),
    ).toEqual({ type: "ERROR" });
  });

  it("nonce cookie mismatch", async () => {
    const { service } = makeService();
    const state = await signProfessionalGoogleState({
      nonce: "real-nonce",
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(
      await service.completeCallback({ code: "c", state, nonceCookie: "other-nonce" }, context),
    ).toEqual({ type: "ERROR" });
  });

  it("Google OAuth failure", async () => {
    const { service } = makeService();
    resolveProfessionalGoogleIdentity.mockRejectedValue(new Error("denied"));
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });

  it("unverified Google email", async () => {
    const { service, userRepository } = makeService();
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "sub-x",
      email: "owner@gmail.com",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
  });
});

describe("completeCallback — CASE 2 existing linked professional-role user", () => {
  const identity = {
    providerAccountId: "google-sub-owner",
    email: "Owner@Gmail.com",
    emailVerified: true,
  };

  it.each([["BUSINESS_OWNER"], ["SUPERVISOR"], ["STAFF"]] as const)(
    "issues a session for an ACTIVE %s (Phase 2D — staff Google login)",
    async (role) => {
      const user = buildOwner({ role });
      const link = buildLink({ userId: user._id, providerAccountId: identity.providerAccountId });
      const { service } = makeService({
        link: { findByProviderAccount: vi.fn(async () => link) },
        user: { findById: vi.fn(async () => user) },
      });
      resolveProfessionalGoogleIdentity.mockResolvedValue(identity);

      const result = await service.completeCallback(await validInput(), context);

      expect(result).toMatchObject({
        type: "SESSION",
        auth: { accessToken: "access-token", refreshToken: "refresh-token" },
      });
      expect(tokenService.createRefreshSession).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["SUSPENDED", buildOwner({ status: "SUSPENDED" })],
    ["DELETED", buildOwner({ status: "DELETED" })],
    ["CUSTOMER role", buildOwner({ role: "CUSTOMER" })],
    ["SUPER_ADMIN role", buildOwner({ role: "SUPER_ADMIN" })],
  ])("returns ERROR (no session) when the linked user is %s", async (_label, user) => {
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue(identity);

    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });

  it("returns ERROR when the linked user row is missing", async () => {
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink()) },
      user: { findById: vi.fn(async () => null) },
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue(identity);
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });
});

describe("completeCallback — CASE 3 email already registered (no Google link)", () => {
  it("returns ACCOUNT_EXISTS and writes nothing", async () => {
    const { service, registrationSessionRepository, linkedAccountRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildOwner()) },
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "brand-new-sub",
      email: "owner@gmail.com",
      emailVerified: true,
    });

    const result = await service.completeCallback(await validInput(), context);

    expect(result).toEqual({ type: "ACCOUNT_EXISTS" });
    expect(registrationSessionRepository.createGoogleProfessionalSession).not.toHaveBeenCalled();
    expect(linkedAccountRepository.findByProviderAccount).toHaveBeenCalledTimes(1);
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});

describe("completeCallback — CASE 1 brand-new Business Owner", () => {
  it("seeds a RegistrationSession only (no User, no session) and returns its id", async () => {
    const sessionId = new Types.ObjectId();
    const createGoogleProfessionalSession = vi.fn(async () => ({
      _id: sessionId,
      currentStep: "EMAIL_VERIFIED",
    }));
    const { service, userRepository } = makeService({
      session: { createGoogleProfessionalSession },
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "sub-new-owner",
      email: "New.Owner@Gmail.com",
      emailVerified: true,
      firstName: "New",
      lastName: "Owner",
    });

    const result = await service.completeCallback(await validInput(), context);

    expect(result).toEqual({
      type: "REGISTRATION",
      sessionId: String(sessionId),
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(createGoogleProfessionalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedEmail: "new.owner@gmail.com",
        googleProviderAccountId: "sub-new-owner",
        firstName: "New",
        lastName: "Owner",
        businessVisitType: "AT_BUSINESS_LOCATION",
      }),
    );
    // No User is created here (Option B).
    expect((userRepository as { create?: unknown }).create).toBeUndefined();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
