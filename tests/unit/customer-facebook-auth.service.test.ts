import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  FACEBOOK_CLIENT_ID: "fb-app-123",
  FACEBOOK_CLIENT_SECRET: "fb-customer-secret",
  FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/customer/oauth/facebook/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveCustomerFacebookIdentity = vi.fn();
const buildCustomerFacebookAuthUrl = vi.fn(
  (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
);

vi.mock("../../src/modules/customer-facebook-auth/customer-facebook-auth.client.js", () => ({
  resolveCustomerFacebookIdentity,
  buildCustomerFacebookAuthUrl,
  isCustomerFacebookAuthConfigured: () => true,
}));

const { CustomerFacebookAuthService } = await import(
  "../../src/modules/customer-facebook-auth/customer-facebook-auth.service.js"
);
const { signCustomerFacebookState } = await import(
  "../../src/modules/customer-facebook-auth/customer-facebook-auth.state.js"
);

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "pat@example.com",
    role: "CUSTOMER",
    status: "ACTIVE",
    authProviders: ["FACEBOOK"],
    phoneVerifiedAt: undefined,
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "FACEBOOK",
    providerAccountId: "fb-user-1",
    email: "pat@example.com",
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
  getAccessTokenExpiresAt: vi.fn(() => new Date("2026-09-02T12:15:00.000Z")),
} as const;

const context = { userAgent: "vitest", ipAddress: "127.0.0.1" };

const makeService = (
  overrides: {
    user?: Partial<Record<keyof UserRepository, unknown>>;
    link?: Partial<Record<keyof LinkedAccountRepository, unknown>>;
  } = {},
) => {
  const userRepository = {
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async () => null),
    create: vi.fn(),
    createProfile: vi.fn(),
    ...overrides.user,
  } as unknown as UserRepository;

  const linkedAccountRepository = {
    findByProviderAccount: vi.fn(async () => null),
    create: vi.fn(),
    ...overrides.link,
  } as unknown as LinkedAccountRepository;

  const service = new CustomerFacebookAuthService(
    userRepository,
    linkedAccountRepository,
    tokenService as never,
  );

  return { service, userRepository, linkedAccountRepository };
};

const validCallbackInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signCustomerFacebookState({ nonce });
  return { code: "auth-code", state, nonceCookie: nonce };
};

const identity = {
  providerAccountId: "fb-user-42",
  email: "Pat@Example.com",
  emailVerified: true,
  displayName: "Pat Example",
};

beforeEach(() => {
  vi.clearAllMocks();
  buildCustomerFacebookAuthUrl.mockImplementation(
    (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
  );
  tokenService.createAccessToken.mockResolvedValue("access-token");
  tokenService.createRefreshSession.mockResolvedValue({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  });
});

describe("CustomerFacebookAuthService.buildAuthorization", () => {
  it("returns a Facebook consent URL plus the nonce the state carries", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization();
    expect(url).toContain("facebook.com");
    expect(nonce).toHaveLength(64);
    expect(buildCustomerFacebookAuthUrl).toHaveBeenCalledTimes(1);
  });
});

describe("completeCallback — guard failures return ERROR", () => {
  it("invalid / unsigned state — no provider call", async () => {
    const { service, linkedAccountRepository } = makeService();
    const result = await service.completeCallback(
      { code: "c", state: "forged", nonceCookie: "whatever" },
      context,
    );
    expect(result).toEqual({ type: "ERROR" });
    expect(resolveCustomerFacebookIdentity).not.toHaveBeenCalled();
    expect(linkedAccountRepository.findByProviderAccount).not.toHaveBeenCalled();
  });

  it("missing nonce cookie", async () => {
    const { service } = makeService();
    const state = await signCustomerFacebookState({ nonce: "n1234567890" });
    expect(
      await service.completeCallback({ code: "c", state, nonceCookie: undefined }, context),
    ).toEqual({ type: "ERROR" });
  });

  it("nonce cookie does not match the state nonce", async () => {
    const { service } = makeService();
    const state = await signCustomerFacebookState({ nonce: "the-real-nonce-000" });
    expect(
      await service.completeCallback(
        { code: "c", state, nonceCookie: "a-different-nonce" },
        context,
      ),
    ).toEqual({ type: "ERROR" });
  });

  it("Facebook OAuth failure (resolver throws)", async () => {
    const { service } = makeService();
    resolveCustomerFacebookIdentity.mockRejectedValue(new Error("oauth failed"));
    expect(await service.completeCallback(await validCallbackInput(), context)).toEqual({
      type: "ERROR",
    });
  });
});

