import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  APPLE_CLIENT_ID: "cy.bookly.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "YXBwbGUta2V5",
  APPLE_CUSTOMER_OAUTH_REDIRECT_URI: "https://bookly.cy/api/v1/auth/customer/oauth/apple/callback",
  JWT_ACCESS_TOKEN_TTL_MINUTES: 15,
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const resolveCustomerAppleIdentity = vi.fn();
const buildCustomerAppleAuthUrl = vi.fn(
  (state: string, nonce: string) =>
    `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
);

vi.mock("../../src/modules/customer-apple-auth/customer-apple-auth.client.js", () => ({
  resolveCustomerAppleIdentity,
  buildCustomerAppleAuthUrl,
  isCustomerAppleAuthConfigured: () => true,
}));

const { CustomerAppleAuthService } = await import(
  "../../src/modules/customer-apple-auth/customer-apple-auth.service.js"
);
const { signCustomerAppleState } = await import(
  "../../src/modules/customer-apple-auth/customer-apple-auth.state.js"
);

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "pat@example.com",
    role: "CUSTOMER",
    status: "ACTIVE",
    authProviders: ["APPLE"],
    phoneVerifiedAt: undefined,
    ...overrides,
  }) as UserDocument;

const buildLink = (overrides: Partial<LinkedAccountDocument> = {}): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "APPLE",
    providerAccountId: "apple-sub-1",
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

  return {
    service: new CustomerAppleAuthService(
      userRepository,
      linkedAccountRepository,
      tokenService as never,
    ),
    userRepository,
    linkedAccountRepository,
  };
};

const validInput = async (nonce = "nonce-value-1234567890") => {
  const state = await signCustomerAppleState({ nonce });
  return { code: "auth-code", state, idToken: undefined, appleUser: undefined };
};

const identity = {
  providerAccountId: "apple-sub-42",
  email: "Pat@Example.com",
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  buildCustomerAppleAuthUrl.mockImplementation(
    (state: string, nonce: string) =>
      `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
  );
  tokenService.createAccessToken.mockResolvedValue("access-token");
  tokenService.createRefreshSession.mockResolvedValue({
    refreshToken: "refresh-token",
    expiresAt: new Date(),
  });
});

describe("CustomerAppleAuthService.buildAuthorization", () => {
  it("returns an Apple consent URL + a 64-char nonce that the state carries", async () => {
    const { service } = makeService();
    const { url, nonce } = await service.buildAuthorization();
    expect(url).toContain("appleid.apple.com");
    expect(url).toContain(`nonce=${nonce}`);
    expect(nonce).toHaveLength(64);
  });
});

describe("completeCallback — guard failures return ERROR", () => {
  it("invalid state — no provider call", async () => {
    const { service } = makeService();
    expect(
      await service.completeCallback(
        { code: "c", state: "forged", idToken: undefined, appleUser: undefined },
        context,
      ),
    ).toEqual({ type: "ERROR" });
    expect(resolveCustomerAppleIdentity).not.toHaveBeenCalled();
  });

  it("Apple OAuth failure (resolver throws) → ERROR", async () => {
    const { service } = makeService();
    resolveCustomerAppleIdentity.mockRejectedValue(new Error("verify failed"));
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
  });
});

describe("completeCallback — CASE A: existing APPLE link", () => {
  it("logs in the linked ACTIVE customer; findByEmail never called", async () => {
    const user = buildUser({ phoneVerifiedAt: undefined });
    const link = buildLink({ userId: user._id, providerAccountId: identity.providerAccountId });
    const { service, userRepository } = makeService({
      link: { findByProviderAccount: vi.fn(async () => link) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerAppleIdentity.mockResolvedValue(identity);

    expect(await service.completeCallback(await validInput(), context)).toMatchObject({
      type: "SESSION",
      requiresPhoneCompletion: true,
      auth: { accessToken: "access-token", refreshToken: "refresh-token" },
    });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
  });

  it("logs in even when Apple returned NO fresh email", async () => {
    const user = buildUser({ phoneVerifiedAt: new Date() });
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink({ userId: user._id })) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-42",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toMatchObject({
      type: "SESSION",
      requiresPhoneCompletion: false,
    });
  });

  it.each([
    ["SUSPENDED", buildUser({ status: "SUSPENDED" })],
    ["DELETED", buildUser({ status: "DELETED" })],
    ["BUSINESS_OWNER", buildUser({ role: "BUSINESS_OWNER" })],
    ["SUPER_ADMIN", buildUser({ role: "SUPER_ADMIN" })],
  ])("returns ERROR (no session) when the linked user is %s", async (_label, user) => {
    const { service } = makeService({
      link: { findByProviderAccount: vi.fn(async () => buildLink({ userId: user._id })) },
      user: { findById: vi.fn(async () => user) },
    });
    resolveCustomerAppleIdentity.mockResolvedValue(identity);
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});

describe("completeCallback — unknown identity", () => {
  it("CASE B: no email → ERROR, zero writes", async () => {
    const { service, userRepository, linkedAccountRepository } = makeService();
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
    expect(userRepository.create).not.toHaveBeenCalled();
    expect(linkedAccountRepository.create).not.toHaveBeenCalled();
  });

  it("CASE C: email present but NOT verified → ERROR, zero writes", async () => {
    const { service, userRepository } = makeService();
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      email: "x@y.com",
      emailVerified: false,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({ type: "ERROR" });
    expect(userRepository.findByEmail).not.toHaveBeenCalled();
  });

  it("CASE D: verified email already local → ACCOUNT_EXISTS, zero writes", async () => {
    const { service, userRepository, linkedAccountRepository } = makeService({
      user: { findByEmail: vi.fn(async () => buildUser()) },
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "new-sub",
      email: "pat@example.com",
      emailVerified: true,
    });
    expect(await service.completeCallback(await validInput(), context)).toEqual({
      type: "ACCOUNT_EXISTS",
    });
    expect(userRepository.findByEmail).toHaveBeenCalledWith("pat@example.com");
    expect(linkedAccountRepository.create).not.toHaveBeenCalled();
    expect(tokenService.createRefreshSession).not.toHaveBeenCalled();
  });
});
