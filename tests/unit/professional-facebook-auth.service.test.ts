import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { RegistrationSessionRepository } from "../../src/modules/registration-session/registration-session.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  FACEBOOK_CLIENT_ID: "fb-app-123",
  FACEBOOK_CLIENT_SECRET: "fb-professional-secret",
  FACEBOOK_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/professional/oauth/facebook/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
  REGISTRATION_SESSION_TTL_HOURS: 24,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveProfessionalFacebookIdentity = vi.fn();
const buildProfessionalFacebookAuthUrl = vi.fn(
  (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
);

vi.mock(
  "../../src/modules/professional-facebook-auth/professional-facebook-auth.client.js",
  () => ({
    resolveProfessionalFacebookIdentity,
    buildProfessionalFacebookAuthUrl,
    isProfessionalFacebookAuthConfigured: () => true,
  }),
);

const { ProfessionalFacebookAuthService } = await import(
  "../../src/modules/professional-facebook-auth/professional-facebook-auth.service.js"
);
const { signProfessionalFacebookState } = await import(
  "../../src/modules/professional-facebook-auth/professional-facebook-auth.state.js"
);

const buildOwner = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "owner@example.com",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    authProviders: ["FACEBOOK"],
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "FACEBOOK",
    providerAccountId: "fb-owner-1",
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
    createFacebookProfessionalSession: vi.fn(async () => ({
      _id: new Types.ObjectId(),
      currentStep: "EMAIL_VERIFIED",
    })),
    save: vi.fn(async (s: unknown) => s),
    ...overrides.session,
  } as unknown as RegistrationSessionRepository;

  const businessOnboardingService = {
    saveVisitType: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  } as never;

  const service = new ProfessionalFacebookAuthService(
    userRepository,
    linkedAccountRepository,
    registrationSessionRepository,
    businessOnboardingService,
    tokenService as never,
  );

  return { service, userRepository, linkedAccountRepository, registrationSessionRepository };
};

const validInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signProfessionalFacebookState({ nonce, visitType: "AT_BUSINESS_LOCATION" });
  return { code: "auth-code", state, nonceCookie: nonce };
};

const identity = {
  providerAccountId: "fb-owner-42",
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

describe("ProfessionalFacebookAuthService.buildAuthorization", () => {
  it("signs nonce + visitType into the state and returns a consent URL", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization("TRAVEL_TO_CUSTOMER");
    expect(url).toContain("facebook.com");
    expect(nonce).toHaveLength(64);
  });
});

describe("completeCallback — guard failures return ERROR", () => {
  it("invalid state — no provider call", async () => {
    const { service, linkedAccountRepository } = makeService();
    expect(
      await service.completeCallback({ code: "c", state: "forged", nonceCookie: "x" }, context),
    ).toEqual({ type: "ERROR" });
    expect(linkedAccountRepository.findByProviderAccount).not.toHaveBeenCalled();
  });

  it("missing nonce cookie", async () => {
    const { service } = makeService();
    const state = await signProfessionalFacebookState({
      nonce: "n123",
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(
      await service.completeCallback({ code: "c", state, nonceCookie: undefined }, context),
    ).toEqual({ type: "ERROR" });
  });

  it("nonce cookie mismatch", async () => {
    const { service } = makeService();
    const state = await signProfessionalFacebookState({
      nonce: "real-nonce",
      visitType: "AT_BUSINESS_LOCATION",
    });
    expect(
      await service.completeCallback({ code: "c", state, nonceCookie: "other" }, context),
    ).toEqual({ type: "ERROR" });
  });

  it("Facebook OAuth failure", async () => {
    const { service } = makeService();
    resolveProfessionalFacebookIdentity.mockRejectedValue(new Error("denied"));
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });
});

describe("completeCallback — CASE 2 existing linked professional-role user", () => {
  it.each([["BUSINESS_OWNER"], ["SUPERVISOR"], ["STAFF"]] as const)(
    "issues a session for an ACTIVE %s (existing linked Facebook identity)",
    async (role) => {
      const user = buildOwner({ role });
      const link = buildLink({ userId: user._id, providerAccountId: identity.providerAccountId });
      const { service } = makeService({
        link: { findByProviderAccount: vi.fn(async () => link) },
        user: { findById: vi.fn(async () => user) },
      });
      resolveProfessionalFacebookIdentity.mockResolvedValue(identity);

      expect(await service.completeCallback(await validInput(), context)).toMatchObject({
        type: "SESSION",
        auth: { accessToken: "access-token", refreshToken: "refresh-token" },
      });
      expect(tokenService.createRefreshSession).toHaveBeenCalledTimes(1);
    },
  );

  it("logs in even when the fresh /me response carried NO email", async () => {
    const user = buildOwner({ role: "STAFF" });
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-owner-42",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toMatchObject({
      type: "SESSION",
    });
  });

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
    resolveProfessionalFacebookIdentity.mockResolvedValue(identity);
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});

describe("completeCallback — unknown identity", () => {
  it("no email → ERROR, no RegistrationSession, no fake email", async () => {
    const { service, userRepository, registrationSessionRepository } = makeService();
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "brand-new-fb",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
    expect(registrationSessionRepository.createFacebookProfessionalSession).not.toHaveBeenCalled();
  });

  it("email already registered → ACCOUNT_EXISTS, no RegistrationSession", async () => {
    const { service, registrationSessionRepository, linkedAccountRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildOwner()) },
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "brand-new-fb",
      email: "owner@example.com",
      emailVerified: true,
    });

    expect(await service.completeCallback(await validInput(), context)).toEqual({
      type: "ACCOUNT_EXISTS",
    });
    expect(registrationSessionRepository.createFacebookProfessionalSession).not.toHaveBeenCalled();
    expect(linkedAccountRepository.findByProviderAccount).toHaveBeenCalledTimes(1);
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });

  it("unused email → seeds a BUSINESS_OWNER RegistrationSession only (no User, no session)", async () => {
    const sessionId = new Types.ObjectId();
    const createFacebookProfessionalSession = vi.fn(async () => ({
      _id: sessionId,
      currentStep: "EMAIL_VERIFIED",
    }));
    const { service, userRepository } = makeService({
      session: { createFacebookProfessionalSession },
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-new-owner",
      email: "New.Owner@Example.com",
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
    expect(createFacebookProfessionalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedEmail: "new.owner@example.com",
        facebookProviderAccountId: "fb-new-owner",
        firstName: "New",
        lastName: "Owner",
        businessVisitType: "AT_BUSINESS_LOCATION",
      }),
    );
    expect((userRepository as { create?: unknown }).create).toBeUndefined();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
