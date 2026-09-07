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
  isProfessionalFacebookAuthConfigured,
  buildProfessionalFacebookAuthUrl,
  resolveProfessionalFacebookIdentity,
} = vi.hoisted(() => ({
  isProfessionalFacebookAuthConfigured: vi.fn(() => true),
  buildProfessionalFacebookAuthUrl: vi.fn(
    (state: string) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
  ),
  resolveProfessionalFacebookIdentity: vi.fn(),
}));

vi.mock(
  "../../../src/modules/professional-facebook-auth/professional-facebook-auth.client.js",
  () => ({
    isProfessionalFacebookAuthConfigured,
    buildProfessionalFacebookAuthUrl,
    resolveProfessionalFacebookIdentity,
  }),
);

describe("HTTP-level Business Owner Facebook auth (start + callback + completion)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START = "/api/v1/auth/professional/oauth/facebook/start";
  const CALLBACK = "/api/v1/auth/professional/oauth/facebook/callback";
  const REG = "/api/v1/auth/professional/register";
  const FRONTEND_CB = "http://localhost:3000/auth/facebook/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isProfessionalFacebookAuthConfigured.mockReturnValue(true);
    buildProfessionalFacebookAuthUrl.mockImplementation(
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
    const startRes = await agent.get(START).query({ visitType: "location" });
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    const cb = await agent.get(CALLBACK).query({ state: state ?? "", ...query });
    return { cb, agent };
  };

  it("start requires visitType (400) and otherwise redirects to Facebook with an httpOnly nonce cookie", async () => {
    expect((await request(buildApp()).get(START)).status).toBe(400);

    const ok = await request(buildApp()).get(START).query({ visitType: "location" });
    expect(ok.status).toBe(302);
    expect(ok.headers["location"]).toContain("facebook.com");
    expect(String(ok.headers["set-cookie"])).toMatch(
      /bookly_refresh_token_oauth_nonce_facebook_professional=/,
    );
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/i);
  });

  it("start redirects status=error (flow=professional) when not configured", async () => {
    isProfessionalFacebookAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START).query({ visitType: "travel" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
  });

  it("CASE 1 — new owner: seeds a PROFESSIONAL/FACEBOOK RegistrationSession (NO User); onboarding then completes into User(authProviders=[FACEBOOK]) + LinkedAccount(FACEBOOK) + Business", async () => {
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-owner-1",
      email: "New.Owner@Example.com",
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
    expect(cb.headers["location"]).not.toMatch(/example\.com|token|@|fb-owner/i);

    const session = await RegistrationSessionModel.findById(sessionId).lean();
    expect(session).toMatchObject({
      portal: "PROFESSIONAL",
      intendedRole: "BUSINESS_OWNER",
      authProvider: "FACEBOOK",
      oauthProviderAccountId: "fb-owner-1",
      currentStep: "EMAIL_VERIFIED",
      businessVisitType: "AT_BUSINESS_LOCATION",
    });
    expect(session?.passwordHash).toBeUndefined();
    expect(session?.googleProviderAccountId).toBeUndefined();

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
      (await agent.post(`${REG}/verify-phone-otp`).send({ sessionId, code: "123456" })).status,
    ).toBe(200);

    const details = await agent.post(`${REG}/business-details`).send({
      sessionId,
      businessName: "Facebook Owner Studio",
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

    const user = await UserModel.findOne({ normalizedEmail: "new.owner@example.com" })
      .select("+passwordHash")
      .lean();
    if (!user) {
      throw new Error("expected the Business Owner to be created at completion");
    }
    expect(user).toMatchObject({
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      authProviders: ["FACEBOOK"],
    });
    expect(user.passwordHash).toBeUndefined();
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.phoneVerifiedAt).toBeInstanceOf(Date);

    const profileRow = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profileRow).toMatchObject({ firstName: "New", lastName: "Owner" });
    expect(profileRow?.termsAcceptedAt).toBeInstanceOf(Date);

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "FACEBOOK",
      providerAccountId: "fb-owner-1",
      email: "new.owner@example.com",
      emailVerified: true,
    });

    const business = await BusinessModel.findOne({ ownerUserId: user._id }).lean();
    expect(business).toMatchObject({ status: "PENDING", visitType: "AT_BUSINESS_LOCATION" });
    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it.each([["BUSINESS_OWNER"], ["SUPERVISOR"], ["STAFF"]] as const)(
    "CASE 2 — existing linked %s: logs in (status=success), no session-seed",
    async (role) => {
      const owner = await userRepository.create({
        normalizedEmail: `linked-${role.toLowerCase()}@example.com`,
        passwordHash: await passwordHasher.hash("pw-123456"),
        authProviders: ["PASSWORD"],
        role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      });
      await linkedAccountRepository.create({
        userId: owner._id,
        provider: "FACEBOOK",
        providerAccountId: `fb-linked-${role}`,
        email: owner.normalizedEmail,
        emailVerified: true,
        linkedAt: new Date(),
      });
      resolveProfessionalFacebookIdentity.mockResolvedValue({
        providerAccountId: `fb-linked-${role}`,
        email: owner.normalizedEmail,
        emailVerified: true,
      });

      const { cb } = await runFlow({ code: "auth-code" });
      expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=success`);
      expect(String(cb.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
      expect(await RegistrationSessionModel.countDocuments({ authProvider: "FACEBOOK" })).toBe(0);
    },
  );

  it("existing linked owner logs in even when the fresh /me returned NO email", async () => {
    const owner = await userRepository.create({
      normalizedEmail: "noemail-owner@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: owner._id,
      provider: "FACEBOOK",
      providerAccountId: "fb-owner-noemail",
      email: owner.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-owner-noemail",
      emailVerified: false,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=success`);
  });

  it("CASE 3 — email already registered (no Facebook link): status=account_exists, no writes", async () => {
    await userRepository.create({
      normalizedEmail: "existing@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-unseen",
      email: "existing@example.com",
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=account_exists`);
    expect(String(cb.headers["set-cookie"] ?? "")).not.toMatch(/bookly_refresh_token=/);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await RegistrationSessionModel.countDocuments({ authProvider: "FACEBOOK" })).toBe(0);
  });

  it("unknown identity + NO email: status=error, no RegistrationSession", async () => {
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-noemail-new",
      emailVerified: false,
    });
    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await RegistrationSessionModel.countDocuments({})).toBe(0);
  });

  it("linked identity belongs to a CUSTOMER: rejected on the Professional portal (status=error)", async () => {
    const customer = await userRepository.create({
      normalizedEmail: "cust-on-pro@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: customer._id,
      provider: "FACEBOOK",
      providerAccountId: "fb-customer",
      email: customer.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-customer",
      email: customer.normalizedEmail,
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("linked owner is SUSPENDED: status=error, no session", async () => {
    const owner = await userRepository.create({
      normalizedEmail: "susp-owner@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "SUSPENDED",
      emailVerifiedAt: new Date(),
    });
    await linkedAccountRepository.create({
      userId: owner._id,
      provider: "FACEBOOK",
      providerAccountId: "fb-susp-owner",
      email: owner.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-susp-owner",
      email: owner.normalizedEmail,
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("callback query cannot override the signed visitType", async () => {
    resolveProfessionalFacebookIdentity.mockResolvedValue({
      providerAccountId: "fb-visit-1",
      email: "visit@example.com",
      emailVerified: true,
      firstName: "V",
      lastName: "T",
    });

    // start with visitType=location; try to smuggle visitType=travel on the callback.
    const agent = request.agent(buildApp());
    const startRes = await agent.get(START).query({ visitType: "location" });
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    const cb = await agent
      .get(CALLBACK)
      .query({ state: state ?? "", code: "auth-code", visitType: "travel" });

    const loc = new URL(cb.headers["location"] as string);
    expect(loc.searchParams.get("visitType")).toBe("location");
    const session = await RegistrationSessionModel.findById(
      loc.searchParams.get("sessionId") ?? "",
    ).lean();
    expect(session?.businessVisitType).toBe("AT_BUSINESS_LOCATION");
  });

  it("forged state: status=error, resolver never called", async () => {
    const res = await request
      .agent(buildApp())
      .get(CALLBACK)
      .query({ state: "forged", code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(resolveProfessionalFacebookIdentity).not.toHaveBeenCalled();
  });

  it("denied consent (no code): status=error", async () => {
    const { cb } = await runFlow({ error: "access_denied" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(resolveProfessionalFacebookIdentity).not.toHaveBeenCalled();
  });
});
