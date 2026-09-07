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

// Only the Facebook OAuth client is mocked (the real-network seam). State signing + the nonce
// cookie stay REAL, so the CSRF binding is exercised end to end.
const {
  isCustomerFacebookAuthConfigured,
  buildCustomerFacebookAuthUrl,
  resolveCustomerFacebookIdentity,
} = vi.hoisted(() => ({
  isCustomerFacebookAuthConfigured: vi.fn(() => true),
  buildCustomerFacebookAuthUrl: vi.fn(
    (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
  ),
  resolveCustomerFacebookIdentity: vi.fn(),
}));

vi.mock("../../../src/modules/customer-facebook-auth/customer-facebook-auth.client.js", () => ({
  isCustomerFacebookAuthConfigured,
  buildCustomerFacebookAuthUrl,
  resolveCustomerFacebookIdentity,
}));

describe("HTTP-level Customer Facebook auth (start + callback)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START_URL = "/api/v1/auth/customer/oauth/facebook/start";
  const CALLBACK_URL = "/api/v1/auth/customer/oauth/facebook/callback";
  const FRONTEND_CB = "http://localhost:3000/auth/facebook/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isCustomerFacebookAuthConfigured.mockReturnValue(true);
    buildCustomerFacebookAuthUrl.mockImplementation(
      (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
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
    const dbStateReader = { getConnectionState: () => "connected" as const };
    app.use("/api/v1", createApiRouter(dbStateReader));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const runFlow = async (query: Record<string, string>, agent = request.agent(buildApp())) => {
    const startRes = await agent.get(START_URL);
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    return agent.get(CALLBACK_URL).query({ state: state ?? "", ...query });
  };

  it("start redirects to Facebook and sets an httpOnly nonce cookie", async () => {
    const res = await request(buildApp()).get(START_URL);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("facebook.com");
    expect(String(res.headers["set-cookie"])).toMatch(
      /bookly_refresh_token_oauth_nonce_facebook_customer=/,
    );
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/i);
  });

  it("start redirects status=error when Facebook auth is not configured", async () => {
    isCustomerFacebookAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START_URL);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
  });

  it("new Facebook customer: creates User(authProviders=[FACEBOOK], no passwordHash) + profile + link, refresh cookie, status=onboarding", async () => {
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-new-1",
      email: "New.Person@Example.com",
      emailVerified: true,
      displayName: "New Person",
      firstName: "New",
      lastName: "Person",
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=onboarding`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(res.headers["location"]).not.toMatch(/example\.com|token|@|fb-user/i);

    const user = await UserModel.findOne({ normalizedEmail: "new.person@example.com" })
      .select("+passwordHash")
      .lean();
    if (!user) {
      throw new Error("expected the new Facebook customer to be created");
    }
    expect(user).toMatchObject({
      role: "CUSTOMER",
      status: "ACTIVE",
      authProviders: ["FACEBOOK"],
    });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).toBeUndefined();
    expect(user.phoneVerifiedAt).toBeUndefined();

    const profile = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profile).toMatchObject({ firstName: "New", lastName: "Person", gender: "other" });
    expect(profile?.termsAcceptedAt).toBeInstanceOf(Date);

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "FACEBOOK",
      providerAccountId: "fb-user-new-1",
      email: "new.person@example.com",
      emailVerified: true,
      displayName: "New Person",
    });

    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it("existing linked customer: logs in (status=success), no duplicate user/link", async () => {
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
      provider: "FACEBOOK",
      providerAccountId: "fb-user-linked",
      email: "linked@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-linked",
      email: "linked@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=success`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await LinkedAccountModel.countDocuments({})).toBe(1);
  });

  it("existing linked customer logs in even when the fresh /me returned NO email", async () => {
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
      provider: "FACEBOOK",
      providerAccountId: "fb-user-noemail",
      email: "noemail-link@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-noemail",
      emailVerified: false,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=success`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
  });

  it("unknown identity + NO email: status=error, nothing created (no fake email)", async () => {
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-noemail-new",
      emailVerified: false,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await UserModel.countDocuments({})).toBe(0);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("email already registered without a Facebook link: status=account_exists, no writes, no session", async () => {
    await userRepository.create({
      normalizedEmail: "taken@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-unseen",
      email: "taken@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=account_exists`);
    expect(String(res.headers["set-cookie"] ?? "")).not.toMatch(/bookly_refresh_token=/);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("linked user is SUSPENDED: status=error, no session", async () => {
    const user = await userRepository.create({
      normalizedEmail: "susp@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "SUSPENDED",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: user._id,
      provider: "FACEBOOK",
      providerAccountId: "fb-user-susp",
      email: "susp@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-susp",
      email: "susp@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
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
      provider: "FACEBOOK",
      providerAccountId: "fb-user-owner",
      email: "owner-on-customer@example.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-user-owner",
      email: "owner-on-customer@example.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("forged / invalid state: status=error, resolver never called", async () => {
    const res = await request
      .agent(buildApp())
      .get(CALLBACK_URL)
      .query({ state: "forged-state", code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerFacebookIdentity).not.toHaveBeenCalled();
  });

  it("valid signed state but no nonce cookie (CSRF): status=error", async () => {
    const withCookie = request.agent(buildApp());
    const startRes = await withCookie.get(START_URL);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");

    const res = await request(buildApp())
      .get(CALLBACK_URL)
      .query({ state: state ?? "", code: "c" });

    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerFacebookIdentity).not.toHaveBeenCalled();
  });

  it("user denied consent (no code): status=error", async () => {
    const res = await runFlow({ error: "access_denied" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerFacebookIdentity).not.toHaveBeenCalled();
  });

  it("a GOOGLE-signed customer state cannot drive the Facebook callback", async () => {
    // A validly-signed Google customer state is meaningless to the Facebook verifier.
    const { signCustomerGoogleState } = await import(
      "../../../src/modules/customer-google-auth/customer-google-auth.state.js"
    );
    const googleState = await signCustomerGoogleState({ nonce: "x".repeat(20) });
    const res = await request(buildApp())
      .get(CALLBACK_URL)
      .query({ state: googleState, code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerFacebookIdentity).not.toHaveBeenCalled();
  });
});
