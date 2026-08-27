import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createAuthRoute } from "../../../src/modules/auth/auth.route.js";
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
 * Phase 1 — Super Admin Settings → Admin Account. Exercises the real /auth routes end to end
 * (auth middleware, the widened `requireRoles(["CUSTOMER", "SUPER_ADMIN"])` gate on PATCH
 * /auth/me and PATCH /auth/me/password, zod `.strict()` validation, the Argon2 verify+rehash
 * path). The whole point is proving the HTTP authorization boundary and persistence actually
 * hold — services are never called directly.
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

  it("a Super Admin password change does NOT revoke the caller's other sessions (matches CUSTOMER behavior)", async () => {
    const admin = await createUserWithProfile("SUPER_ADMIN");
    const app = buildApp();

    const login = await request(app)
      .post("/auth/super-admin/login")
      .send({ email: admin.normalizedEmail, password: CURRENT_PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"] as unknown as string[] | undefined;
    const refreshCookie = setCookie?.[0] ?? "";
    expect(refreshCookie).toContain("bookly_refresh_token=");

    const changed = await request(app)
      .patch("/auth/me/password")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: "yet-another-password" });
    expect(changed.status).toBe(200);

    // The pre-existing refresh session is still valid after the password change.
    const refreshed = await request(app).post("/auth/refresh").set("Cookie", refreshCookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.user).toMatchObject({ id: String(admin._id), role: "SUPER_ADMIN" });
  });

  // --- Authorization boundary -----------------------------------------------------------

  it("BUSINESS_OWNER / SUPERVISOR / STAFF cannot use the admin-account mutations (403)", async () => {
    const app = buildApp();

    for (const role of ["BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const) {
      const user = await createUserWithProfile(role);
      const auth = await bearerFor(user._id, role);

      const profile = await request(app)
        .patch("/auth/me")
        .set("Authorization", auth)
        .send({ firstName: "Nope" });
      expect(profile.status).toBe(403);

      const password = await request(app)
        .patch("/auth/me/password")
        .set("Authorization", auth)
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: "nope-nope-nope" });
      expect(password.status).toBe(403);
    }
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
