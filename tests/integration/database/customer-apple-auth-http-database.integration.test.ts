import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { LinkedAccountModel } from "../../../src/modules/linked-account/linked-account.model.js";
import { LinkedAccountRepository } from "../../../src/modules/linked-account/linked-account.repository.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// Only the Apple OAuth client is mocked (the jose/JWKS/network seam). State signing stays REAL,
// so the state binding + the POST form_post transport are exercised end to end.
const { isCustomerAppleAuthConfigured, buildCustomerAppleAuthUrl, resolveCustomerAppleIdentity } =
  vi.hoisted(() => ({
    isCustomerAppleAuthConfigured: vi.fn(() => true),
    buildCustomerAppleAuthUrl: vi.fn(
      (state: string, nonce: string) =>
        `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
    ),
    resolveCustomerAppleIdentity: vi.fn(),
  }));

vi.mock("../../../src/modules/customer-apple-auth/customer-apple-auth.client.js", () => ({
  isCustomerAppleAuthConfigured,
  buildCustomerAppleAuthUrl,
  resolveCustomerAppleIdentity,
}));

describe("HTTP-level Customer Apple auth (GET start + POST form_post callback)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START_URL = "/api/v1/auth/customer/oauth/apple/start";
  const CALLBACK_URL = "/api/v1/auth/customer/oauth/apple/callback";
  const FRONTEND_CB = "http://localhost:3000/auth/apple/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isCustomerAppleAuthConfigured.mockReturnValue(true);
    buildCustomerAppleAuthUrl.mockImplementation(
      (state: string, nonce: string) =>
        `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
    );
    userRepository = new UserRepository();
    linkedAccountRepository = new LinkedAccountRepository();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true })); // Apple posts form_post (matches app.ts)
    const dbStateReader = { getConnectionState: () => "connected" as const };
    app.use("/api/v1", createApiRouter(dbStateReader));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  /** GET /start (captures state from the redirect), then POST the form_post callback body. */
  const runFlow = async (body: Record<string, string>) => {
    const startRes = await request(buildApp()).get(START_URL);
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    return request(buildApp())
      .post(CALLBACK_URL)
      .type("form")
      .send({ state: state ?? "", ...body });
  };

  it("start redirects to Apple (no nonce cookie)", async () => {
    const res = await request(buildApp()).get(START_URL);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("appleid.apple.com");
    expect(String(res.headers["set-cookie"] ?? "")).not.toMatch(/nonce/i);
  });

  it("start redirects status=error when not configured", async () => {
    isCustomerAppleAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START_URL);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
  });

  it("new Apple customer: creates User(authProviders=[APPLE], no passwordHash) + profile + link, refresh cookie, status=onboarding", async () => {
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-new-1",
      email: "New.Person@Example.com",
      emailVerified: true,
    });

    const res = await runFlow({
      code: "auth-code",
      user: '{"name":{"firstName":"New","lastName":"Person"}}',
    });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=onboarding`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(res.headers["location"]).not.toMatch(/example\.com|token|@|apple-sub/i);

    const user = await UserModel.findOne({ normalizedEmail: "new.person@example.com" })
      .select("+passwordHash")
      .lean();
    if (!user) throw new Error("expected the new Apple customer");
    expect(user).toMatchObject({ role: "CUSTOMER", status: "ACTIVE", authProviders: ["APPLE"] });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).toBeUndefined();

    const profile = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profile).toMatchObject({ firstName: "New", lastName: "Person", gender: "other" });
    expect(profile?.termsAcceptedAt).toBeInstanceOf(Date);

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "APPLE",
      providerAccountId: "apple-sub-new-1",
      email: "new.person@example.com",
      emailVerified: true,
    });
    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it("new Apple customer with a PRIVATE RELAY email: signup proceeds, relay stored", async () => {
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-relay",
      email: "abc123@privaterelay.appleid.com",
      emailVerified: true,
      isPrivateEmail: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=onboarding`);

    const link = await LinkedAccountModel.findOne({
      providerAccountId: "apple-sub-relay",
    }).lean();
    expect(link?.email).toBe("abc123@privaterelay.appleid.com");
    // Name absent → provider fallback, editable later.
    const user = await UserModel.findOne({
      normalizedEmail: "abc123@privaterelay.appleid.com",
    }).lean();
    if (!user) throw new Error("expected the relay-email customer");
    const profile = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profile).toMatchObject({ firstName: "Apple", lastName: "User" });
  });

  it("existing linked customer: logs in (status=success)", async () => {
    const user = await userRepository.create({
      normalizedEmail: "linked@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: user._id,
      provider: "APPLE",
      providerAccountId: "apple-sub-linked",
      email: "linked@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-linked",
      email: "linked@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=success`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await LinkedAccountModel.countDocuments({})).toBe(1);
  });

  it("existing linked customer logs in even when Apple returned NO fresh email", async () => {
    const user = await userRepository.create({
      normalizedEmail: "noemail-link@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: user._id,
      provider: "APPLE",
      providerAccountId: "apple-sub-noemail",
      email: "noemail-link@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-noemail",
      emailVerified: false,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=success`);
  });

  it("unknown identity + NO email: status=error, nothing created", async () => {
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-noemail-new",
      emailVerified: false,
    });
    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await UserModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("unknown identity + email present but NOT verified: status=error, nothing created", async () => {
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-unverif",
      email: "unverified@example.com",
      emailVerified: false,
    });
    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await UserModel.countDocuments({})).toBe(0);
  });

  it("verified email already registered without an Apple link: status=account_exists, no writes", async () => {
    await userRepository.create({
      normalizedEmail: "taken@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-unseen",
      email: "taken@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=account_exists`);
    expect(String(res.headers["set-cookie"] ?? "")).not.toMatch(/bookly_refresh_token=/);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("linked identity belongs to a BUSINESS_OWNER: rejected on the Customer portal (status=error)", async () => {
    const owner = await userRepository.create({
      normalizedEmail: "owner-on-customer@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: owner._id,
      provider: "APPLE",
      providerAccountId: "apple-sub-owner",
      email: owner.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-sub-owner",
      email: owner.normalizedEmail,
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("forged state: status=error, resolver never called", async () => {
    const res = await request(buildApp())
      .post(CALLBACK_URL)
      .type("form")
      .send({ state: "forged-state", code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerAppleIdentity).not.toHaveBeenCalled();
  });

  it("provider error in the body: status=error, resolver never called", async () => {
    const res = await runFlow({ error: "user_cancelled_authorize" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerAppleIdentity).not.toHaveBeenCalled();
  });

  it("a Google customer state cannot drive the Apple callback", async () => {
    const { signCustomerGoogleState } = await import(
      "../../../src/modules/customer-google-auth/customer-google-auth.state.js"
    );
    const googleState = await signCustomerGoogleState({ nonce: "x".repeat(20) });
    const res = await request(buildApp())
      .post(CALLBACK_URL)
      .type("form")
      .send({ state: googleState, code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerAppleIdentity).not.toHaveBeenCalled();
  });
});
