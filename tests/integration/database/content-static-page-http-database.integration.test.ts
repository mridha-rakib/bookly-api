import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { createPublicContentRoute } from "../../../src/modules/content/content.route.js";
import { StaticPageRepository } from "../../../src/modules/content/static-page.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Phase 3 — Content Manager Static Pages. Fixed set of 4 legal pages, always-live (no status),
 * SUPER_ADMIN-only writes, anonymous public reads. Exercises the real routes end to end: the
 * router-wide `requireRoles(["SUPER_ADMIN"])` gate, zod `.strict()` validation, server-side
 * sanitization of `bodyHtml`, and the public DTO's field allow-list.
 */
describe("HTTP-level Content Manager Static Pages (Phase 3)", () => {
  let userRepository: UserRepository;
  let tokenService: TokenService;

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
    app.use(express.json({ limit: "1mb" })); // matches src/app/app.ts
    app.use("/super-admin", createSuperAdminRoute());
    app.use("/content", createPublicContentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const createUser = (role: "CUSTOMER" | "BUSINESS_OWNER" | "STAFF" | "SUPER_ADMIN") =>
    userRepository.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const update = (
    app: express.Express,
    token: string,
    pageKey: string,
    body: Record<string, unknown>,
  ) =>
    request(app)
      .patch(`/super-admin/content/pages/${pageKey}`)
      .set("Authorization", token)
      .send(body);

  // --- Authorization -------------------------------------------------------------------------

  it("rejects an unauthenticated static-page update (401) and writes nothing", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/super-admin/content/pages/TERMS")
      .send({ title: "T", bodyHtml: "<p>x</p>" });
    expect(res.status).toBe(401);
    expect(await new StaticPageRepository().findByKey("TERMS")).toBeNull();
  });

  it.each(["CUSTOMER", "BUSINESS_OWNER", "STAFF"] as const)(
    "rejects a %s token on static-page list/read/update (403)",
    async (role) => {
      const app = buildApp();
      const user = await createUser(role);
      const token = await bearerFor(user._id, role);

      const list = await request(app).get("/super-admin/content/pages").set("Authorization", token);
      const read = await request(app)
        .get("/super-admin/content/pages/PRIVACY")
        .set("Authorization", token);
      const patch = await update(app, token, "PRIVACY", { title: "P", bodyHtml: "<p>x</p>" });

      expect([list.status, read.status, patch.status]).toEqual([403, 403, 403]);
    },
  );

  // --- Admin list / read --------------------------------------------------------------------

  it("admin list returns all 4 known pages, each 'exists: false' until saved", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const res = await request(app).get("/super-admin/content/pages").set("Authorization", token);
    expect(res.status).toBe(200);
    const pages = res.body.data.pages as Array<{
      pageKey: string;
      routePath: string;
      exists: boolean;
      bodyHtml: string;
    }>;
    expect(pages.map((p) => p.pageKey).sort()).toEqual(
      ["COOKIES", "PRIVACY", "TERMS", "TERMS_OF_USE"].sort(),
    );
    expect(pages.every((p) => p.exists === false && p.bodyHtml === "")).toBe(true);
    expect(pages.find((p) => p.pageKey === "TERMS")?.routePath).toBe("/terms-of-service");
    expect(pages.find((p) => p.pageKey === "TERMS_OF_USE")?.routePath).toBe("/terms-of-use");
  });

  it("rejects an unknown page key (400)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    expect(
      (await request(app).get("/super-admin/content/pages/ABOUT").set("Authorization", token))
        .status,
    ).toBe(400);
    expect(
      (await update(app, token, "NONSENSE", { title: "x", bodyHtml: "<p>y</p>" })).status,
    ).toBe(400);
  });

  // --- Update / persistence ---------------------------------------------------------------

  it("SUPER_ADMIN can create-then-edit a page; title + body persist through fresh reads", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const created = await update(app, token, "COOKIES", {
      title: "Cookie Policy",
      bodyHtml: "<h2>Cookies</h2><p>First version.</p>",
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ pageKey: "COOKIES", exists: true });

    const readBack = await request(app)
      .get("/super-admin/content/pages/COOKIES")
      .set("Authorization", token);
    expect(readBack.body.data.title).toBe("Cookie Policy");
    expect(readBack.body.data.bodyHtml).toBe("<h2>Cookies</h2><p>First version.</p>");

    const edited = await update(app, token, "COOKIES", {
      title: "Cookie Notice",
      bodyHtml: "<p>Second version.</p>",
    });
    expect(edited.status).toBe(200);

    const readBack2 = await request(app)
      .get("/super-admin/content/pages/COOKIES")
      .set("Authorization", token);
    expect(readBack2.body.data).toMatchObject({
      title: "Cookie Notice",
      bodyHtml: "<p>Second version.</p>",
      exists: true,
    });

    // Still exactly one row for this key (upsert, not insert).
    const list = await request(app).get("/super-admin/content/pages").set("Authorization", token);
    expect(
      list.body.data.pages.filter((p: { pageKey: string }) => p.pageKey === "COOKIES"),
    ).toHaveLength(1);
  });

  it("sanitizes bodyHtml on write — script / on* / img stripped, formatting kept", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const res = await update(app, token, "PRIVACY", {
      title: "Privacy Policy",
      bodyHtml:
        '<h2>Privacy</h2><p onmouseover="steal()">We respect <strong>your</strong> data.</p><script>fetch("/evil")</script><img src=x onerror=alert(1)>',
    });
    expect(res.status).toBe(200);
    const body = res.body.data.bodyHtml as string;
    expect(body).toContain("<strong>your</strong>");
    expect(body).toContain("<h2>Privacy</h2>");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onmouseover");
    expect(body).not.toContain("onerror");
    expect(body).not.toContain("<img");
  });

  it("rejects invalid update payloads (unknown field, empty body, missing title, oversize)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    for (const body of [
      { title: "T", bodyHtml: "<p>x</p>", surprise: true },
      { title: "T", bodyHtml: "" },
      { bodyHtml: "<p>x</p>" },
      { title: "   ", bodyHtml: "<p>x</p>" },
      { title: "T", bodyHtml: `<p>${"a".repeat(200_001)}</p>` },
    ]) {
      expect((await update(app, token, "TERMS", body)).status).toBe(400);
    }
    expect(await new StaticPageRepository().findByKey("TERMS")).toBeNull();
  });

  // --- Public read --------------------------------------------------------------------

  it("public page 404s until created, then returns real content with NO internal fields", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    expect((await request(app).get("/content/pages/TERMS")).status).toBe(404);

    await update(app, token, "TERMS", {
      title: "Terms & Conditions",
      bodyHtml: "<h2>Terms</h2><p>Real terms body.</p>",
    });

    const res = await request(app).get("/content/pages/TERMS");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      pageKey: "TERMS",
      routePath: "/terms-of-service",
      title: "Terms & Conditions",
      bodyHtml: "<h2>Terms</h2><p>Real terms body.</p>",
      updatedAt: expect.any(String),
    });
    expect(res.body.data).not.toHaveProperty("createdByUserId");
    expect(res.body.data).not.toHaveProperty("updatedByUserId");
    expect(res.body.data).not.toHaveProperty("exists");
    expect(JSON.stringify(res.body)).not.toContain(String(admin._id));
  });

  it("public endpoint requires a valid pageKey (400) and needs no auth", async () => {
    const app = buildApp();
    expect((await request(app).get("/content/pages/ABOUT")).status).toBe(400);
    expect((await request(app).get("/content/pages/TERMS")).status).toBe(404); // valid key, not created
  });

  it("an admin edit is immediately reflected on the public endpoint (single source of truth)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    await update(app, token, "COOKIES", { title: "Cookie Policy", bodyHtml: "<p>v1</p>" });
    expect((await request(app).get("/content/pages/COOKIES")).body.data.bodyHtml).toBe("<p>v1</p>");

    await update(app, token, "COOKIES", { title: "Cookie Policy", bodyHtml: "<p>v2 updated</p>" });
    expect((await request(app).get("/content/pages/COOKIES")).body.data.bodyHtml).toBe(
      "<p>v2 updated</p>",
    );
  });
});
