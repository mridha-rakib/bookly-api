import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BlogPostRepository } from "../../../src/modules/content/blog.repository.js";
import { BlogService } from "../../../src/modules/content/blog.service.js";
import { BlogMediaRepository } from "../../../src/modules/content/blog-media.repository.js";
import { createPublicContentRoute } from "../../../src/modules/content/content.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import type { StorageService } from "../../../src/modules/storage/storage.service.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/** In-memory storage double — records objects, mints fake fresh URLs. Mirrors the fake used by
 * tests/unit/business-media.service.test.ts. */
class FakeStorageService implements StorageService {
  public readonly bucket = "test-blog-bucket";
  public readonly objects = new Map<string, Buffer>();

  public async ensureBucket(): Promise<void> {}
  public async putObject(input: { key: string; body: Buffer }): Promise<void> {
    this.objects.set(input.key, input.body);
  }
  public async deleteObject(input: { key: string }): Promise<void> {
    this.objects.delete(input.key);
  }
  public async getObjectUrl(input: { key: string }): Promise<string> {
    return `https://signed.example/${input.key}?X-Amz-Expires=900&sig=${Date.now()}`;
  }
  public async objectExists(input: { key: string }): Promise<boolean> {
    return this.objects.has(input.key);
  }
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe("HTTP-level Content Manager Blog (Phase 2)", () => {
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
    app.use(express.json());
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

  const basePost = {
    title: "Meet Our Founding Partners",
    bodyHtml: "<p>Real body <strong>content</strong> here.</p>",
    category: "FOUNDING_PARTNER" as const,
  };

  const createPost = async (
    app: express.Express,
    token: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const res = await request(app)
      .post("/super-admin/content/blog")
      .set("Authorization", token)
      .send({ ...basePost, ...overrides });
    expect(res.status).toBe(201);
    return res.body.data as {
      id: string;
      slug: string;
      status: string;
      bodyHtml: string;
      publishedAt: string | null;
    };
  };

  // Service with a fake storage — for the media assertions the HTTP route can't inject into.
  const buildBlogService = () =>
    new BlogService(new BlogPostRepository(), new BlogMediaRepository(), new FakeStorageService(), {
      maxUploadBytes: 5_000_000,
    });

  // --- Authorization -------------------------------------------------------------------------

  it("rejects unauthenticated blog mutations (401)", async () => {
    const app = buildApp();
    expect((await request(app).post("/super-admin/content/blog").send(basePost)).status).toBe(401);
    expect(
      (
        await request(app)
          .patch(`/super-admin/content/blog/${new Types.ObjectId()}`)
          .send({ title: "x" })
      ).status,
    ).toBe(401);
    expect(
      (await request(app).delete(`/super-admin/content/blog/${new Types.ObjectId()}`)).status,
    ).toBe(401);
  });

  it.each(["CUSTOMER", "BUSINESS_OWNER", "STAFF"] as const)(
    "rejects a %s token on every blog mutation (403)",
    async (role) => {
      const app = buildApp();
      const user = await createUser(role);
      const token = await bearerFor(user._id, role);
      const id = new Types.ObjectId().toString();

      const create = await request(app)
        .post("/super-admin/content/blog")
        .set("Authorization", token)
        .send(basePost);
      const patch = await request(app)
        .patch(`/super-admin/content/blog/${id}`)
        .set("Authorization", token)
        .send({ title: "x" });
      const del = await request(app)
        .delete(`/super-admin/content/blog/${id}`)
        .set("Authorization", token);
      const upload = await request(app)
        .post("/super-admin/content/blog/media")
        .set("Authorization", token)
        .attach("file", PNG, "x.png");

      expect([create.status, patch.status, del.status, upload.status]).toEqual([
        403, 403, 403, 403,
      ]);
    },
  );

  // --- Create / publish semantics --------------------------------------------------------

  it("creates a DRAFT by default (publishedAt null) and a PUBLISHED post (publishedAt set)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const draft = await createPost(app, token, { title: "Draft one" });
    expect(draft.status).toBe("DRAFT");
    expect(draft.publishedAt).toBeNull();

    const published = await createPost(app, token, { title: "Published one", status: "PUBLISHED" });
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).not.toBeNull();
  });

