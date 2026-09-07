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
  isProfessionalAppleAuthConfigured,
  buildProfessionalAppleAuthUrl,
  resolveProfessionalAppleIdentity,
} = vi.hoisted(() => ({
  isProfessionalAppleAuthConfigured: vi.fn(() => true),
  buildProfessionalAppleAuthUrl: vi.fn(
    (state: string, nonce: string) =>
      `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
  ),
  resolveProfessionalAppleIdentity: vi.fn(),
}));

vi.mock("../../../src/modules/professional-apple-auth/professional-apple-auth.client.js", () => ({
  isProfessionalAppleAuthConfigured,
  buildProfessionalAppleAuthUrl,
  resolveProfessionalAppleIdentity,
}));

describe("HTTP-level Business Owner Apple auth (GET start + POST callback + completion)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  const passwordHasher = new Argon2PasswordHasher();

  const START = "/api/v1/auth/professional/oauth/apple/start";
  const CALLBACK = "/api/v1/auth/professional/oauth/apple/callback";
  const REG = "/api/v1/auth/professional/register";
  const FRONTEND_CB = "http://localhost:3000/auth/apple/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isProfessionalAppleAuthConfigured.mockReturnValue(true);
    buildProfessionalAppleAuthUrl.mockImplementation(
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
    app.use(express.urlencoded({ extended: true }));
    const dbStateReader = { getConnectionState: () => "connected" as const };
    app.use("/api/v1", createApiRouter(dbStateReader));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const runFlow = async (body: Record<string, string>, agent = request.agent(buildApp())) => {
    const startRes = await agent.get(START).query({ visitType: "location" });
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    const cb = await agent
      .post(CALLBACK)
      .type("form")
      .send({ state: state ?? "", ...body });
    return { cb, agent };
  };

  it("start requires visitType (400); otherwise 302s to Apple with no nonce cookie", async () => {
    expect((await request(buildApp()).get(START)).status).toBe(400);
    const ok = await request(buildApp()).get(START).query({ visitType: "location" });
    expect(ok.status).toBe(302);
    expect(ok.headers["location"]).toContain("appleid.apple.com");
    expect(String(ok.headers["set-cookie"] ?? "")).not.toMatch(/nonce/i);
  });

  it("start redirects status=error (flow=professional) when not configured", async () => {
    isProfessionalAppleAuthConfigured.mockReturnValue(false);
    const res = await request(buildApp()).get(START).query({ visitType: "travel" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
  });

  it("CASE 1 — new owner: seeds PROFESSIONAL/APPLE RegistrationSession (no User); onboarding completes into User(authProviders=[APPLE]) + LinkedAccount(APPLE) + Business", async () => {
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-owner-1",
      email: "New.Owner@Example.com",
      emailVerified: true,
    });

    const { cb, agent } = await runFlow({
      code: "auth-code",
      user: '{"name":{"firstName":"New","lastName":"Owner"}}',
    });

    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers["location"] as string);
    expect(loc.searchParams.get("flow")).toBe("professional");
    expect(loc.searchParams.get("status")).toBe("onboarding");
    expect(loc.searchParams.get("visitType")).toBe("location");
    const sessionId = loc.searchParams.get("sessionId") ?? "";
    expect(sessionId).toMatch(/^[a-f0-9]{24}$/);
    expect(cb.headers["location"]).not.toMatch(/example\.com|token|@|apple-owner/i);

    const session = await RegistrationSessionModel.findById(sessionId).lean();
    expect(session).toMatchObject({
      portal: "PROFESSIONAL",
      intendedRole: "BUSINESS_OWNER",
      authProvider: "APPLE",
      oauthProviderAccountId: "apple-owner-1",
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
      businessName: "Apple Owner Studio",
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
    if (!user) throw new Error("expected the Business Owner at completion");
    expect(user).toMatchObject({
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      authProviders: ["APPLE"],
    });
    expect(user.passwordHash).toBeUndefined();

    const profileRow = await UserProfileModel.findOne({ userId: user._id }).lean();
    expect(profileRow).toMatchObject({ firstName: "New", lastName: "Owner" });

    const link = await LinkedAccountModel.findOne({ userId: user._id }).lean();
    expect(link).toMatchObject({
      provider: "APPLE",
      providerAccountId: "apple-owner-1",
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
        provider: "APPLE",
        providerAccountId: `apple-linked-${role}`,
        email: owner.normalizedEmail,
        emailVerified: true,
        linkedAt: new Date(),
      });
      resolveProfessionalAppleIdentity.mockResolvedValue({
        providerAccountId: `apple-linked-${role}`,
        email: owner.normalizedEmail,
        emailVerified: true,
      });

      const { cb } = await runFlow({ code: "auth-code" });
      expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=success`);
      expect(String(cb.headers["set-cookie"])).toMatch(/bookly_refresh_token=/);
      expect(await RegistrationSessionModel.countDocuments({ authProvider: "APPLE" })).toBe(0);
    },
  );

  it("existing linked owner logs in with NO fresh email", async () => {
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
      provider: "APPLE",
      providerAccountId: "apple-owner-noemail",
      email: owner.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-owner-noemail",
      emailVerified: false,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=success`);
  });

  it("CASE 3 — verified email already registered (no Apple link): status=account_exists, no writes", async () => {
    await userRepository.create({
      normalizedEmail: "existing@example.com",
      passwordHash: await passwordHasher.hash("pw-123456"),
      authProviders: ["PASSWORD"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-unseen",
      email: "existing@example.com",
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=account_exists`);
    expect(await LinkedAccountModel.countDocuments({})).toBe(0);
    expect(await RegistrationSessionModel.countDocuments({ authProvider: "APPLE" })).toBe(0);
  });

  it("unknown identity + NO email → status=error, no RegistrationSession", async () => {
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-noemail-new",
      emailVerified: false,
    });
    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await RegistrationSessionModel.countDocuments({})).toBe(0);
  });

  it("unknown identity + UNVERIFIED email → status=error", async () => {
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-unverif",
      email: "unverified@example.com",
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
      provider: "APPLE",
      providerAccountId: "apple-customer",
      email: customer.normalizedEmail,
      emailVerified: true,
      linkedAt: new Date(),
    });
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-customer",
      email: customer.normalizedEmail,
      emailVerified: true,
    });

    const { cb } = await runFlow({ code: "auth-code" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it("callback body cannot override the signed visitType", async () => {
    resolveProfessionalAppleIdentity.mockResolvedValue({
      providerAccountId: "apple-visit-1",
      email: "visit@example.com",
      emailVerified: true,
    });
    const agent = request.agent(buildApp());
    const startRes = await agent.get(START).query({ visitType: "location" });
    const state = new URL(startRes.headers["location"] as string).searchParams.get("state");
    const cb = await agent
      .post(CALLBACK)
      .type("form")
      .send({ state: state ?? "", code: "auth-code", visitType: "travel" });

    const loc = new URL(cb.headers["location"] as string);
    expect(loc.searchParams.get("visitType")).toBe("location");
    const session = await RegistrationSessionModel.findById(
      loc.searchParams.get("sessionId") ?? "",
    ).lean();
    expect(session?.businessVisitType).toBe("AT_BUSINESS_LOCATION");
  });

  it("forged state: status=error, resolver never called", async () => {
    const res = await request(buildApp())
      .post(CALLBACK)
      .type("form")
      .send({ state: "forged", code: "auth-code" });
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=professional&status=error`);
    expect(resolveProfessionalAppleIdentity).not.toHaveBeenCalled();
  });
});
