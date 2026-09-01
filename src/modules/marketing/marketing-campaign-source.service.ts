import type { BlogPostRepository } from "../content/blog.repository.js";
import { buildFrontendUrl } from "../email/email.links.js";
import type { PromoRepository } from "../promo/promo.repository.js";
import { MarketingCampaignError } from "./marketing.errors.js";
import type { MarketingCampaignSource, MarketingCampaignType } from "./marketing-campaign.types.js";

/**
 * Marketing Email Stage M3A — validates a campaign's SOURCE and freezes a minimal display
 * snapshot + a real CTA URL.
 *
 * Hybrid strategy: only display fields + identity + CTA are frozen here. `source.sourceId` is
 * the anchor the M3B worker re-reads to re-validate the LIVE source at send time (article still
 * PUBLISHED, promo still ACTIVE + in-window). Dependency direction is strictly
 * `marketing → {content, promo}` — those modules never import marketing.
 *
 * Reads only. Never mutates BlogPost / PromoCode.
 */
export class MarketingCampaignSourceService {
  public constructor(
    private readonly blogPostRepository: BlogPostRepository,
    private readonly promoRepository: PromoRepository,
  ) {}

  public async resolve(
    type: MarketingCampaignType,
    sourceId: string,
    now: Date = new Date(),
  ): Promise<MarketingCampaignSource> {
    if (type === "ARTICLE") {
      return this.resolveArticle(sourceId);
    }
    return this.resolvePromo(sourceId, now);
  }

  /**
   * Marketing Email Stage M3B — LIVE re-validation of an already-created campaign's source,
   * called once at the `MATERIALIZING → SENDING` transition and once per worker send batch
   * (cached for the batch — never per recipient). Returns `{ valid, reason? }` instead of
   * throwing, so the worker can drive the campaign to `FAILED` with a safe reason.
   *
   * ARTICLE  → live BlogPost must still be `PUBLISHED`.
   * PROMO    → live PromoCode must be `ACTIVE`, within `[startAt, expiresAt)`, and under its
   *            global `totalUsageLimit`. Per-recipient redeemability is NEVER evaluated here.
   */
  public async revalidate(
    type: MarketingCampaignType,
    sourceId: string,
    now: Date = new Date(),
  ): Promise<{ valid: boolean; reason?: string }> {
    if (type === "ARTICLE") {
      const post = await this.blogPostRepository.findById(sourceId).catch(() => null);
      if (!post) {
        return { valid: false, reason: "article no longer exists" };
      }
      if (post.status !== "PUBLISHED") {
        return { valid: false, reason: "article is no longer published" };
      }
      return { valid: true };
    }

    const promo = await this.promoRepository.findById(sourceId).catch(() => null);
    if (!promo) {
      return { valid: false, reason: "promo no longer exists" };
    }
    if (promo.status !== "ACTIVE") {
      return { valid: false, reason: "promo is no longer active" };
    }
    if (promo.startAt && promo.startAt.getTime() > now.getTime()) {
      return { valid: false, reason: "promo has not started yet" };
    }
    if (promo.expiresAt.getTime() <= now.getTime()) {
      return { valid: false, reason: "promo has expired" };
    }
    if (typeof promo.totalUsageLimit === "number" && promo.redeemedCount >= promo.totalUsageLimit) {
      return { valid: false, reason: "promo usage limit reached" };
    }
    return { valid: true };
  }

  private async resolveArticle(sourceId: string): Promise<MarketingCampaignSource> {
    const post = await this.blogPostRepository.findById(sourceId).catch(() => null);
    if (!post) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_SOURCE_NOT_FOUND", 404);
    }
    if (post.status !== "PUBLISHED") {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_SOURCE_NOT_ELIGIBLE", 409);
    }

    return {
      kind: "BLOG_POST",
      sourceId: String(post._id),
      sourceSlug: post.slug,
      // Existing public route — never an invented landing page.
      ctaUrl: buildFrontendUrl(`/blog/${post.slug}`),
      snapshot: {
        title: post.title,
        excerpt: post.excerpt,
        // M3A keeps the snapshot minimal (no bodyHtml). The cover image is a short-lived
        // presigned URL that would be stale by send time anyway, so M3B resolves it live from
        // the BlogPost (it owns the renderer + storage service). Stored as null here.
        coverImageUrl: null,
      },
    };
  }

  private async resolvePromo(sourceId: string, now: Date): Promise<MarketingCampaignSource> {
    const promo = await this.promoRepository.findById(sourceId).catch(() => null);
    if (!promo) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_SOURCE_NOT_FOUND", 404);
    }
    // Creation-time gate: currently active and not past its end. Redeemability per recipient is
    // NEVER simulated (scope / first-booking / per-user caps are booking-context-sensitive —
    // see PromoApplicationService); campaign copy carries qualification wording instead. M3B
    // re-checks status + window + global usage at send.
    if (promo.status !== "ACTIVE" || promo.expiresAt.getTime() <= now.getTime()) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_SOURCE_NOT_ELIGIBLE", 409);
    }

    const businessIds = promo.businessIds.map((id) => String(id));
    const ctaUrl =
      promo.scope === "SELECTED_BUSINESSES" && businessIds.length === 1
        ? `${buildFrontendUrl("/venue")}?id=${businessIds[0]}`
        : buildFrontendUrl("/explore");

    return {
      kind: "PROMO_CODE",
      sourceId: String(promo._id),
      ctaUrl,
      snapshot: {
        normalizedCode: promo.normalizedCode,
        type: promo.type,
        value: promo.value,
        expiresAt: promo.expiresAt,
        scope: promo.scope,
        businessIds,
      },
    };
  }
}
