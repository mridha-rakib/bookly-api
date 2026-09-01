import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { MarketingCampaignError } from "../../src/modules/marketing/marketing.errors.js";
import type {
  ArticleSourceSnapshot,
  PromoSourceSnapshot,
} from "../../src/modules/marketing/marketing-campaign.types.js";
import { MarketingCampaignSourceService } from "../../src/modules/marketing/marketing-campaign-source.service.js";

const blogRepo = (post: unknown) => ({ findById: vi.fn().mockResolvedValue(post) }) as never;
const promoRepo = (promo: unknown) => ({ findById: vi.fn().mockResolvedValue(promo) }) as never;

const PUBLISHED_POST = {
  _id: new Types.ObjectId(),
  slug: "how-to-book-a-massage",
  title: "How to book a massage",
  excerpt: "A short guide.",
  status: "PUBLISHED",
};

const ACTIVE_PROMO = {
  _id: new Types.ObjectId(),
  normalizedCode: "BOOKLY20",
  type: "PERCENTAGE" as const,
  value: 20,
  status: "ACTIVE",
  startAt: undefined,
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  scope: "ALL_BOOKINGS",
  businessIds: [],
};

describe("MarketingCampaignSourceService — ARTICLE", () => {
  it("accepts a PUBLISHED post and freezes the minimal display snapshot + real /blog/:slug CTA", async () => {
    const svc = new MarketingCampaignSourceService(blogRepo(PUBLISHED_POST), promoRepo(null));
    const source = await svc.resolve("ARTICLE", String(PUBLISHED_POST._id));

    expect(source.kind).toBe("BLOG_POST");
    expect(source.sourceId).toBe(String(PUBLISHED_POST._id));
    expect(source.sourceSlug).toBe("how-to-book-a-massage");
    expect(source.ctaUrl).toBe("http://localhost:3000/blog/how-to-book-a-massage");

    const snap = source.snapshot as ArticleSourceSnapshot;
    expect(snap).toEqual({
      title: "How to book a massage",
      excerpt: "A short guide.",
      coverImageUrl: null,
    });
    expect(snap).not.toHaveProperty("bodyHtml");
  });

  it("rejects a DRAFT post", async () => {
    const svc = new MarketingCampaignSourceService(
      blogRepo({ ...PUBLISHED_POST, status: "DRAFT" }),
      promoRepo(null),
    );
    await expect(svc.resolve("ARTICLE", String(PUBLISHED_POST._id))).rejects.toBeInstanceOf(
      MarketingCampaignError,
    );
  });

  it("rejects a missing post", async () => {
    const svc = new MarketingCampaignSourceService(blogRepo(null), promoRepo(null));
    await expect(svc.resolve("ARTICLE", String(new Types.ObjectId()))).rejects.toBeInstanceOf(
      MarketingCampaignError,
    );
  });
});

describe("MarketingCampaignSourceService — PROMO", () => {
  it("accepts an ACTIVE, unexpired promo and freezes the qualification snapshot", async () => {
    const svc = new MarketingCampaignSourceService(blogRepo(null), promoRepo(ACTIVE_PROMO));
    const source = await svc.resolve("PROMO", String(ACTIVE_PROMO._id));

    expect(source.kind).toBe("PROMO_CODE");
    expect(source.ctaUrl).toBe("http://localhost:3000/explore");
    const snap = source.snapshot as PromoSourceSnapshot;
    expect(snap.normalizedCode).toBe("BOOKLY20");
    expect(snap.type).toBe("PERCENTAGE");
    expect(snap.value).toBe(20);
    expect(snap.scope).toBe("ALL_BOOKINGS");
    expect(snap.businessIds).toEqual([]);
  });

  it("uses /venue?id= only for a SELECTED_BUSINESSES promo with exactly one business", async () => {
    const bizId = new Types.ObjectId();
    const svc = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...ACTIVE_PROMO, scope: "SELECTED_BUSINESSES", businessIds: [bizId] }),
    );
    const source = await svc.resolve("PROMO", String(ACTIVE_PROMO._id));
    expect(source.ctaUrl).toBe(`http://localhost:3000/venue?id=${bizId.toString()}`);
  });

  it("falls back to /explore for a multi-business SELECTED_BUSINESSES promo", async () => {
    const svc = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({
        ...ACTIVE_PROMO,
        scope: "SELECTED_BUSINESSES",
        businessIds: [new Types.ObjectId(), new Types.ObjectId()],
      }),
    );
    const source = await svc.resolve("PROMO", String(ACTIVE_PROMO._id));
    expect(source.ctaUrl).toBe("http://localhost:3000/explore");
  });

  it("rejects a DEACTIVATED promo", async () => {
    const svc = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...ACTIVE_PROMO, status: "DEACTIVATED" }),
    );
    await expect(svc.resolve("PROMO", String(ACTIVE_PROMO._id))).rejects.toBeInstanceOf(
      MarketingCampaignError,
    );
  });

  it("rejects an expired promo", async () => {
    const svc = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...ACTIVE_PROMO, expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(svc.resolve("PROMO", String(ACTIVE_PROMO._id))).rejects.toBeInstanceOf(
      MarketingCampaignError,
    );
  });
});

describe("MarketingCampaignSourceService.revalidate (M3B live re-check)", () => {
  it("ARTICLE: valid only while PUBLISHED", async () => {
    const ok = new MarketingCampaignSourceService(blogRepo(PUBLISHED_POST), promoRepo(null));
    await expect(ok.revalidate("ARTICLE", "id")).resolves.toEqual({ valid: true });

    const draft = new MarketingCampaignSourceService(
      blogRepo({ ...PUBLISHED_POST, status: "DRAFT" }),
      promoRepo(null),
    );
    await expect(draft.revalidate("ARTICLE", "id")).resolves.toMatchObject({ valid: false });

    const gone = new MarketingCampaignSourceService(blogRepo(null), promoRepo(null));
    await expect(gone.revalidate("ARTICLE", "id")).resolves.toMatchObject({ valid: false });
  });

  it("PROMO: valid only while ACTIVE, within window, under usage cap", async () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const base = {
      ...ACTIVE_PROMO,
      startAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
      totalUsageLimit: 100,
      redeemedCount: 10,
    };

    const ok = new MarketingCampaignSourceService(blogRepo(null), promoRepo(base));
    await expect(ok.revalidate("PROMO", "id", now)).resolves.toEqual({ valid: true });

    const deactivated = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...base, status: "DEACTIVATED" }),
    );
    await expect(deactivated.revalidate("PROMO", "id", now)).resolves.toMatchObject({
      valid: false,
    });

    const notStarted = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...base, startAt: new Date("2026-02-01T00:00:00.000Z") }),
    );
    await expect(notStarted.revalidate("PROMO", "id", now)).resolves.toMatchObject({
      valid: false,
    });

    const expired = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...base, expiresAt: new Date("2026-01-10T00:00:00.000Z") }),
    );
    await expect(expired.revalidate("PROMO", "id", now)).resolves.toMatchObject({ valid: false });

    const exhausted = new MarketingCampaignSourceService(
      blogRepo(null),
      promoRepo({ ...base, redeemedCount: 100 }),
    );
    await expect(exhausted.revalidate("PROMO", "id", now)).resolves.toMatchObject({ valid: false });
  });
});
