import type { Types } from "mongoose";

import {
  type MarketingCampaignDocument,
  MarketingCampaignModel,
} from "./marketing-campaign.model.js";
import {
  type MarketingAudienceScope,
  type MarketingCampaignCounts,
  type MarketingCampaignSource,
  type MarketingCampaignStatus,
  type MarketingCampaignType,
  RECIPIENT_STATUS_TO_COUNT_KEY,
  zeroMarketingCampaignCounts,
} from "./marketing-campaign.types.js";

export type CreateMarketingCampaignInput = {
  type: MarketingCampaignType;
  createdByUserId: Types.ObjectId | string;
  source: MarketingCampaignSource;
  audienceScope: MarketingAudienceScope;
  scheduledAt: Date;
};

/**
 * Marketing Email Stage M3A — persistence for {@link MarketingCampaignModel}. Deliberately free
 * of any source-domain (BlogPost / PromoCode) knowledge — source validation lives in
 * {@link import("./marketing-campaign-source.service.js").MarketingCampaignSourceService}.
 * Status changes are CAS (`findOneAndUpdate` filtered on the expected `from` status) so two
 * concurrent callers can never drive one campaign into divergent states.
 */
export class MarketingCampaignRepository {
  public async create(input: CreateMarketingCampaignInput): Promise<MarketingCampaignDocument> {
    return new MarketingCampaignModel({
      type: input.type,
      ownerScope: "PLATFORM",
      createdByUserId: input.createdByUserId,
      source: input.source,
      audience: { scope: input.audienceScope },
      status: "DRAFT",
      scheduledAt: input.scheduledAt,
      counts: zeroMarketingCampaignCounts(),
    }).save();
  }

  public async findById(
    campaignId: Types.ObjectId | string,
  ): Promise<MarketingCampaignDocument | null> {
    return MarketingCampaignModel.findById(campaignId).exec();
  }

  public async list(pagination: {
    page: number;
    limit: number;
  }): Promise<{ campaigns: MarketingCampaignDocument[]; total: number }> {
    const skip = (pagination.page - 1) * pagination.limit;
    const [campaigns, total] = await Promise.all([
      MarketingCampaignModel.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      MarketingCampaignModel.countDocuments().exec(),
    ]);
    return { campaigns, total };
  }

  /**
   * Atomic status transition. Returns the updated doc, or `null` when the campaign was not in
   * `from` (already transitioned / cancelled / gone) — the caller maps `null` to a clear
   * "invalid state" error, never a silent success.
   */
  public async transitionStatus(
    campaignId: Types.ObjectId | string,
    from: MarketingCampaignStatus | MarketingCampaignStatus[],
    to: MarketingCampaignStatus,
    extra: Partial<
      Pick<
        MarketingCampaignDocument,
        "startedAt" | "materializedAt" | "finishedAt" | "failureReason"
      >
    > = {},
  ): Promise<MarketingCampaignDocument | null> {
    const fromList = Array.isArray(from) ? from : [from];
    return MarketingCampaignModel.findOneAndUpdate(
      { _id: campaignId, status: { $in: fromList } },
      { $set: { status: to, ...extra } },
      { returnDocument: "after" },
    ).exec();
  }

  /**
   * M3B worker promotion pass — campaigns needing a promotion step:
   *  A) `SCHEDULED` past `scheduledAt`                          → claim → materialize → SENDING
   *  B) `MATERIALIZING` with `materializedAt` set               → audience done → SENDING (or SENT if 0)
   *  C) `MATERIALIZING` without `materializedAt`, stale `startedAt` → a worker crashed mid-scan → resume
   * The recipient unique index makes a resumed scan idempotent. Uses the `{status, scheduledAt}`
   * index; oldest-due first.
   */
  public async findDueForPromotion(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<MarketingCampaignDocument[]> {
    return MarketingCampaignModel.find({
      $or: [
        { status: "SCHEDULED", scheduledAt: { $lte: now } },
        { status: "MATERIALIZING", materializedAt: { $exists: true } },
        {
          status: "MATERIALIZING",
          materializedAt: { $exists: false },
          startedAt: { $lte: staleBefore },
        },
      ],
    })
      .sort({ scheduledAt: 1 })
      .limit(limit)
      .exec();
  }

  /** M3B worker: campaigns currently in flight (their recipients need draining). */
  public async findSending(limit: number): Promise<MarketingCampaignDocument[]> {
    return MarketingCampaignModel.find({ status: "SENDING" })
      .sort({ startedAt: 1 })
      .limit(limit)
      .exec();
  }

  public async setMaterializedAt(campaignId: Types.ObjectId | string, at: Date): Promise<void> {
    await MarketingCampaignModel.updateOne(
      { _id: campaignId },
      { $set: { materializedAt: at } },
    ).exec();
  }

  /**
   * Reconciles `counts` from the authoritative recipient terminal-state histogram (`audience`
   * is preserved). Called at campaign completion / failure — never trusts in-run `$inc` alone.
   */
  public async reconcileCounts(
    campaignId: Types.ObjectId | string,
    histogram: Record<string, number>,
  ): Promise<MarketingCampaignCounts> {
    const counts = zeroMarketingCampaignCounts();
    for (const [status, n] of Object.entries(histogram)) {
      const key = (
        RECIPIENT_STATUS_TO_COUNT_KEY as Record<
          string,
          keyof Omit<MarketingCampaignCounts, "audience"> | undefined
        >
      )[status];
      if (key) {
        counts[key] += n;
      }
    }
    const doc = await MarketingCampaignModel.findByIdAndUpdate(
      campaignId,
      {
        $set: {
          "counts.sent": counts.sent,
          "counts.skippedOptOut": counts.skippedOptOut,
          "counts.skippedUnverified": counts.skippedUnverified,
          "counts.skippedInactive": counts.skippedInactive,
          "counts.skippedSourceInvalid": counts.skippedSourceInvalid,
          "counts.failed": counts.failed,
          "counts.cancelled": counts.cancelled,
        },
      },
      { returnDocument: "after" },
    ).exec();
    return doc?.counts ?? { ...counts, audience: 0 };
  }

  /** Update `scheduledAt` only while still `DRAFT`. `null` → not in DRAFT. */
  public async updateScheduleWhileDraft(
    campaignId: Types.ObjectId | string,
    scheduledAt: Date,
  ): Promise<MarketingCampaignDocument | null> {
    return MarketingCampaignModel.findOneAndUpdate(
      { _id: campaignId, status: "DRAFT" },
      { $set: { scheduledAt } },
      { returnDocument: "after" },
    ).exec();
  }

  /** Overwrites the campaign's audience count with the authoritative materialized total. */
  public async setAudienceCount(
    campaignId: Types.ObjectId | string,
    audience: number,
  ): Promise<void> {
    await MarketingCampaignModel.updateOne(
      { _id: campaignId },
      { $set: { "counts.audience": audience } },
    ).exec();
  }
}
