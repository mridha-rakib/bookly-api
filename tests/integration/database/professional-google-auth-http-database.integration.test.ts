import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessOnboardingDraftModel } from "../../../src/modules/business-onboarding/business-onboarding.model.js";
import { LinkedAccountModel } from "../../../src/modules/linked-account/linked-account.model.js";
import { LinkedAccountRepository } from "../../../src/modules/linked-account/linked-account.repository.js";
import { RegistrationSessionModel } from "../../../src/modules/registration-session/registration-session.model.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const {
  isProfessionalGoogleAuthConfigured,
  buildProfessionalGoogleAuthUrl,
  resolveProfessionalGoogleIdentity,
} = vi.hoisted(() => ({
  isProfessionalGoogleAuthConfigured: vi.fn(() => true),
  buildProfessionalGoogleAuthUrl: vi.fn(
    (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  ),
  resolveProfessionalGoogleIdentity: vi.fn(),
}));

vi.mock("../../../src/modules/professional-google-auth/professional-google-auth.client.js", () => ({
  isProfessionalGoogleAuthConfigured,
  buildProfessionalGoogleAuthUrl,
  resolveProfessionalGoogleIdentity,
}));

describe("HTTP-level Business Owner Google auth (start + callback + completion)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START = "/api/v1/auth/professional/oauth/google/start";
  const CALLBACK = "/api/v1/auth/professional/oauth/google/callback";
  const REG = "/api/v1/auth/professional/register";
  const FRONTEND_CB = "http://localhost:3000/auth/google/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isProfessionalGoogleAuthConfigured.mockReturnValue(true);
    buildProfessionalGoogleAuthUrl.mockImplementation(
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

  const runFlow = async (query: Record<string, string>, agent = request.agent(buildApp())) => {
    const startRes = await agent.get(START).query({ visitType: "location" });
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    const cb = await agent.get(CALLBACK).query({ state: state ?? "", ...query });
    return { cb, agent };
  };

  it("start requires visitType (400) and otherwise redirects to Google with an httpOnly nonce cookie", async () => {
    const missing = await request(buildApp()).get(START);
    expect(missing.status).toBe(400);

    const ok = await request(buildApp()).get(START).query({ visitType: "location" });
    expect(ok.status).toBe(302);
    expect(ok.headers["location"]).toContain("accounts.google.com");
    expect(String(ok.headers["set-cookie"])).toMatch(
      /bookly_refresh_token_oauth_nonce_professional=/,
    );
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/i);
  });

  it("start redirects status=error (flow=professional) when not configured", async () => {
    isProfessionalGoogleAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START).query({ visitType: "travel" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
  });

  it("CASE 1 — new owner: callback seeds a PROFESSIONAL/GOOGLE RegistrationSession, NO User, and the existing onboarding then completes into User+LinkedAccount+Business", async () => {
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-owner-1",
      email: "New.Owner@Gmail.com",
      emailVerified: true,
      firstName: "New",
      lastName: "Owner",
    });

    const { cb, agent } = await runFlow({ code: "auth-code" });

    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers["location"] as string);
    expect(loc.searchParams.get("flow")).toBe("professional");
    expect(loc.searchParams.get("status")).toBe("onboarding");
    expect(loc.searchParams.get("visitType")).toBe("location");
    const sessionId = loc.searchParams.get("sessionId") ?? "";
    expect(sessionId).toMatch(/^[a-f0-9]{24}$/);
    expect(String(cb.headers["set-cookie"] ?? "")).not.toMatch(/bookly_refresh_token=/);

    const session = await RegistrationSessionModel.findById(sessionId).lean();
    expect(session).toMatchObject({
      portal: "PROFESSIONAL",
      intendedRole: "BUSINESS_OWNER",
      authProvider: "GOOGLE",
      googleProviderAccountId: "google-sub-owner-1",
      currentStep: "EMAIL_VERIFIED",
      businessVisitType: "AT_BUSINESS_LOCATION",
    });
    expect(session?.emailVerification.verifiedAt).toBeInstanceOf(Date);
    expect(session?.personalProfile).toMatchObject({ firstName: "New", lastName: "Owner" });
    expect(session?.passwordHash).toBeUndefined();

    // NO User yet (Option B).
    expect(await UserModel.countDocuments({})).toBe(0);
    const draft = await BusinessOnboardingDraftModel.findOne({
      registrationSessionId: sessionId,
    }).lean();
    expect(draft?.visitType).toBe("AT_BUSINESS_LOCATION");

    // Drive the EXISTING onboarding flow over HTTP — no password anywhere.
    const profile = await agent.post(`${REG}/profile`).send({
      sessionId,
      firstName: "New",
      lastName: "Owner",
      gender: "other",
      countryCode: "+357",
      nationalNumber: "99223344",
      agreeTerms: true,
    });
    expect(profile.status).toBe(200);

    expect((await agent.post(`${REG}/send-phone-otp`).send({ sessionId })).status).toBe(200);
    expect(
      (await agent.post(`${REG}/verify-phone-otp`).send({ sessionId, code: "1234" })).status,
    ).toBe(200);

    const details = await agent.post(`${REG}/business-details`).send({
      sessionId,
      businessName: "Google Owner Studio",
      ownerName: "New Owner",
      city: "Larnaca",
      countryCode: "+357",
      nationalNumber: "99887766",
      area: "Center",
      streetName: "Main",
      streetNumber: "1",
      briefDesc: "Integration test business",
    });
    expect(details.status).toBe(200);

    const categories = await agent.post(`${REG}/categories`).send({
      sessionId,
      selectedCategory: "Wellness",
      selectedSubcategories: ["Spa"],
    });
    expect(categories.status).toBe(200);

    const complete = await agent.post(`${REG}/complete`).send({ sessionId });
    expect(complete.status).toBe(201);
    expect(String(complete.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(complete.body.data.user.role).toBe("BUSINESS_OWNER");

    const user = await UserModel.findOne({ normalizedEmail: "new.owner@gmail.com" })
      .select("+passwordHash")
      .lean();
    if (!user) {
      throw new Error("expected the Business Owner to be created at completion");
    }
    expect(user).toMatchObject({
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      authProviders: ["GOOGLE"],
    });
    expect(user.passwordHash).toBeUndefined();
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);

    const profileRow = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profileRow).toMatchObject({ firstName: "New", lastName: "Owner" });
    expect(profileRow?.termsAcceptedAt).toBeInstanceOf(Date);

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "GOOGLE",
      providerAccountId: "google-sub-owner-1",
      email: "new.owner@gmail.com",
      emailVerified: true,
    });

    const business = await BusinessModel.findOne({ ownerUserId: user._id }).lean();
    expect(business).toMatchObject({ status: "PENDING", visitType: "AT_BUSINESS_LOCATION" });

    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it("CASE 2 — existing linked owner: logs in (status=success), no duplicate user/session-seed", async () => {
    const owner = await userRepository.create({
      normalizedEmail: "linkedowner@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: owner._id,
      provider: "GOOGLE",
      providerAccountId: "google-sub-linked-owner",
      email: "linkedowner@gmail.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-linked-owner",
      email: "linkedowner@gmail.com",
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });

    expect(cb.status).toBe(302);
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=success`);
    expect(String(cb.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(await RegistrationSessionModel.countDocuments({ authProvider: "GOOGLE" })).toBe(0);
  });

  it("CASE 3 — email already registered (no Google link): status=account_exists, no writes", async () => {
    await userRepository.create({
      normalizedEmail: "existing@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-unseen",
      email: "existing@gmail.com",
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });

    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=account_exists`);
    expect(String(cb.headers["set-cookie"] ?? "")).not.toMatch(/bookly_refresh_token=/);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await RegistrationSessionModel.countDocuments({ authProvider: "GOOGLE" })).toBe(0);
  });

  it("linked owner is SUSPENDED: status=error, no session", async () => {
    const owner = await userRepository.create({
      normalizedEmail: "susp-owner@gmail.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "SUSPENDED",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: owner._id,
      provider: "GOOGLE",
      providerAccountId: "google-sub-susp-owner",
      email: "susp-owner@gmail.com",
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-susp-owner",
      email: "susp-owner@gmail.com",
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("unverified Google email: status=error, nothing created", async () => {
    resolveProfessionalGoogleIdentity.mockResolvedValue({
      providerAccountId: "google-sub-unverified",
      email: "unverified@gmail.com",
      emailVerified: false,
    });
    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await RegistrationSessionModel.countDocuments({})).toBe(0);
  });

  it("forged state: status=error, resolveProfessionalGoogleIdentity never called", async () => {
    const res = await request
      .agent(buildApp())
      .get(CALLBACK)
      .query({ state: "forged", code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(resolveProfessionalGoogleIdentity).not.toHaveBeenCalled();
  });

  it("denied consent (no code): status=error", async () => {
    const { cb } = await runFlow({ error: "access_denied" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(resolveProfessionalGoogleIdentity).not.toHaveBeenCalled();
  });
});
