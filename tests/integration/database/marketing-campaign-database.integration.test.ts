import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BlogPostModel } from "../../../src/modules/content/blog.model.js";
import { MarketingCampaignModel } from "../../../src/modules/marketing/marketing-campaign.model.js";
import { MarketingCampaignRecipientModel } from "../../../src/modules/marketing/marketing-campaign-recipient.model.js";
import { PromoCodeModel } from "../../../src/modules/promo/promo.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const app = express();
app.use(express.json());
app.use("/super-admin", createSuperAdminRoute());
app.use(createErrorHandler({ isProduction: true }));

const tokenService = new TokenService(new SessionRepository());

const bearer = async (userId: Types.ObjectId, role: string) =>
  `Bearer ${await tokenService.createAccessToken({ userId, role: role as never })}`;

const seedSuperAdmin = async () => {
  const user = await UserModel.create({
    normalizedEmail: `sa-${new Types.ObjectId().toString()}@example.com`,
    passwordHash: "x",
    role: "SUPER_ADMIN",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  return { user, auth: await bearer(user._id, "SUPER_ADMIN") };
};

const seedBlogPost = async (status: "PUBLISHED" | "DRAFT") =>
  BlogPostModel.create({
    title: "Guide to booking",
    slug: `guide-${new Types.ObjectId().toString()}`,
    excerpt: "How to book.",
    bodyHtml: "<p>body</p>",
    category: "CUSTOMER_TIPS",
    status,
    publishedAt: status === "PUBLISHED" ? new Date() : null,
    createdByUserId: new Types.ObjectId(),
  });

const seedPromo = async (over: Record<string, unknown> = {}) =>
  PromoCodeModel.create({
    code: "BOOKLY20",
    normalizedCode: new Types.ObjectId().toString().toUpperCase(),
    type: "PERCENTAGE",
    value: 20,
    scope: "ALL_BOOKINGS",
    businessIds: [],
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    status: "ACTIVE",
    createdByUserId: new Types.ObjectId(),
    ...over,
  });

describe("marketing campaign domain (database-backed HTTP)", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("has the campaign + recipient indexes it needs", async () => {
    const campaignIdx = (await MarketingCampaignModel.collection.indexes()) as Array<{
      key: Record<string, number>;
    }>;
    expect(campaignIdx.some((i) => i.key["status"] === 1 && i.key["scheduledAt"] === 1)).toBe(true);

    const recipIdx = (await MarketingCampaignRecipientModel.collection.indexes()) as Array<{
      key: Record<string, number>;
      unique?: boolean;
    }>;
    expect(
      recipIdx.some((i) => i.key["campaignId"] === 1 && i.key["userId"] === 1 && i.unique),
    ).toBe(true);
    expect(
      recipIdx.some(
        (i) => i.key["campaignId"] === 1 && i.key["status"] === 1 && i.key["nextAttemptAt"] === 1,
      ),
    ).toBe(true);
  });

  it("requires SUPER_ADMIN", async () => {
    const post = await seedBlogPost("PUBLISHED");
    await request(app)
      .post("/super-admin/marketing/campaigns")
      .send({ type: "ARTICLE", sourceId: String(post._id) })
      .expect(401);

    const customer = await UserModel.create({
      normalizedEmail: `c-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "x",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", await bearer(customer._id, "CUSTOMER"))
      .send({ type: "ARTICLE", sourceId: String(post._id) })
      .expect(403);
  });

  it("creates an ARTICLE campaign from a PUBLISHED post as DRAFT, PLATFORM, ALL_OPTED_IN", async () => {
    const { auth } = await seedSuperAdmin();
    const post = await seedBlogPost("PUBLISHED");

    const res = await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "ARTICLE", sourceId: String(post._id) })
      .expect(201);

    expect(res.body.data).toMatchObject({
      type: "ARTICLE",
      ownerScope: "PLATFORM",
      status: "DRAFT",
      audience: { scope: "ALL_OPTED_IN" },
      source: {
        kind: "BLOG_POST",
        sourceId: String(post._id),
        sourceSlug: post.slug,
        ctaUrl: `http://localhost:3000/blog/${post.slug}`,
        snapshot: { title: "Guide to booking", excerpt: "How to book.", coverImageUrl: null },
      },
      counts: { audience: 0, sent: 0 },
    });
  });

  it("rejects an ARTICLE campaign from a DRAFT post, and a missing post", async () => {
    const { auth } = await seedSuperAdmin();
    const draft = await seedBlogPost("DRAFT");

    await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "ARTICLE", sourceId: String(draft._id) })
      .expect(409);

    await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "ARTICLE", sourceId: String(new Types.ObjectId()) })
      .expect(404);
  });

  it("creates a PROMO campaign from an ACTIVE promo and rejects DEACTIVATED / expired", async () => {
    const { auth } = await seedSuperAdmin();
    const active = await seedPromo();

    const res = await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "PROMO", sourceId: String(active._id) })
      .expect(201);
    expect(res.body.data.source).toMatchObject({
      kind: "PROMO_CODE",
      ctaUrl: "http://localhost:3000/explore",
      snapshot: { normalizedCode: active.normalizedCode, type: "PERCENTAGE", value: 20 },
    });

    const deactivated = await seedPromo({ status: "DEACTIVATED" });
    await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "PROMO", sourceId: String(deactivated._id) })
      .expect(409);

    const expired = await seedPromo({ expiresAt: new Date(Date.now() - 1000) });
    await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "PROMO", sourceId: String(expired._id) })
      .expect(409);
  });

  it("drives DRAFT → SCHEDULED → MATERIALIZING and never sends; cancel works; double-transition 409s", async () => {
    const { auth } = await seedSuperAdmin();
    const post = await seedBlogPost("PUBLISHED");
    const created = await request(app)
      .post("/super-admin/marketing/campaigns")
      .set("Authorization", auth)
      .send({ type: "ARTICLE", sourceId: String(post._id) })
      .expect(201);
    const id = created.body.data.id as string;

    await request(app)
      .post(`/super-admin/marketing/campaigns/${id}/schedule`)
      .set("Authorization", auth)
      .send({ scheduledAt: "2035-01-01T00:00:00.000Z" })
      .expect(200)
      .expect((r) => expect(r.body.data.status).toBe("SCHEDULED"));

    // schedule again → not DRAFT anymore
    await request(app)
      .post(`/super-admin/marketing/campaigns/${id}/schedule`)
      .set("Authorization", auth)
      .send({})
      .expect(409);

    await request(app)
      .post(`/super-admin/marketing/campaigns/${id}/materialize`)
      .set("Authorization", auth)
      .expect(200)
      .expect((r) => {
        expect(r.body.data.status).toBe("MATERIALIZING");
        expect(r.body.data.startedAt).not.toBeNull();
        expect(r.body.data.counts.audience).toBe(0);
      });

    const stored = await MarketingCampaignModel.findById(id).lean().exec();
    expect(stored?.status).toBe("MATERIALIZING"); // never SENDING / SENT in M3A

    await request(app)
      .post(`/super-admin/marketing/campaigns/${id}/cancel`)
      .set("Authorization", auth)
      .expect(200)
      .expect((r) => expect(r.body.data.status).toBe("CANCELLED"));

    // cancel again → not cancellable
    await request(app)
      .post(`/super-admin/marketing/campaigns/${id}/cancel`)
      .set("Authorization", auth)
      .expect(409);
  });
});
