import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { RegistrationSessionRepository } from "../../src/modules/registration-session/registration-session.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  APPLE_CLIENT_ID: "cy.bookly.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "YXBwbGUta2V5",
  APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "https://bookly.cy/api/v1/auth/professional/oauth/apple/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
  REGISTRATION_SESSION_TTL_HOURS: 24,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveProfessionalAppleIdentity = vi.fn();
const buildProfessionalAppleAuthUrl = vi.fn(
  (state: string, nonce: string) =>
    `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
);

vi.mock("../../src/modules/professional-apple-auth/professional-apple-auth.client.js", () => ({
  resolveProfessionalAppleIdentity,
  buildProfessionalAppleAuthUrl,
  isProfessionalAppleAuthConfigured: () => true,
}));

const { ProfessionalAppleAuthService } = await import(
  "../../src/modules/professional-apple-auth/professional-apple-auth.service.js"
);
const { signProfessionalAppleState } = await import(
  "../../src/modules/professional-apple-auth/professional-apple-auth.state.js"
);

const buildOwner = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "owner@example.com",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    authProviders: ["APPLE"],
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "APPLE",
    providerAccountId: "apple-owner-1",
    email: "owner@example.com",
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
    createAppleProfessionalSession: vi.fn(async () => ({
      _id: new Types.ObjectId(),
      currentStep: "EMAIL_VERIFIED",
    })),
    save: vi.fn(async (s: unknown) => s),
    ...overrides.session,
  } as unknown as RegistrationSessionRepository;

  const businessOnboardingService = {
    saveVisitType: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  } as never;

  return {
    service: new ProfessionalAppleAuthService(
      userRepository,
      linkedAccountRepository,
      registrationSessionRepository,
      businessOnboardingService,
      tokenService as never,
    ),
    userRepository,
    linkedAccountRepository,
    registrationSessionRepository,
  };
};

const validInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signProfessionalAppleState({ nonce, visitType: "AT_BUSINESS_LOCATION" });
  return { code: "auth-code", state, idToken: undefined, appleUser: undefined };
};

const identity = {
  providerAccountId: "apple-owner-42",
  email: "Owner@Example.com",
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  tokenService.createAccessToken.mockResolvedValue("access-token");
  tokenService.createRefreshSession.mockResolvedValue({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  });
});

describe("ProfessionalAppleAuthService", () => {
  it("buildAuthorization signs nonce + visitType and returns a consent URL", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization("TRAVEL_TO_CUSTOMER");
    expect(url).toContain("appleid.apple.com");
    expect(nonce).toHaveLength(64);
  });

  it("invalid state → ERROR, no provider call", async () => {
    const { service, linkedAccountRepository } = makeService();
    expect(
      await service.completeCallback(
        { code: "c", state: "forged", idToken: undefined, appleUser: undefined },
        context,
      ),
    ).toEqual({ type: "ERROR" });
    expect(linkedAccountRepository.findByProviderAccount).not.toHaveBeenCalled();
  });

  it.each([["BUSINESS_OWNER"], ["SUPERVISOR"], ["STAFF"]] as const)(
    "CASE 2 — existing linked %s → session, no session-seed",
    async (role) => {
      const user = buildOwner({ role });
      const { service, registrationSessionRepository } = makeService({
        link: { findByProviderAccount: vi.fn(async () => buildLink({ userId: user._id })) },
        user: { findById: vi.fn(async () => user) },
      });
      resolveProfessionalAppleIdentity.mockResolvedValue(identity);
      expect(await service.completeCallback(await validInput(), context)).toMatchObject({
        type: "SESSION",
      });
      expect(registrationSessionRepository.createAppleProfessionalSession).not.toHaveBeenCalled();
    },
  );

  it("existing linked owner logs in with NO fresh email", async () => {
    const user = buildOwner({ role: "STAFF" });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink({ userId: user._id })) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-owner-42",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toMatchObject({
      type: "SESSION",
    });
  });

  it.each([
    ["SUSPENDED", buildOwner({ status: "SUSPENDED" })],
    ["DELETED", buildOwner({ status: "DELETED" })],
    ["CUSTOMER", buildOwner({ role: "CUSTOMER" })],
    ["SUPER_ADMIN", buildOwner({ role: "SUPER_ADMIN" })],
  ])("CASE 2 — linked %s → ERROR", async (_label, user) => {
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink({ userId: user._id })) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveProfessionalAppleIdentity.mockResolvedValue(identity);
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });

  it("unknown identity + no email → ERROR, no RegistrationSession", async () => {
    const { service, registrationSessionRepository, userRepository } = makeService();
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
    expect(registrationSessionRepository.createAppleProfessionalSession).not.toHaveBeenCalled();
  });

  it("unknown identity + unverified email → ERROR", async () => {
    const { service } = makeService();
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      email: "x@y.com",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });

  it("unknown identity + verified email already local → ACCOUNT_EXISTS, no RegistrationSession", async () => {
    const { service, registrationSessionRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildOwner()) },
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      email: "owner@example.com",
      emailVerified: true,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({
      type: "ACCOUNT_EXISTS",
    });
    expect(registrationSessionRepository.createAppleProfessionalSession).not.toHaveBeenCalled();
  });

  it("unknown identity + verified unused email → seeds a BUSINESS_OWNER RegistrationSession (no User)", async () => {
    const sessionId = new Types.ObjectId();
    const createAppleProfessionalSession = vi.fn(async () => ({
      _id: sessionId,
      currentStep: "EMAIL_VERIFIED",
    }));
    const { service, userRepository } = makeService({
      session: { createAppleProfessionalSession },
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-new-owner",
      email: "New.Owner@Example.com",
      emailVerified: true,
    });

    const result = await service.completeCallback(
      { ...(await validInput()), appleUser: '{"name":{"firstName":"New","lastName":"Owner"}}' },
      context,
    );

    expect(result).toEqual({
      type: "REGISTRATION",
      sessionId: String(sessionId),
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(createAppleProfessionalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedEmail: "new.owner@example.com",
        appleProviderAccountId: "apple-new-owner",
        firstName: "New",
        lastName: "Owner",
        businessVisitType: "AT_BUSINESS_LOCATION",
      }),
    );
    expect((userRepository as { create?: unknown }).create).toBeUndefined();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
