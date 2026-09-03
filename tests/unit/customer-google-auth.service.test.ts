import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/customer/oauth/google/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveCustomerGoogleIdentity = vi.fn();
const buildCustomerGoogleAuthUrl = vi.fn(
  (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
);

vi.mock("../../src/modules/customer-google-auth/customer-google-auth.client.js", () => ({
  resolveCustomerGoogleIdentity,
  buildCustomerGoogleAuthUrl,
  isCustomerGoogleAuthConfigured: () => true,
}));

const { CustomerGoogleAuthService, splitGoogleName } = await import(
  "../../src/modules/customer-google-auth/customer-google-auth.service.js"
);
const { signCustomerGoogleState } = await import(
  "../../src/modules/customer-google-auth/customer-google-auth.state.js"
);

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "person@gmail.com",
    role: "CUSTOMER",
    status: "ACTIVE",
    authProviders: ["GOOGLE"],
    phoneVerifiedAt: undefined,
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "GOOGLE",
    providerAccountId: "google-sub-1",
    email: "person@gmail.com",
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

  const service = new CustomerGoogleAuthService(
    userRepository,
    linkedAccountRepository,
    tokenService as never,
  );

  return { service, userRepository, linkedAccountRepository };
};

const validCallbackInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signCustomerGoogleState({ nonce });
  return { code: "auth-code", state, nonceCookie: nonce };
};

beforeEach(() => {
  vi.clearAllMocks();
  buildCustomerGoogleAuthUrl.mockImplementation(
    (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  );
  tokenService.createAccessToken.mockResolvedValue("access-token");
  tokenService.createRefreshSession.mockResolvedValue({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  });
});

describe("splitGoogleName", () => {
  it("uses given_name + family_name when both are present", () => {
    expect(splitGoogleName({ firstName: "Ada", lastName: "Lovelace" })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("splits a multi-word display name", () => {
    expect(splitGoogleName({ displayName: "Grace Brewster Hopper" })).toEqual({
      firstName: "Grace",
      lastName: "Brewster Hopper",
    });
  });

  it("duplicates a single-token name into both fields (no invented placeholder)", () => {
    expect(splitGoogleName({ displayName: "Cher" })).toEqual({
      firstName: "Cher",
      lastName: "Cher",
    });
  });

  it("falls back to Google / User when nothing usable is provided", () => {
    expect(splitGoogleName({})).toEqual({ firstName: "Google", lastName: "User" });
  });

  it("fills the missing half from the display name when only one of given/family is present", () => {
    expect(splitGoogleName({ firstName: "Ada", displayName: "Ada Lovelace" })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
});

describe("CustomerGoogleAuthService.buildAuthorization", () => {
  it("returns a Google consent URL plus the nonce that the state carries", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization();

    expect(url).toContain("accounts.google.com");
    expect(nonce).toHaveLength(64);
    expect(buildCustomerGoogleAuthUrl).toHaveBeenCalledTimes(1);
  });
});

describe("CustomerGoogleAuthService.completeCallback — guard failures return ERROR", () => {
  it("invalid / unsigned state", async () => {
    const { service, linkedAccountRepository } = makeService();
    const result = await service.completeCallback(
      { code: "c", state: "forged", nonceCookie: "whatever" },
      context,
    );
    expect(result).toEqual({ type: "ERROR" });
    expect(linkedAccountRepository.findByProviderAccount).not.toHaveBeenCalled();
  });

  it("missing nonce cookie", async () => {
    const { service } = makeService();
    const state = await signCustomerGoogleState({ nonce: "n1234567890" });
    const result = await service.completeCallback(
      { code: "c", state, nonceCookie: undefined },
      context,
    );
    expect(result).toEqual({ type: "ERROR" });
  });

  it("nonce cookie does not match the state nonce", async () => {
    const { service } = makeService();
    const state = await signCustomerGoogleState({ nonce: "the-real-nonce-000" });
    const result = await service.completeCallback(
      { code: "c", state, nonceCookie: "a-different-nonce-1" },
      context,
    );
    expect(result).toEqual({ type: "ERROR" });
  });

  it("Google OAuth failure (resolveCustomerGoogleIdentity throws)", async () => {
    const { service } = makeService();
    resolveCustomerGoogleIdentity.mockRejectedValue(new Error("oauth failed"));
    const result = await service.completeCallback(await validCallbackInput(), context);
    expect(result).toEqual({ type: "ERROR" });
  });

  it("unverified Google email", async () => {
    const { service, userRepository } = makeService();
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "sub-x",
      email: "person@gmail.com",
      emailVerified: false,
    });
    const result = await service.completeCallback(await validCallbackInput(), context);
    expect(result).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
  });
});

describe("CustomerGoogleAuthService.completeCallback — CASE 1 existing LinkedAccount", () => {
  const identity = {
    providerAccountId: "google-sub-42",
    email: "Person@Gmail.com",
    emailVerified: true,
    displayName: "Person Example",
  };

  it("logs in the linked ACTIVE customer and reports phone completion still needed", async () => {
    const user = buildUser({ phoneVerifiedAt: undefined });
    const link = buildLink({ userId: user._id, providerAccountId: identity.providerAccountId });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerGoogleIdentity.mockResolvedValue(identity);

    const result = await service.completeCallback(await validCallbackInput(), context);

    expect(result).toMatchObject({
      type: "SESSION",
      requiresPhoneCompletion: true,
      auth: { accessToken: "access-token", refreshToken: "refresh-token" },
    });
    expect(tokenService.createRefreshSession).toHaveBeenCalledTimes(1);
  });

  it("logs in a fully-onboarded linked customer with requiresPhoneCompletion false", async () => {
    const user = buildUser({ phoneVerifiedAt: new Date() });
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerGoogleIdentity.mockResolvedValue(identity);

    const result = await service.completeCallback(await validCallbackInput(), context);
    expect(result).toMatchObject({ type: "SESSION", requiresPhoneCompletion: false });
  });

  it.each([
    ["SUSPENDED", buildUser({ status: "SUSPENDED" })],
    ["DELETED", buildUser({ status: "DELETED" })],
    ["non-CUSTOMER role", buildUser({ role: "BUSINESS_OWNER" })],
  ])("returns ERROR (no session) when the linked user is %s", async (_label, user) => {
    const link = buildLink({ userId: user._id });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerGoogleIdentity.mockResolvedValue(identity);

    const result = await service.completeCallback(await validCallbackInput(), context);
    expect(result).toEqual({ type: "ERROR" });
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });

  it("returns ERROR when the linked user row is missing", async () => {
    const link = buildLink();
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => null) },
    });
    resolveCustomerGoogleIdentity.mockResolvedValue(identity);

    expect(await service.completeCallback(await validCallbackInput(), context)).toEqual({
      type: "ERROR",
    });
  });
});

describe("CustomerGoogleAuthService.completeCallback — CASE 2 email already registered", () => {
  it("returns ACCOUNT_EXISTS and writes nothing (never auto-links by email)", async () => {
    const { service, userRepository, linkedAccountRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildUser()) },
    });
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "brand-new-sub",
      email: "person@gmail.com",
      emailVerified: true,
    });

    const result = await service.completeCallback(await validCallbackInput(), context);

    expect(result).toEqual({ type: "ACCOUNT_EXISTS" });
    expect(userRepository.findByEmail).toHaveBeenCalledWith("person@gmail.com");
    expect(linkedAccountRepository.create).not.toHaveBeenCalled();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
