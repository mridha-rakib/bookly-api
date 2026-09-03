import express from "express";
import type { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { LinkedAccountModel } from "../../../src/modules/linked-account/linked-account.model.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffInvitationModel } from "../../../src/modules/staff-invitation/staff-invitation.model.js";
import { StaffInvitationRepository } from "../../../src/modules/staff-invitation/staff-invitation.repository.js";
import { StaffInvitationService } from "../../../src/modules/staff-invitation/staff-invitation.service.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const {
  isStaffInvitationGoogleConfigured,
  buildStaffInvitationGoogleAuthUrl,
  resolveStaffInvitationGoogleIdentity,
} = vi.hoisted(() => ({
  isStaffInvitationGoogleConfigured: vi.fn(() => true),
  buildStaffInvitationGoogleAuthUrl: vi.fn(
    (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  ),
  resolveStaffInvitationGoogleIdentity: vi.fn(),
}));

vi.mock("../../../src/modules/staff-invitation/staff-invitation-google.client.js", () => ({
  isStaffInvitationGoogleConfigured,
  buildStaffInvitationGoogleAuthUrl,
  resolveStaffInvitationGoogleIdentity,
}));

const GET_INFO = "/api/v1/auth/staff/invitation";
const ACCEPT_PW = "/api/v1/auth/staff/invitation/accept/password";
const G_START = "/api/v1/auth/staff/invitation/oauth/google/start";
const G_CALLBACK = "/api/v1/auth/staff/invitation/oauth/google/callback";
const FRONTEND_CB = "http://localhost:3000/auth/google/callback";

describe("HTTP-level Staff/Supervisor invitation acceptance (password + Google)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let invitationService: StaffInvitationService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isStaffInvitationGoogleConfigured.mockReturnValue(true);
    buildStaffInvitationGoogleAuthUrl.mockImplementation(
      (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    invitationService = new StaffInvitationService(new StaffInvitationRepository(), userRepository);
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ getConnectionState: () => "connected" as const }));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const seedOwnerAndBusiness = async () => {
    const owner = await userRepository.create({
      normalizedEmail: "owner@example.com",
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Soho Vintage Barbers",
      ownerName: "Blake Owner",
      email: "biz@example.com",
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great barbershop",
      category: "Wellness",
      subcategories: ["Barber"],
    } as never);
    return { owner, business };
  };

  const issueInvite = async (
    businessId: Types.ObjectId,
    invitedBy: Types.ObjectId,
    overrides: { email?: string; role?: "STAFF" | "SUPERVISOR" } = {},
  ) =>
    invitationService.issue({
      businessId,
      invitedByUserId: invitedBy,
      email: overrides.email ?? "sam@example.com",
      role: overrides.role ?? "STAFF",
      firstName: "Sam",
      lastName: "Cutter",
    });

  // --- token info ------------------------------------------------------------------------

  it("GET returns the business name, role and invited email for a valid token", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id, { role: "SUPERVISOR" });

    const res = await request(buildApp()).get(GET_INFO).query({ token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: "sam@example.com",
      role: "SUPERVISOR",
      businessName: "Soho Vintage Barbers",
    });
    expect(res.body.data).not.toHaveProperty("tokenHash");
  });

  it("GET 404s an unknown token and 410s an expired one", async () => {
    const { owner, business } = await seedOwnerAndBusiness();

    expect((await request(buildApp()).get(GET_INFO).query({ token: "nope" })).status).toBe(404);

    const { invitation, token } = await issueInvite(business._id, owner._id);
    await StaffInvitationModel.updateOne(
      { _id: invitation._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await request(buildApp()).get(GET_INFO).query({ token })).status).toBe(410);
  });

  // --- password acceptance ------------------------------------------------------------

  it("accept/password provisions User(PASSWORD)+Profile+Membership in one go, marks ACCEPTED, issues a session", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { invitation, token } = await issueInvite(business._id, owner._id, {
      role: "SUPERVISOR",
    });

    const res = await request(buildApp()).post(ACCEPT_PW).send({
      token,
      password: "s3cret-pass",
      firstName: "Sammy",
      lastName: "Cutter",
      countryCode: "+357",
      nationalNumber: "99887766",
      agreeTerms: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: "SUPERVISOR", status: "ACTIVE" });
    expect(res.body.data).not.toHaveProperty("refreshToken");
    expect(String(res.headers["set-cookie"] ?? "")).toMatch(/bookly_refresh_token=/);

    const user = await UserModel.findOne({ normalizedEmail: "sam@example.com" })
      .select("+passwordHash")
      .orFail();
    expect(user.role).toBe("SUPERVISOR");
    expect(user.authProviders).toEqual(["PASSWORD"]);
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);

    const profile = await UserProfileModel.findOne({ userId: user._id }).orFail();
    expect(profile).toMatchObject({ firstName: "Sammy", lastName: "Cutter" });
    expect(profile.phone?.e164).toBe("+35799887766");

    const membership = await StaffMembershipModel.findOne({ userId: user._id }).orFail();
    expect(membership).toMatchObject({
      businessId: business._id,
      role: "SUPERVISOR",
      createdByUserId: owner._id,
      employmentActive: true,
    });

    const acceptedInvite = await StaffInvitationModel.findById(invitation._id).orFail();
    expect(acceptedInvite.status).toBe("ACCEPTED");
    expect(String(acceptedInvite.acceptedUserId)).toBe(String(user._id));
    expect(acceptedInvite.authProvider).toBe("PASSWORD");

    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it("a role field in the accept body is rejected (strict schema) and the role always comes from the invitation", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id, { role: "STAFF" });

    const injected = await request(buildApp()).post(ACCEPT_PW).send({
      token,
      password: "s3cret-pass",
      firstName: "A",
      lastName: "B",
      agreeTerms: true,
      role: "BUSINESS_OWNER",
    });
    expect(injected.status).toBe(400);

    // A clean accept still lands as STAFF (from the invitation row).
    const ok = await request(buildApp())
      .post(ACCEPT_PW)
      .send({ token, password: "s3cret-pass", firstName: "A", lastName: "B", agreeTerms: true });
    expect(ok.status).toBe(201);
    const user = await UserModel.findOne({ normalizedEmail: "sam@example.com" }).orFail();
    expect(user.role).toBe("STAFF");
  });

  it("a token cannot be reused — the second accept fails and no second User is created", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);

    const first = await request(buildApp())
      .post(ACCEPT_PW)
      .send({ token, password: "s3cret-pass", firstName: "A", lastName: "B", agreeTerms: true });
    expect(first.status).toBe(201);

    const second = await request(buildApp())
      .post(ACCEPT_PW)
      .send({ token, password: "s3cret-pass", firstName: "A", lastName: "B", agreeTerms: true });
    expect(second.status).toBeGreaterThanOrEqual(400);

    expect(await UserModel.countDocuments({ normalizedEmail: "sam@example.com" })).toBe(1);
    expect(await StaffMembershipModel.countDocuments()).toBe(1);
  });

  it("agreeTerms must be true", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);
    const res = await request(buildApp())
      .post(ACCEPT_PW)
      .send({ token, password: "s3cret-pass", firstName: "A", lastName: "B", agreeTerms: false });
    expect(res.status).toBe(400);
  });

  // --- Google acceptance -----------------------------------------------------------------

  const runGoogleFlow = async (
    token: string,
    identity: Record<string, unknown> | null,
    agent = request.agent(buildApp()),
  ) => {
    const startRes = await agent.get(G_START).query({ token });
    expect(startRes.status).toBe(302);
    const url = new URL(startRes.headers["location"] as string);
    const state = url.searchParams.get("state") as string;
    if (identity) {
      resolveStaffInvitationGoogleIdentity.mockResolvedValue(identity);
    }
    const cb = await agent.get(G_CALLBACK).query({ code: "auth-code", state });
    return { cb, agent };
  };

  it("start requires a token and sets an httpOnly staff nonce cookie", async () => {
    const noToken = await request(buildApp()).get(G_START);
    expect(noToken.status).toBe(400);

    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);
    const res = await request(buildApp()).get(G_START).query({ token });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("accounts.google.com");
    const cookie = String(res.headers["set-cookie"] ?? "");
    expect(cookie).toMatch(/bookly_refresh_token_oauth_nonce_staff=/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("start with a dead token redirects to the frontend with status=expired (no consent round-trip)", async () => {
    const res = await request(buildApp()).get(G_START).query({ token: "dead" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=expired`);
  });

  it("Google callback (verified email == invited email) provisions User(GOOGLE)+LinkedAccount+Membership and marks ACCEPTED", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { invitation, token } = await issueInvite(business._id, owner._id, { role: "STAFF" });

    const { cb } = await runGoogleFlow(token, {
      providerAccountId: "google-sub-staff-1",
      email: "Sam@Example.com",
      emailVerified: true,
      firstName: "Sam",
      lastName: "Cutter",
    });

    expect(cb.status).toBe(302);
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=success`);
    expect(String(cb.headers["set-cookie"] ?? "")).toMatch(/bookly_refresh_token=/);

    const user = await UserModel.findOne({ normalizedEmail: "sam@example.com" })
      .select("+passwordHash")
      .orFail();
    expect(user.role).toBe("STAFF");
    expect(user.authProviders).toEqual(["GOOGLE"]);
    expect(user.passwordHash).toBeUndefined();

    const link = await LinkedAccountModel.findOne({ userId: user._id }).orFail();
    expect(link).toMatchObject({
      provider: "GOOGLE",
      providerAccountId: "google-sub-staff-1",
      emailVerified: true,
    });

    const membership = await StaffMembershipModel.findOne({ userId: user._id }).orFail();
    expect(membership).toMatchObject({ businessId: business._id, role: "STAFF" });

    const accepted = await StaffInvitationModel.findById(invitation._id).orFail();
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.authProvider).toBe("GOOGLE");
    expect(accepted.googleProviderAccountId).toBe("google-sub-staff-1");
  });

  it("GET /auth/me returns linkedAccounts for a SUPERVISOR/STAFF (Phase 3 P0 — was CUSTOMER/OWNER only)", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id, { role: "SUPERVISOR" });

    const agent = request.agent(buildApp());
    await runGoogleFlow(
      token,
      {
        providerAccountId: "google-sub-sup-1",
        email: "sam@example.com",
        emailVerified: true,
        firstName: "Sam",
        lastName: "Cutter",
      },
      agent,
    );

    // The Google acceptance left a refresh cookie on the agent — exchange it for an access token.
    const refreshed = await agent.post("/api/v1/auth/refresh");
    expect(refreshed.status).toBe(200);

    const me = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${refreshed.body.data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe("SUPERVISOR");
    expect(me.body.data.linkedAccounts).toEqual([
      expect.objectContaining({ provider: "GOOGLE", email: "sam@example.com" }),
    ]);
  });

  it("Google callback with a MISMATCHED email provisions nothing and redirects status=email_mismatch", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);

    const { cb } = await runGoogleFlow(token, {
      providerAccountId: "google-sub-other",
      email: "someone.else@gmail.com",
      emailVerified: true,
    });

    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=email_mismatch`);
    expect(await UserModel.countDocuments({ role: { $in: ["STAFF", "SUPERVISOR"] } })).toBe(0);
    expect(await StaffMembershipModel.countDocuments()).toBe(0);
    expect(await LinkedAccountModel.countDocuments()).toBe(0);
  });

  it("Google callback with an UNVERIFIED email redirects status=error and provisions nothing", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);

    const { cb } = await runGoogleFlow(token, {
      providerAccountId: "google-sub-x",
      email: "sam@example.com",
      emailVerified: false,
    });

    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=error`);
    expect(await StaffMembershipModel.countDocuments()).toBe(0);
  });

  it("Google callback with a forged state redirects status=error", async () => {
    const cb = await request(buildApp())
      .get(G_CALLBACK)
      .query({ code: "auth-code", state: "forged.state.token" });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=error`);
  });

  it("Google callback for a consumed invitation redirects status=expired", async () => {
    const { owner, business } = await seedOwnerAndBusiness();
    const { token } = await issueInvite(business._id, owner._id);

    // Get a valid state first, then consume the invitation via the password path.
    const agent = request.agent(buildApp());
    const startRes = await agent.get(G_START).query({ token });
    const state = new URL(startRes.headers["location"] as string).searchParams.get(
      "state",
    ) as string;

    await request(buildApp())
      .post(ACCEPT_PW)
      .send({ token, password: "s3cret-pass", firstName: "A", lastName: "B", agreeTerms: true });

    resolveStaffInvitationGoogleIdentity.mockResolvedValue({
      providerAccountId: "sub-late",
      email: "sam@example.com",
      emailVerified: true,
    });
    const cb = await agent.get(G_CALLBACK).query({ code: "auth-code", state });
    expect(cb.headers["location"]).toBe(`${FRONTEND_CB}?flow=staff&status=expired`);
  });
});