  it("generates a slug from the title and disambiguates collisions", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const a = await createPost(app, token, { title: "Same Title Here" });
    const b = await createPost(app, token, { title: "Same Title Here" });
    const c = await createPost(app, token, { title: "Same Title Here" });

    expect(a.slug).toBe("same-title-here");
    expect(b.slug).toBe("same-title-here-2");
    expect(c.slug).toBe("same-title-here-3");
  });

  it("persists sanitized bodyHtml — script / on* / img are stripped, formatting kept", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    const post = await createPost(app, token, {
      title: "XSS attempt",
      bodyHtml:
        '<p onclick="alert(1)">Hello <strong>world</strong></p><script>alert(2)</script><img src=x onerror=alert(3)>',
    });

    expect(post.bodyHtml).toContain("<strong>world</strong>");
    expect(post.bodyHtml).not.toContain("<script");
    expect(post.bodyHtml).not.toContain("onclick");
    expect(post.bodyHtml).not.toContain("onerror");
    expect(post.bodyHtml).not.toContain("<img");
  });

  it("edit persists through a fresh read (title, bodyHtml, category)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    const post = await createPost(app, token);

    const patch = await request(app)
      .patch(`/super-admin/content/blog/${post.id}`)
      .set("Authorization", token)
      .send({ title: "Edited title", bodyHtml: "<p>Edited body</p>", category: "BOOKLY_NEWS" });
    expect(patch.status).toBe(200);

    const get = await request(app)
      .get(`/super-admin/content/blog/${post.id}`)
      .set("Authorization", token);
    expect(get.body.data).toMatchObject({
      title: "Edited title",
      bodyHtml: "<p>Edited body</p>",
      category: "BOOKLY_NEWS",
    });
  });

  it("delete persists — gone from admin list, second delete is 404", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    const post = await createPost(app, token);

    expect(
      (
        await request(app)
          .delete(`/super-admin/content/blog/${post.id}`)
          .set("Authorization", token)
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/super-admin/content/blog/${post.id}`).set("Authorization", token))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/super-admin/content/blog/${post.id}`)
          .set("Authorization", token)
      ).status,
    ).toBe(404);
  });

  it("admin list filters by category and by status server-side", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    await createPost(app, token, { title: "FP draft", category: "FOUNDING_PARTNER" });
    await createPost(app, token, {
      title: "News published",
      category: "BOOKLY_NEWS",
      status: "PUBLISHED",
    });

    const byCategory = await request(app)
      .get("/super-admin/content/blog?category=BOOKLY_NEWS")
      .set("Authorization", token);
    expect(byCategory.body.data.posts).toHaveLength(1);
    expect(byCategory.body.data.posts[0].category).toBe("BOOKLY_NEWS");

    const byStatus = await request(app)
      .get("/super-admin/content/blog?status=DRAFT")
      .set("Authorization", token);
    expect(byStatus.body.data.posts).toHaveLength(1);
    expect(byStatus.body.data.posts[0].status).toBe("DRAFT");
  });

  it("rejects invalid create payloads (unknown field, bad category, bad slug, empty body)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");

    for (const body of [
      { ...basePost, surprise: true },
      { ...basePost, category: "NOPE" },
      { ...basePost, slug: "Not A Slug!" },
      { ...basePost, bodyHtml: "" },
      { title: "no body", category: "BOOKLY_NEWS" },
    ]) {
      const res = await request(app)
        .post("/super-admin/content/blog")
        .set("Authorization", token)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  // --- Public reads --------------------------------------------------------------------

  it("public list returns PUBLISHED only, no bodyHtml, no internal fields", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    await createPost(app, token, { title: "Public one", status: "PUBLISHED" });
    await createPost(app, token, { title: "Hidden draft" });

    const res = await request(app).get("/content/blog");
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(1);
    const item = res.body.data.posts[0];
    expect(item.title).toBe("Public one");
    expect(item).not.toHaveProperty("bodyHtml");
    expect(item).not.toHaveProperty("createdByUserId");
    expect(JSON.stringify(res.body)).not.toContain("Hidden draft");
  });

  it("public by-slug returns a PUBLISHED post and 404s a DRAFT slug", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    const published = await createPost(app, token, { title: "Live article", status: "PUBLISHED" });
    const draft = await createPost(app, token, { title: "Secret article" });

    const okRes = await request(app).get(`/content/blog/${published.slug}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.bodyHtml).toContain("Real body");
    expect(okRes.body.data).not.toHaveProperty("createdByUserId");
    expect(okRes.body.data).not.toHaveProperty("status");

    const draftRes = await request(app).get(`/content/blog/${draft.slug}`);
    expect(draftRes.status).toBe(404);
  });

  it("DRAFT -> PUBLISHED makes the slug public; PUBLISHED -> DRAFT hides it again (publishedAt retained)", async () => {
    const app = buildApp();
    const admin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(admin._id, "SUPER_ADMIN");
    const post = await createPost(app, token, { title: "Toggle me" });

    expect((await request(app).get(`/content/blog/${post.slug}`)).status).toBe(404);

    const pub = await request(app)
      .patch(`/super-admin/content/blog/${post.id}`)
      .set("Authorization", token)
      .send({ status: "PUBLISHED" });
    expect(pub.status).toBe(200);
    const publishedAt = pub.body.data.publishedAt as string;
    expect(publishedAt).not.toBeNull();
    expect((await request(app).get(`/content/blog/${post.slug}`)).status).toBe(200);

    const unpub = await request(app)
      .patch(`/super-admin/content/blog/${post.id}`)
      .set("Authorization", token)
      .send({ status: "DRAFT" });
    expect(unpub.status).toBe(200);
    expect(unpub.body.data.publishedAt).toBe(publishedAt); // retained, not cleared
    expect((await request(app).get(`/content/blog/${post.slug}`)).status).toBe(404);
  });

  // --- Media (service level, with a fake storage) --------------------------------------

  it("media upload persists an object key + bucket (never a signed URL) and mints a fresh URL", async () => {
    const admin = await createUser("SUPER_ADMIN");
    const service = buildBlogService();

    const media = await service.uploadMedia(String(admin._id), {
      buffer: PNG,
      mimeType: "image/png",
      size: PNG.length,
      originalFileName: "cover.png",
    });

    expect(media.url).toMatch(/^https:\/\/signed\.example\/blog\//);

    const stored = await new BlogMediaRepository().findById(media.id);
    expect(stored?.storageKey).toMatch(/^blog\/.+\.png$/);
    expect(stored?.bucket).toBe("test-blog-bucket");
    const storedJson = JSON.stringify(stored);
    expect(storedJson).not.toContain("X-Amz");
    expect(storedJson).not.toContain("signed.example");
    expect(storedJson).not.toContain("http");
  });

  it("a post resolves its cover media to a fresh URL, and deleting the post removes the media", async () => {
    const admin = await createUser("SUPER_ADMIN");
    const storage = new FakeStorageService();
    const service = new BlogService(new BlogPostRepository(), new BlogMediaRepository(), storage, {
      maxUploadBytes: 5_000_000,
    });

    const media = await service.uploadMedia(String(admin._id), {
      buffer: PNG,
      mimeType: "image/png",
      size: PNG.length,
    });
    expect(storage.objects.size).toBe(1);

    const post = await service.create(String(admin._id), {
      title: "With a cover",
      bodyHtml: "<p>body</p>",
      category: "FOR_BUSINESS",
      status: "PUBLISHED",
      coverMediaId: media.id,
      galleryMediaIds: [],
    });
    expect(post.coverImage?.url).toMatch(/^https:\/\/signed\.example\/blog\//);
    expect(post.galleryCount).toBe(0);

    await service.delete(post.id);
    expect(storage.objects.size).toBe(0);
    expect(await new BlogMediaRepository().findById(media.id)).toBeNull();
  });

  it("rejects a referenced media id that does not exist, and a non-image upload", async () => {
    const admin = await createUser("SUPER_ADMIN");
    const service = buildBlogService();

    await expect(
      service.create(String(admin._id), {
        title: "Bad ref",
        bodyHtml: "<p>x</p>",
        category: "CUSTOMER_TIPS",
        status: "DRAFT",
        coverMediaId: new Types.ObjectId().toString(),
        galleryMediaIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      service.uploadMedia(String(admin._id), {
        buffer: Buffer.from("not an image"),
        mimeType: "image/png",
        size: 12,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
