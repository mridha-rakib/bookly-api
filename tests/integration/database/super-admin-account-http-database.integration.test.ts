import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createAuthRoute } from "../../../src/modules/auth/auth.route.js";
import { sha256 } from "../../../src/modules/auth/auth.utils.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Phase 1 — Super Admin Settings → Admin Account, plus (Phase 1, Business Settings) Business
 * Owner/Supervisor/Staff "Update Password". Exercises the real /auth routes end to end (auth
 * middleware, the `requireRoles(["CUSTOMER", "SUPER_ADMIN"])` gate on PATCH /auth/me, the wider
 * `requireRoles(["CUSTOMER", "SUPER_ADMIN", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"])` gate on
 * PATCH /auth/me/password, zod `.strict()` validation, the Argon2 verify+rehash path). The whole
 * point is proving the HTTP authorization boundary and persistence actually hold — services are
 * never called directly.
 */
describe("HTTP-level Super Admin Settings — Admin Account (Phase 1)", () => {
  let userRepository: UserRepository;
  let tokenService: TokenService;
  const passwordHasher = new Argon2PasswordHasher();

  const CURRENT_PASSWORD = "super-secret-current";

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (userId: Types.ObjectId | string, role: UserRole) =>
    `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const loginPathFor = (role: UserRole): string =>
    role === "SUPER_ADMIN"
      ? "/auth/super-admin/login"
      : role === "CUSTOMER"
        ? "/auth/customer/login"
        : "/auth/professional/login";

  const refreshCookieFrom = (response: request.Response): string => {
    const setCookie = response.headers["set-cookie"] as unknown as string[] | undefined;
    const cookie = setCookie?.find((value) => value.startsWith("bookly_refresh_token="));
    if (!cookie) {
      throw new Error("Expected a bookly_refresh_token Set-Cookie header");
    }
    return cookie;
  };

  /** Pulls the raw refresh-token value out of a `bookly_refresh_token=<value>; Path=...` cookie
   * header string, mirroring how the app's own getRefreshTokenFromRequest parses it. */
  const extractCookieValue = (setCookieHeader: string): string => {
    const [pair] = setCookieHeader.split(";");
    return (pair ?? "").split("=").slice(1).join("=");
  };

  /** Logs in for real over HTTP so the resulting refresh session is a genuine SessionModel row
   * tied to a real refresh-token cookie, exactly like a browser session. */
  const loginSession = async (app: express.Express, email: string, role: UserRole) => {
    const response = await request(app)
      .post(loginPathFor(role))
      .send({ email, password: CURRENT_PASSWORD });
    expect(response.status).toBe(200);
    return {
      accessToken: response.body.data.accessToken as string,
      refreshCookie: refreshCookieFrom(response),
    };
  };

  const createUserWithProfile = async (
    role: UserRole,
    overrides: { firstName?: string; lastName?: string } = {},
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: await passwordHasher.hash(CURRENT_PASSWORD),
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: overrides.firstName ?? "Root",
      lastName: overrides.lastName ?? "Admin",
      gender: "other",
    });
    return user;
  };

  // --- Read -----------------------------------------------------------------------------------

  it("GET /auth/me returns the Super Admin's real profile with defaultLanguage defaulted to EN", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN", {
      firstName: "Georgino",
      lastName: "Mansour",
    });
    const app = buildApp();

    const response = await request(app)
      .get("/auth/me")
      .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({
      email: admin.normalizedEmail,
      role: "SUPER_ADMIN",
    });
    expect(response.body.data.profile).toMatchObject({
      firstName: "Georgino",
      lastName: "Mansour",
      fullName: "Georgino Mansour",
      defaultLanguage: "EN",
    });
    // Phase 1 (Business Settings) — lets Settings → Security & 2FA render "Update Password" vs.
    // the OAuth-only state without a separate request.
    expect(response.body.data.user).toMatchObject({ hasPassword: true });
  });

  it("GET /auth/me reports hasPassword: false for an OAuth-only account", async () => {
    const owner = await userRepository.create({
      normalizedEmail: `oauth-only-${new Types.ObjectId().toString()}@example.com`,
      authProviders: ["GOOGLE"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    const app = buildApp();

    const response = await request(app)
      .get("/auth/me")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({ hasPassword: false });
  });

  // --- Profile update -----------------------------------------------------------------------

  it("PATCH /auth/me persists a Super Admin name + defaultLanguage change to MongoDB", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();
    const auth = await bearerFor(admin._id, "SUPER_ADMIN");

    const response = await request(app)
      .patch("/auth/me")
      .set("Authorization", auth)
      .send({ firstName: "Georgino", lastName: "Mansour", defaultLanguage: "GR" });

    expect(response.status).toBe(200);
    expect(response.body.data.profile).toMatchObject({
      fullName: "Georgino Mansour",
      defaultLanguage: "GR",
    });

    const persisted = await UserProfileModel.findOne({ userId: admin._id }).orFail();
    expect(persisted.firstName).toBe("Georgino");
    expect(persisted.lastName).toBe("Mansour");
    expect(persisted.defaultLanguage).toBe("GR");

    // A fresh read reflects the change (no stale local copy).
    const reread = await request(app).get("/auth/me").set("Authorization", auth);
    expect(reread.body.data.profile).toMatchObject({
      fullName: "Georgino Mansour",
      defaultLanguage: "GR",
    });
  });

  it("PATCH /auth/me rejects an unknown field with 400 and never touches the profile", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const response = await request(app)
      .patch("/auth/me")
      .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"))
      .send({ firstName: "Georgino", role: "CUSTOMER", commissionRate: 5 });

    expect(response.status).toBe(400);
    const persisted = await UserProfileModel.findOne({ userId: admin._id }).orFail();
    expect(persisted.firstName).toBe("Root");
  });

  it("PATCH /auth/me rejects an invalid defaultLanguage with 400", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const response = await request(app)
      .patch("/auth/me")
      .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"))
      .send({ defaultLanguage: "FR" });

    expect(response.status).toBe(400);
  });

  // --- Change password --------------------------------------------------------------------

  it("PATCH /auth/me/password verifies the current password, rehashes, and leaks no hash", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const before = await userRepository.findByIdWithPassword(admin._id);

    const response = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"))
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "a-brand-new-password" });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("argon2");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");

    const after = await userRepository.findByIdWithPassword(admin._id);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).toMatch(/^\$argon2id\$/);

    // Old password no longer logs in; the new one does.
    const oldLogin = await request(app)
      .post("/auth/super-admin/login")
      .send({ email: admin.normalizedEmail, password: CURRENT_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/auth/super-admin/login")
      .send({ email: admin.normalizedEmail, password: "a-brand-new-password" });
    expect(newLogin.status).toBe(200);
  });

  it("PATCH /auth/me/password rejects a wrong current password with 400 and never changes the hash", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();
    const before = await userRepository.findByIdWithPassword(admin._id);

    const response = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"))
      .send({ currentPassword: "not-the-current-password", newPassword: "irrelevant-new-one" });

    expect(response.status).toBe(400);
    const after = await userRepository.findByIdWithPassword(admin._id);
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });

  // --- Session hardening (Phase 1 continuation) ------------------------------------------
  //
  // Supersedes the old "a Super Admin password change does NOT revoke the caller's other
  // sessions" contract: password change is now a security-sensitive event that revokes every
  // OTHER active refresh session for the account, while preserving the session that made the
  // change (identified by the real refresh-token cookie on the request, never a client-supplied
  // id). Same semantics for every role — no forking by CUSTOMER/SUPER_ADMIN/BUSINESS_OWNER/
  // SUPERVISOR/STAFF.

  it("PATCH /auth/me/password revokes another active session but preserves the caller's own (SUPER_ADMIN)", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    // Session A: the one that will perform the password change.
    const sessionA = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    // Session B: a second, independent device/browser login for the same account.
    const sessionB = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");

    const changed = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${sessionA.accessToken}`)
      .set("Cookie", sessionA.refreshCookie)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "yet-another-password" });
    expect(changed.status).toBe(200);

    // Hard-assert the underlying SessionModel state BEFORE calling /auth/refresh — a refresh
    // rotates (and marks revoked) the row it consumes as a normal side effect, which would
    // otherwise be indistinguishable from the password-change revocation this test is proving.
    const sessionRepository = new SessionRepository();
    const rowA = await sessionRepository.findByRefreshTokenHash(
      sha256(decodeURIComponent(extractCookieValue(sessionA.refreshCookie))),
    );
    expect(rowA?.revokedAt).toBeUndefined();
    const rowB = await sessionRepository.findByRefreshTokenHash(
      sha256(decodeURIComponent(extractCookieValue(sessionB.refreshCookie))),
    );
    expect(rowB?.revokedAt).toBeInstanceOf(Date);

    // AFTER: Session A (the caller) can still refresh.
    const refreshA = await request(app).post("/auth/refresh").set("Cookie", sessionA.refreshCookie);
    expect(refreshA.status).toBe(200);
    expect(refreshA.body.data.user).toMatchObject({ id: String(admin._id), role: "SUPER_ADMIN" });

    // AFTER: Session B (the other device) is revoked and can no longer refresh.
    const refreshB = await request(app).post("/auth/refresh").set("Cookie", sessionB.refreshCookie);
    expect(refreshB.status).toBe(401);
  });

  it("PATCH /auth/me/password revokes multiple other sessions and leaves an unrelated user's session untouched", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const otherAdmin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const sessionA = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    const sessionB = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    const sessionC = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    // An unrelated user's own session must never be touched by admin's password change.
    const otherUserSession = await loginSession(app, otherAdmin.normalizedEmail, "SUPER_ADMIN");

    const changed = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${sessionA.accessToken}`)
      .set("Cookie", sessionA.refreshCookie)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "brand-new-password-2" });
    expect(changed.status).toBe(200);

    const refreshA = await request(app).post("/auth/refresh").set("Cookie", sessionA.refreshCookie);
    expect(refreshA.status).toBe(200);

    const refreshB = await request(app).post("/auth/refresh").set("Cookie", sessionB.refreshCookie);
    expect(refreshB.status).toBe(401);

    const refreshC = await request(app).post("/auth/refresh").set("Cookie", sessionC.refreshCookie);
    expect(refreshC.status).toBe(401);

    // The unrelated user's session is completely unaffected.
    const refreshOther = await request(app)
      .post("/auth/refresh")
      .set("Cookie", otherUserSession.refreshCookie);
    expect(refreshOther.status).toBe(200);
    expect(refreshOther.body.data.user).toMatchObject({ id: String(otherAdmin._id) });
  });

  it("does not revoke any session when the current password is wrong, the new password is unchanged, or the account is OAuth-only", async () => {
    const app = buildApp();

    // Wrong current password.
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const adminSession = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    const sessionRepository = new SessionRepository();
    const adminSessionHash = sha256(
      decodeURIComponent(extractCookieValue(adminSession.refreshCookie)),
    );

    const wrongCurrent = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${adminSession.accessToken}`)
      .set("Cookie", adminSession.refreshCookie)
      .send({ currentPassword: "not-the-current-password", newPassword: "does-not-matter-1" });
    expect(wrongCurrent.status).toBe(400);
    // Asserted directly against the SessionModel row (not via /auth/refresh, which would rotate
    // and consume the cookie as an unrelated side effect of the check itself).
    expect(
      (await sessionRepository.findByRefreshTokenHash(adminSessionHash))?.revokedAt,
    ).toBeUndefined();

    // Same new password as current.
    const samePassword = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${adminSession.accessToken}`)
      .set("Cookie", adminSession.refreshCookie)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: CURRENT_PASSWORD });
    expect(samePassword.status).toBe(400);
    expect(
      (await sessionRepository.findByRefreshTokenHash(adminSessionHash))?.revokedAt,
    ).toBeUndefined();

    // OAuth-only account — PASSWORD_NOT_CONFIGURED, no session to begin with, request itself
    // must not error trying to revoke anything.
    const oauthOwner = await userRepository.create({
      normalizedEmail: `oauth-only-${new Types.ObjectId().toString()}@example.com`,
      authProviders: ["GOOGLE"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    const oauthRejected = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", await bearerFor(oauthOwner._id, "BUSINESS_OWNER"))
      .send({ currentPassword: "anything", newPassword: "does-not-matter-2" });
    expect(oauthRejected.status).toBe(400);
  });

  it("revoking sessions is idempotent against already-revoked/expired rows (no error)", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const sessionA = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");
    const sessionB = await loginSession(app, admin.normalizedEmail, "SUPER_ADMIN");

    // Pre-revoke Session B by logging it out, so the password-change revocation runs against a
    // user who already has a revoked row — this must not throw or change the response.
    await request(app).post("/auth/logout").set("Cookie", sessionB.refreshCookie);

    const changed = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${sessionA.accessToken}`)
      .set("Cookie", sessionA.refreshCookie)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "another-new-password-3" });
    expect(changed.status).toBe(200);

    const refreshA = await request(app).post("/auth/refresh").set("Cookie", sessionA.refreshCookie);
    expect(refreshA.status).toBe(200);
  });

  // Phase 1 (session hardening) — same contract proven across every supported role; parameterized
  // rather than duplicating the full multi-session assertions per role.
  it.each(["CUSTOMER", "SUPER_ADMIN", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const)(
    "PATCH /auth/me/password revokes other sessions but preserves the caller's own for %s",
    async (role) => {
      const user = await createUserWithProfile(role);
      const app = buildApp();

      const sessionA = await loginSession(app, user.normalizedEmail, role);
      const sessionB = await loginSession(app, user.normalizedEmail, role);

      const changed = await request(app)
        .patch("/auth/me/password")
        .set("Authorization", `Bearer ${sessionA.accessToken}`)
        .set("Cookie", sessionA.refreshCookie)
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: `${role}-hardened-password` });
      expect(changed.status).toBe(200);

      const refreshA = await request(app)
        .post("/auth/refresh")
        .set("Cookie", sessionA.refreshCookie);
      expect(refreshA.status).toBe(200);

      const refreshB = await request(app)
        .post("/auth/refresh")
        .set("Cookie", sessionB.refreshCookie);
      expect(refreshB.status).toBe(401);
    },
  );

  // --- Authorization boundary -----------------------------------------------------------

  it("BUSINESS_OWNER / SUPERVISOR / STAFF cannot use the admin-account profile mutation (403)", async () => {
    const app = buildApp();

    for (const role of ["BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const) {
      const user = await createUserWithProfile(role);
      const auth = await bearerFor(user._id, role);

      const profile = await request(app)
        .patch("/auth/me")
        .set("Authorization", auth)
        .send({ firstName: "Nope" });
      expect(profile.status).toBe(403);
    }
  });

  // Phase 1 (Business Settings) — PATCH /auth/me/password is deliberately widened beyond
  // CUSTOMER/SUPER_ADMIN to also allow BUSINESS_OWNER/SUPERVISOR/STAFF (Settings → Security &
  // 2FA → Update Password). PATCH /auth/me (profile) stays CUSTOMER/SUPER_ADMIN-only, unchanged.
  it("BUSINESS_OWNER / SUPERVISOR / STAFF can change their own password via the same route", async () => {
    const app = buildApp();

    for (const role of ["BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const) {
      const user = await createUserWithProfile(role);
      const auth = await bearerFor(user._id, role);

      const wrongCurrent = await request(app)
        .patch("/auth/me/password")
        .set("Authorization", auth)
        .send({ currentPassword: "not-the-current-password", newPassword: `${role}-new-password` });
      expect(wrongCurrent.status).toBe(400);

      const response = await request(app)
        .patch("/auth/me/password")
        .set("Authorization", auth)
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: `${role}-new-password` });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("passwordHash");

      const after = await userRepository.findByIdWithPassword(user._id);
      expect(await passwordHasher.verify(after?.passwordHash, `${role}-new-password`)).toBe(true);
    }
  });

  it("PATCH /auth/me/password rejects an OAuth-only account with no password configured", async () => {
    const owner = await userRepository.create({
      normalizedEmail: `oauth-only-${new Types.ObjectId().toString()}@example.com`,
      authProviders: ["GOOGLE"],
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    });
    const app = buildApp();

    const response = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ currentPassword: "anything", newPassword: "does-not-matter-1" });

    expect(response.status).toBe(400);
    expect(response.body.errors?.[0]?.code).toBe("PASSWORD_NOT_CONFIGURED");
  });

  it("an unauthenticated request cannot touch the admin-account mutations (401)", async () => {
    const app = buildApp();

    const profile = await request(app).patch("/auth/me").send({ firstName: "Nope" });
    expect(profile.status).toBe(401);

    const password = await request(app)
      .patch("/auth/me/password")
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "nope-nope-nope" });
    expect(password.status).toBe(401);
  });
});
