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

// Only the Google OAuth client is mocked (the one real-network seam). State signing + the nonce
// cookie stay REAL, so the CSRF binding is exercised end to end. `vi.hoisted` keeps the spies
// available to the hoisted `vi.mock` factory.
const {
  isCustomerGoogleAuthConfigured,
  buildCustomerGoogleAuthUrl,
  resolveCustomerGoogleIdentity,
} = vi.hoisted(() => ({
  isCustomerGoogleAuthConfigured: vi.fn(() => true),
  buildCustomerGoogleAuthUrl: vi.fn(
    (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  ),
  resolveCustomerGoogleIdentity: vi.fn(),
}));

vi.mock("../../../src/modules/customer-google-auth/customer-google-auth.client.js", () => ({
  isCustomerGoogleAuthConfigured,
  buildCustomerGoogleAuthUrl,
  resolveCustomerGoogleIdentity,
}));

describe("HTTP-level Customer Google auth (start + callback)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START_URL = "/api/v1/auth/customer/oauth/google/start";
  const CALLBACK_URL = "/api/v1/auth/customer/oauth/google/callback";
  const FRONTEND_CB = "http://localhost:3000/auth/google/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isCustomerGoogleAuthConfigured.mockReturnValue(true);
    buildCustomerGoogleAuthUrl.mockImplementation(
      (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
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

  /** Drives /start (captures the nonce cookie into the agent) then /callback with the given
   * Google identity mock already set. Returns the callback response. */
  const runFlow = async (query: Record<string, string>, agent = request.agent(buildApp())) => {
    const startRes = await agent.get(START_URL);
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    return agent.get(CALLBACK_URL).query({ state: state ?? "", ...query });
  };

  it("start redirects to Google and sets an httpOnly nonce cookie", async () => {
    const res = await request(buildApp()).get(START_URL);

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("accounts.google.com");
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token_oauth_nonce_customer=/);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/i);
  });

  it("start redirects with status=error when Google auth is not configured", async () => {
    isCustomerGoogleAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START_URL);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
  });

  it("new Google customer: creates User(authProviders=[GOOGLE], no passwordHash) + profile + link, sets refresh cookie, status=onboarding", async () => {
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-new-1",
      email: "New.Person@Gmail.com",
      emailVerified: true,
      displayName: "New Person",
      firstName: "New",
      lastName: "Person",
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=onboarding`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    // No sensitive data leaked in the redirect URL.
    expect(res.headers["location"]).not.toMatch(/gmail|token|@/i);

    const user = await UserModel.findOne({ normalizedEmail: "new.person@gmail.com" })
      .select("+passwordHash")
      .lean();
    if (!user) {
      throw new Error("expected the new Google customer to be created");
    }
    expect(user).toMatchObject({
      role: "CUSTOMER",
      status: "ACTIVE",
      authProviders: ["GOOGLE"],
    });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).toBeUndefined();
    expect(user.phoneVerifiedAt).toBeUndefined();

    const profile = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profile).toMatchObject({ firstName: "New", lastName: "Person", gender: "other" });
    expect(profile?.termsAcceptedAt).toBeInstanceOf(Date);

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "GOOGLE",
      providerAccountId: "google-sub-new-1",
      email: "new.person@gmail.com",
      emailVerified: true,
      displayName: "New Person",
    });

    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it("existing linked customer: logs in (status=success), no duplicate user/link created", async () => {
    const user = await userRepository.create({
      normalizedEmail: "linked@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: user._id,
      provider: "GOOGLE",
      providerAccountId: "google-sub-linked",
      email: "linked@gmail.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-linked",
      email: "linked@gmail.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=success`);
    expect(String(res.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await LinkedAccountModel.countDocuments({})).toBe(1);
  });

  it("email already registered without a Google link: status=account_exists, no writes, no session", async () => {
    await userRepository.create({
      normalizedEmail: "taken@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-unseen",
      email: "taken@gmail.com",
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
      normalizedEmail: "susp@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "SUSPENDED",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: user._id,
      provider: "GOOGLE",
      providerAccountId: "google-sub-susp",
      email: "susp@gmail.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-susp",
      email: "susp@gmail.com",
      emailVerified: true,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("unverified Google email: status=error, nothing created", async () => {
    resolveCustomerGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-unverified",
      email: "unverified@gmail.com",
      emailVerified: false,
    });

    const res = await runFlow({ code: "auth-code" });

    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(await UserModel.countDocuments({})).toBe(0);
    expect(resolveCustomerGoogleIdentity).toHaveBeenCalledTimes(1);
  });

  it("forged / invalid state: status=error, resolveCustomerGoogleIdentity never called", async () => {
    const res = await request
      .agent(buildApp())
      .get(CALLBACK_URL)
      .query({ state: "forged-state", code: "auth-code" });

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerGoogleIdentity).not.toHaveBeenCalled();
  });

  it("valid signed state but no nonce cookie (CSRF): status=error", async () => {
    // Fresh agent for /start (gets a cookie) — but replay the state on a DIFFERENT agent.
    const withCookie = request.agent(buildApp());
    const startRes = await withCookie.get(START_URL);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");

    const res = await request(buildApp())
      .get(CALLBACK_URL)
      .query({ state: state ?? "", code: "c" });

    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerGoogleIdentity).not.toHaveBeenCalled();
  });

  it("user denied consent (no code): status=error", async () => {
    const res = await runFlow({ error: "access_denied" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?status=error`);
    expect(resolveCustomerGoogleIdentity).not.toHaveBeenCalled();
  });
});
