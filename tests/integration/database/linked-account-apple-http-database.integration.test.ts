import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { LinkedAccountModel } from "../../../src/modules/linked-account/linked-account.model.js";
import { LinkedAccountRepository } from "../../../src/modules/linked-account/linked-account.repository.js";
import { signAppleLinkState } from "../../../src/modules/linked-account/linked-account.state.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// Only the Apple link client is mocked (jose/JWKS/network seam). State signing stays REAL.
const {
  isAppleAccountLinkConfigured,
  buildAppleAccountLinkAuthUrl,
  verifyAppleAccountLinkCallback,
} = vi.hoisted(() => ({
  isAppleAccountLinkConfigured: vi.fn(() => true),
  buildAppleAccountLinkAuthUrl: vi.fn(
    (state: string, nonce: string) =>
      `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
  ),
  verifyAppleAccountLinkCallback: vi.fn(),
}));

vi.mock("../../../src/modules/linked-account/apple-oauth.client.js", () => ({
  isAppleAccountLinkConfigured,
  buildAppleAccountLinkAuthUrl,
  verifyAppleAccountLinkCallback,
}));

describe("HTTP-level Customer → Apple account linking (linking only, POST form_post callback)", () => {
  let userRepository: UserRepository;
  let linkedAccountRepository: LinkedAccountRepository;
  let tokenService: TokenService;
  const passwordHasher = new Argon2PasswordHasher();

  const AUTHORIZE_URL = "/api/v1/auth/me/linked-accounts/apple/authorize-url";
  const UNLINK_URL = "/api/v1/auth/me/linked-accounts/apple";
  const CALLBACK_URL = "/api/v1/auth/oauth/apple/callback";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    isAppleAccountLinkConfigured.mockReturnValue(true);
    buildAppleAccountLinkAuthUrl.mockImplementation(
      (state: string, nonce: string) =>
        `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
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
    app.use(express.urlencoded({ extended: true }));
    const dbStateReader = { getConnectionState: () => "connected" as const };
    app.use("/api/v1", createApiRouter(dbStateReader));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  type TestRole = "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN";

  const createUser = async (role: TestRole, password?: string) =>
    userRepository.create({
      normalizedEmail: `user-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: password ? await passwordHasher.hash(password) : "unusable-hash",
      role,
      status: "ACTIVE",
    });

  /** An Apple-only user: no password hash, authProviders = ["APPLE"] (like a real Apple signup). */
  const createAppleOnlyUser = async (role: TestRole) =>
    userRepository.create({
      normalizedEmail: `apple-${new Types.ObjectId().toString()}@example.com`,
      role,
      status: "ACTIVE",
      authProviders: ["APPLE"],
    });

  const bearerFor = (userId: Types.ObjectId | string, role: TestRole) =>
    tokenService.createAccessToken({ userId, role }).then((token) => `Bearer ${token}`);

  const FRONTEND_CB = "http://localhost:3000/customer/settings";
  const validIdentity = (over: Record<string, unknown> = {}) => ({
    providerAccountId: "apple-link-sub-1",
    email: "linker@example.com",
    emailVerified: true,
    ...over,
  });

  describe("GET authorize-url", () => {
    it("401 without a token", async () => {
      expect((await request(buildApp()).get(AUTHORIZE_URL)).status).toBe(401);
    });

    it("allows CUSTOMER/BUSINESS_OWNER/SUPERVISOR/STAFF; SUPER_ADMIN → 403", async () => {
      for (const role of ["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const) {
        const u = await createUser(role);
        const res = await request(buildApp())
          .get(AUTHORIZE_URL)
          .set("Authorization", await bearerFor(u._id, role));
        expect(res.status).toBe(200);
        expect(res.body.data.authUrl).toContain("appleid.apple.com");
        // scope/state/nonce are baked by the mocked builder; assert state + nonce round-trip.
        expect(res.body.data.authUrl).toMatch(/state=.+&nonce=.+/);
      }
      const admin = await createUser("SUPER_ADMIN");
      const denied = await request(buildApp())
        .get(AUTHORIZE_URL)
        .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"));
      expect(denied.status).toBe(403);
    });

    it("503 when Apple linking is not configured", async () => {
      isAppleAccountLinkConfigured.mockReturnValue(false);
      const u = await createUser("CUSTOMER");
      const res = await request(buildApp())
        .get(AUTHORIZE_URL)
        .set("Authorization", await bearerFor(u._id, "CUSTOMER"));
      expect(res.status).toBe(503);
    });
  });

  describe("POST callback (form_post)", () => {
    it("400 → result=error for a forged state, writes nothing", async () => {
      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state: "forged", code: "c" });
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(`${FRONTEND_CB}?linkedAccount=apple&result=error`);
      expect(await LinkedAccountModel.countDocuments()).toBe(0);
      expect(verifyAppleAccountLinkCallback).not.toHaveBeenCalled();
    });

    it("links the verified Apple identity to the state's user → result=connected", async () => {
      const user = await createUser("CUSTOMER");
      const state = await signAppleLinkState({ userId: String(user._id), nonce: "nonce-1" });
      verifyAppleAccountLinkCallback.mockResolvedValue(validIdentity());

      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state, code: "auth-code", id_token: "tok" });

      expect(res.headers["location"]).toBe(`${FRONTEND_CB}?linkedAccount=apple&result=connected`);
      // the client wrapper is called with the state nonce
      expect(verifyAppleAccountLinkCallback).toHaveBeenCalledWith(
        expect.objectContaining({ code: "auth-code", idToken: "tok", nonce: "nonce-1" }),
      );
      const row = await LinkedAccountModel.findOne({ userId: user._id }).lean();
      expect(row).toMatchObject({
        provider: "APPLE",
        providerAccountId: "apple-link-sub-1",
        email: "linker@example.com",
      });
    });

    it("same Apple identity + same user → idempotent connected, no duplicate row", async () => {
      const user = await createUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-idem",
        email: "linker@example.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const state = await signAppleLinkState({ userId: String(user._id), nonce: "n" });
      verifyAppleAccountLinkCallback.mockResolvedValue(
        validIdentity({ providerAccountId: "apple-idem" }),
      );

      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state, code: "c" });
      expect(res.headers["location"]).toContain("result=connected");
      expect(await LinkedAccountModel.countDocuments({ userId: user._id })).toBe(1);
    });

    it("Apple identity already linked to another user → result=error, no write", async () => {
      const other = await createUser("CUSTOMER");
      const user = await createUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: other._id,
        provider: "APPLE",
        providerAccountId: "apple-taken",
        email: "other@example.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const state = await signAppleLinkState({ userId: String(user._id), nonce: "n" });
      verifyAppleAccountLinkCallback.mockResolvedValue(
        validIdentity({ providerAccountId: "apple-taken" }),
      );

      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state, code: "c" });
      expect(res.headers["location"]).toContain("result=error");
      expect(await LinkedAccountModel.countDocuments({ userId: user._id })).toBe(0);
    });

    it("user already has an Apple link → result=error", async () => {
      const user = await createUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-existing",
        email: "e@e.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const state = await signAppleLinkState({ userId: String(user._id), nonce: "n" });
      verifyAppleAccountLinkCallback.mockResolvedValue(
        validIdentity({ providerAccountId: "apple-new" }),
      );

      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state, code: "c" });
      expect(res.headers["location"]).toContain("result=error");
    });

    it("a GOOGLE link state cannot drive the Apple callback", async () => {
      const { signGoogleLinkState } = await import(
        "../../../src/modules/linked-account/linked-account.state.js"
      );
      const user = await createUser("CUSTOMER");
      const googleState = await signGoogleLinkState({ userId: String(user._id) });
      const res = await request(buildApp())
        .post(CALLBACK_URL)
        .type("form")
        .send({ state: googleState, code: "c" });
      expect(res.headers["location"]).toContain("result=error");
      expect(verifyAppleAccountLinkCallback).not.toHaveBeenCalled();
    });
  });

  describe("GET /auth/me linkedAccounts", () => {
    it("exposes the APPLE summary (email + linkedAt), never providerAccountId; coexists with GOOGLE + FACEBOOK", async () => {
      const user = await createUser("CUSTOMER", "pw-123456");
      for (const [provider, pid] of [
        ["GOOGLE", "g-sub"],
        ["FACEBOOK", "fb-sub"],
        ["APPLE", "apple-sub-me"],
      ] as const) {
        await linkedAccountRepository.create({
          userId: user._id,
          provider,
          providerAccountId: pid,
          email: `${provider.toLowerCase()}@example.com`,
          emailVerified: true,
          linkedAt: new Date("2026-09-01T08:00:00.000Z"),
        });
      }

      const res = await request(buildApp())
        .get("/api/v1/auth/me")
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"));

      const providers = (res.body.data.linkedAccounts as Array<{ provider: string }>)
        .map((a) => a.provider)
        .sort();
      expect(providers).toEqual(["APPLE", "FACEBOOK", "GOOGLE"]);
      expect(JSON.stringify(res.body.data.linkedAccounts)).not.toContain("apple-sub-me");
    });
  });

  describe("DELETE unlink", () => {
    it("wrong password → 400, keeps the row", async () => {
      const user = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-keep",
        email: "keep@example.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const res = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"))
        .send({ currentPassword: "wrong" });
      expect(res.status).toBe(400);
      expect(await LinkedAccountModel.countDocuments({ userId: user._id })).toBe(1);
    });

    it("404 when there is no APPLE row", async () => {
      const user = await createUser("CUSTOMER", "correct-horse");
      const res = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse" });
      expect(res.status).toBe(404);
    });

    it("removes ONLY the APPLE row, leaving GOOGLE", async () => {
      const user = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "GOOGLE",
        providerAccountId: "g-stays",
        email: "g@e.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-bye",
        email: "a@e.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const res = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse" });
      expect(res.status).toBe(200);
      const rows = await LinkedAccountModel.find({ userId: user._id }).lean();
      expect(rows.map((r) => r.provider)).toEqual(["GOOGLE"]);
    });

    it("last-credential guard: an APPLE-only user (no password) cannot unlink — row is kept", async () => {
      const user = await createAppleOnlyUser("CUSTOMER");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-only",
        email: "only@example.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const res = await request(buildApp())
        .delete(UNLINK_URL)
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"))
        .send({ currentPassword: "anything" });
      // No usable password → password re-auth fails (400) before the delete; the row is NOT removed.
      expect([400, 409]).toContain(res.status);
      expect(await LinkedAccountModel.countDocuments({ userId: user._id })).toBe(1);
    });
  });

  describe("account deletion cleanup", () => {
    it("DELETE /auth/me removes the APPLE row", async () => {
      const user = await createUser("CUSTOMER", "correct-horse");
      await linkedAccountRepository.create({
        userId: user._id,
        provider: "APPLE",
        providerAccountId: "apple-closing",
        email: "closing@example.com",
        emailVerified: true,
        linkedAt: new Date(),
      });
      const res = await request(buildApp())
        .delete("/api/v1/auth/me")
        .set("Authorization", await bearerFor(user._id, "CUSTOMER"))
        .send({ currentPassword: "correct-horse", confirmationText: "DELETE" });
      expect(res.status).toBe(200);
      expect(await LinkedAccountModel.countDocuments({ userId: user._id })).toBe(0);
    });
  });
});
