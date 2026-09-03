import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { LinkedAccountModel } from "../../../src/modules/linked-account/linked-account.model.js";
import { LinkedAccountRepository } from "../../../src/modules/linked-account/linked-account.repository.js";
import { signGoogleLinkState } from "../../../src/modules/linked-account/linked-account.state.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// The OAuth client is the only seam that would make a real network call — mock it so the callback
// success path is exercisable. State signing/verification stays REAL (see signGoogleLinkState
// import above), so the userId binding is genuinely tested end to end. `vi.hoisted` keeps the
// spies available to the hoisted `vi.mock` factory.
const {
  isGoogleAccountLinkConfigured,
  buildGoogleAccountLinkAuthUrl,
  verifyGoogleAccountLinkCallback,
} = vi.hoisted(() => ({
  isGoogleAccountLinkConfigured: vi.fn(() => true),
  buildGoogleAccountLinkAuthUrl: vi.fn(
    (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  ),
  verifyGoogleAccountLinkCallback: vi.fn(),
}));

vi.mock("../../../src/modules/linked-account/google-oauth.client.js", () => ({
  isGoogleAccountLinkConfigured,
  buildGoogleAccountLinkAuthUrl,
  verifyGoogleAccountLinkCallback,
}));

describe("HTTP-level Customer → Google account linking", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  let tokenService: TokenService;
  const passwordHasher = new Argon2PasswordHasher();

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isGoogleAccountLinkConfigured.mockReturnValue(true);
    buildGoogleAccountLinkAuthUrl.mockImplementation(
      (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );
    userRepository = new UserRepository();
    linkedAccountRepository = new LinkedAccountRepository();
    tokenService = new TokenService(new SessionRepository());
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

  const createUser = async (role: "CUSTOMER" | "BUSINESS_OWNER", password?: string) =>
    userRepository.create({
      normalizedEmail: `user-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: password ? await passwordHasher.hash(password) : "unusable-hash",
      role,
      status: "ACTIVE",
    });

  const bearerFor = (userId: Types.ObjectId | string, role: "CUSTOMER" | "BUSINESS_OWNER") =>
    tokenService.createAccessToken({ userId, role }).then((token) => `Bearer ${token}`);

  const AUTHORIZE_URL = "/api/v1/auth/me/linked-accounts/google/authorize-url";
  const UNLINK_URL = "/api/v1/auth/me/linked-accounts/google";
  const CALLBACK_URL = "/api/v1/auth/oauth/google/callback";

  describe("unique indexes", () => {
    it("blocks the same Google identity being linked to two users", async () => {
      const providerAccountId = "google-sub-shared";
      await linkedAccountRepository.create({
        userId: new Types.ObjectId(),
        provider: "GOOGLE",
        providerAccountId,
        email: "a@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });

      await expect(
        linkedAccountRepository.create({
          userId: new Types.ObjectId(),
          provider: "GOOGLE",
          providerAccountId,
          email: "b@gmail.com",
          emailVerified: true,
          linkedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it("blocks a single user linking two Google accounts", async () => {
      const userId = new Types.ObjectId();
      await linkedAccountRepository.create({
        userId,
        provider: "GOOGLE",
        providerAccountId: "sub-1",
        email: "a@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });

      await expect(
        linkedAccountRepository.create({
          userId,
          provider: "GOOGLE",
          providerAccountId: "sub-2",
          email: "a2@gmail.com",
          emailVerified: true,
          linkedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe("GET authorize-url", () => {
    it("rejects an unauthenticated caller (401)", async () => {
      const response = await request(buildApp()).get(AUTHORIZE_URL);
      expect(response.status).toBe(401);
    });

    it("rejects a non-CUSTOMER caller (403)", async () => {
      const owner = await createUser("BUSINESS_OWNER");
      const response = await request(buildApp())
        .get(AUTHORIZE_URL)
        .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
      expect(response.status).toBe(403);
    });

    it("returns 503 when linking is not configured on the server", async () => {
      isGoogleAccountLinkConfigured.mockReturnValue(false);
      const customer = await createUser("CUSTOMER");

      const response = await request(buildApp())
        .get(AUTHORIZE_URL)
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

      expect(response.status).toBe(503);
    });

    it("returns a Google consent URL carrying a state bound to the caller for a CUSTOMER", async () => {
      const customer = await createUser("CUSTOMER");

      const response = await request(buildApp())
        .get(AUTHORIZE_URL)
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

      expect(response.status).toBe(200);
      expect(response.body.data.authUrl).toContain("accounts.google.com");
      expect(buildGoogleAccountLinkAuthUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET callback", () => {
    it("400s when no state param is present (validation layer, not 401)", async () => {
      const response = await request(buildApp()).get(CALLBACK_URL);
      expect(response.status).toBe(400);
    });

    it("redirects with result=error for a forged state, writing nothing", async () => {
      const response = await request(buildApp())
        .get(CALLBACK_URL)
        .query({ state: "forged", code: "abc" });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toContain("linkedAccount=google");
      expect(response.headers["location"]).toContain("result=error");
      expect(await LinkedAccountModel.countDocuments()).toBe(0);
    });

    it("redirects with result=error when the user denied consent (no code)", async () => {
      const customer = await createUser("CUSTOMER");
      const state = await signGoogleLinkState({ userId: String(customer._id) });

      const response = await request(buildApp())
        .get(CALLBACK_URL)
        .query({ state, error: "access_denied" });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toContain("result=error");
      expect(verifyGoogleAccountLinkCallback).not.toHaveBeenCalled();
    });

    it("links the verified Google identity to the state's user and redirects result=connected", async () => {
      const customer = await createUser("CUSTOMER");
      const state = await signGoogleLinkState({ userId: String(customer._id) });
      verifyGoogleAccountLinkCallback.mockResolvedValue({
        providerAccountId: "google-sub-42",
        email: "Person@Gmail.com",
        emailVerified: true,
        displayName: "Person Example",
      });

      const response = await request(buildApp())
        .get(CALLBACK_URL)
        .query({ state, code: "auth-code" });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toContain("result=connected");

      const row = await LinkedAccountModel.findOne({ userId: customer._id }).lean();
      expect(row).toMatchObject({
        provider: "GOOGLE",
        providerAccountId: "google-sub-42",
        email: "person@gmail.com",
        emailVerified: true,
        displayName: "Person Example",
      });
    });

    it("redirects result=error when the Google identity already belongs to another user", async () => {
      const other = await createUser("CUSTOMER");
      const customer = await createUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: other._id,
        provider: "GOOGLE",
        providerAccountId: "google-sub-taken",
        email: "taken@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const state = await signGoogleLinkState({ userId: String(customer._id) });
      verifyGoogleAccountLinkCallback.mockResolvedValue({
        providerAccountId: "google-sub-taken",
        email: "taken@gmail.com",
        emailVerified: true,
      });

      const response = await request(buildApp())
        .get(CALLBACK_URL)
        .query({ state, code: "auth-code" });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toContain("result=error");
      expect(await LinkedAccountModel.countDocuments({ userId: customer._id })).toBe(0);
    });
  });

  describe("GET /auth/me linkedAccounts", () => {
    it("is an empty array for a customer with no link", async () => {
      const customer = await createUser("CUSTOMER");
      const response = await request(buildApp())
        .get("/api/v1/auth/me")
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

      expect(response.status).toBe(200);
      expect(response.body.data.linkedAccounts).toEqual([]);
    });

    it("reflects the linked Google account (email + displayName, never providerAccountId)", async () => {
      const customer = await createUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: customer._id,
        provider: "GOOGLE",
        providerAccountId: "google-sub-me",
        email: "me@gmail.com",
        emailVerified: true,
        displayName: "Me Example",
        linkedAt: new Date("2026-09-01T08:00:00.000Z"),
      });

      const response = await request(buildApp())
        .get("/api/v1/auth/me")
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

      expect(response.body.data.linkedAccounts).toEqual([
        {
          provider: "GOOGLE",
          email: "me@gmail.com",
          displayName: "Me Example",
          linkedAt: "2026-09-01T08:00:00.000Z",
        },
      ]);
      expect(JSON.stringify(response.body.data.linkedAccounts)).not.toContain("google-sub-me");
    });
  });

  describe("DELETE unlink", () => {
    it("rejects an unauthenticated caller (401)", async () => {
      const response = await request(buildApp()).delete(UNLINK_URL).send({ currentPassword: "x" });
      expect(response.status).toBe(401);
    });

    it("rejects a wrong current password (400) and keeps the link", async () => {
      const customer = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: customer._id,
        provider: "GOOGLE",
        providerAccountId: "google-sub-keep",
        email: "keep@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });

      const response = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
        .send({ currentPassword: "wrong" });

      expect(response.status).toBe(400);
      expect(await LinkedAccountModel.countDocuments({ userId: customer._id })).toBe(1);
    });

    it("404s when there is no linked Google account", async () => {
      const customer = await createUser("CUSTOMER", "correct-horse");

      const response = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse" });

      expect(response.status).toBe(404);
    });

    it("unlinks on a correct password", async () => {
      const customer = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: customer._id,
        provider: "GOOGLE",
        providerAccountId: "google-sub-bye",
        email: "bye@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });

      const response = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse" });

      expect(response.status).toBe(200);
      expect(await LinkedAccountModel.countDocuments({ userId: customer._id })).toBe(0);
    });
  });

  describe("account deletion cleanup", () => {
    it("removes the linked Google account row when the customer closes their account", async () => {
      const customer = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: customer._id,
        provider: "GOOGLE",
        providerAccountId: "google-sub-closing",
        email: "closing@gmail.com",
        emailVerified: true,
        linkedAt: new Date(),
      });

      const response = await request(buildApp())
        .delete("/api/v1/auth/me")
        .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse", confirmationText: "DELETE" });

      expect(response.status).toBe(200);
      expect(await LinkedAccountModel.countDocuments({ userId: customer._id })).toBe(0);
    });
  });
});