describe("completeCallback — CASE A: existing FACEBOOK LinkedAccount", () => {
  it("logs in the linked ACTIVE customer; phone completion still needed", async () => {
    const user = buildUser({ phoneVerifiedAt: undefined });
    const link = buildLink({ userId: user._id, providerAccountId: identity.providerAccountId });
    const { service, userRepository } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerFacebookIdentity.mockResolvedValue(identity);

    const result = await service.completeCallback(await validCallbackInput(), context);

    expect(result).toMatchObject({
      type: "SESSION",
      requiresPhoneCompletion: true,
      auth: { accessToken: "access-token", refreshToken: "refresh-token" },
    });
    // Resolved by providerAccountId, never by email.
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
  });

  it("logs in even when the fresh /me response carried NO email", async () => {
    const user = buildUser({ phoneVerifiedAt: new Date() });
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-42",
      emailVerified: false,
      displayName: "Pat",
    });

    expect(await service.completeCallback(await validCallbackInput(), context)).toMatchObject({
      type: "SESSION",
      requiresPhoneCompletion: false,
    });
  });

  it.each([
    ["SUSPENDED", buildUser({ status: "SUSPENDED" })],
    ["DELETED", buildUser({ status: "DELETED" })],
    ["non-CUSTOMER role", buildUser({ role: "BUSINESS_OWNER" })],
    ["SUPERVISOR role", buildUser({ role: "SUPERVISOR" })],
  ])("returns ERROR (no session) when the linked user is %s", async (_label, user) => {
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerFacebookIdentity.mockResolvedValue(identity);

    expect(await service.completeCallback(await validCallbackInput(), context)).toEqual({
      type: "ERROR",
    });
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });

  it("returns ERROR when the linked user row is missing", async () => {
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink()) },
      user: { findById: vi.fn(async () => null) },
    });
    resolveCustomerFacebookIdentity.mockResolvedValue(identity);
    expect(await service.completeCallback(await validCallbackInput(), context)).toEqual({
      type: "ERROR",
    });
  });
});

describe("completeCallback — CASE B: no link + no email", () => {
  it("returns ERROR and never touches the user repo (no fake email, no signup)", async () => {
    const { service, userRepository, linkedAccountRepository } = makeService();
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "brand-new-fb-id",
      emailVerified: false,
    });

    expect(await service.completeCallback(await validCallbackInput(), context)).toEqual({
      type: "ERROR",
    });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
    expect(userRepository.create).not.toHaveBeenCalled();
    expect(linkedAccountRepository.create).not.toHaveBeenCalled();
  });
});

describe("completeCallback — CASE C: no link + email already registered", () => {
  it("returns ACCOUNT_EXISTS and writes nothing (never auto-links by email)", async () => {
    const { service, userRepository, linkedAccountRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildUser()) },
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "brand-new-fb-id",
      email: "pat@example.com",
      emailVerified: true,
    });

    const result = await service.completeCallback(await validCallbackInput(), context);

    expect(result).toEqual({ type: "ACCOUNT_EXISTS" });
    expect(userRepository.findByEmail).toHaveBeenCalledWith("pat@example.com");
    expect(linkedAccountRepository.create).not.toHaveBeenCalled();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
