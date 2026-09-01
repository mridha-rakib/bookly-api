import type { Types } from "mongoose";

import { MarketingCampaignError } from "./marketing.errors.js";
import type { MarketingAudienceService } from "./marketing-audience.service.js";
import type { MarketingCampaignDocument } from "./marketing-campaign.model.js";
import type { MarketingCampaignRepository } from "./marketing-campaign.repository.js";
import {
  cancellableMarketingCampaignStatuses,
  type MarketingCampaignType,
} from "./marketing-campaign.types.js";
import type { MarketingCampaignRecipientRepository } from "./marketing-campaign-recipient.repository.js";
import type { MarketingCampaignSourceService } from "./marketing-campaign-source.service.js";

export type CreateCampaignInput = {
  type: MarketingCampaignType;
  sourceId: string;
  /** Absolute UTC instant. Omitted → "send now" (== creation time). */
  scheduledAt?: Date | undefined;
};

export type MarketingCampaignDto = {
  id: string;
  type: MarketingCampaignDocument["type"];
  ownerScope: MarketingCampaignDocument["ownerScope"];
  status: MarketingCampaignDocument["status"];
  source: {
    kind: MarketingCampaignDocument["source"]["kind"];
    sourceId: string;
    sourceSlug?: string | undefined;
    ctaUrl: string;
    snapshot: MarketingCampaignDocument["source"]["snapshot"];
  };
  audience: MarketingCampaignDocument["audience"];
  scheduledAt: string;
  startedAt: string | null;
  materializedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  counts: MarketingCampaignDocument["counts"];
  createdAt: string;
  updatedAt: string;
};

const toDto = (c: MarketingCampaignDocument): MarketingCampaignDto => ({
  id: String(c._id),
  type: c.type,
  ownerScope: c.ownerScope,
  status: c.status,
  source: {
    kind: c.source.kind,
    sourceId: c.source.sourceId,
    sourceSlug: c.source.sourceSlug,
    ctaUrl: c.source.ctaUrl,
    snapshot: c.source.snapshot,
  },
  audience: c.audience,
  scheduledAt: c.scheduledAt.toISOString(),
  startedAt: c.startedAt ? c.startedAt.toISOString() : null,
  materializedAt: c.materializedAt ? c.materializedAt.toISOString() : null,
  finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
  failureReason: c.failureReason ?? null,
  counts: c.counts,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/**
 * Marketing Email Stage M3A — campaign domain + audience orchestration for SUPER_ADMIN.
 *
 * Drives a campaign through `DRAFT → SCHEDULED → MATERIALIZING` and no further. The
 * `MATERIALIZING → SENDING` transition, delivery, and every terminal state belong to the M3B
 * worker. Nothing here renders or sends email.
 */
export class MarketingCampaignService {
  public constructor(
    private readonly campaignRepository: MarketingCampaignRepository,
    private readonly sourceService: MarketingCampaignSourceService,
    private readonly audienceService: MarketingAudienceService,
    private readonly recipientRepository: MarketingCampaignRecipientRepository,
  ) {}

  public async create(
    actorUserId: string,
    input: CreateCampaignInput,
  ): Promise<MarketingCampaignDto> {
    const now = new Date();
    const source = await this.sourceService.resolve(input.type, input.sourceId, now);

    const campaign = await this.campaignRepository.create({
      type: input.type,
      createdByUserId: actorUserId,
      source,
      audienceScope: "ALL_OPTED_IN",
      scheduledAt: input.scheduledAt ?? now,
    });
    return toDto(campaign);
  }

  public async list(pagination: { page: number; limit: number }): Promise<{
    campaigns: MarketingCampaignDto[];
    total: number;
  }> {
    const { campaigns, total } = await this.campaignRepository.list(pagination);
    return { campaigns: campaigns.map(toDto), total };
  }

  public async getById(campaignId: string): Promise<MarketingCampaignDto> {
    return toDto(await this.requireCampaign(campaignId));
  }

  /** Fix the send time (while still DRAFT) and move to SCHEDULED. */
  public async schedule(campaignId: string, scheduledAt?: Date): Promise<MarketingCampaignDto> {
    if (scheduledAt) {
      const updated = await this.campaignRepository.updateScheduleWhileDraft(
        campaignId,
        scheduledAt,
      );
      if (!updated) {
        throw new MarketingCampaignError("MARKETING_CAMPAIGN_INVALID_STATE", 409);
      }
    } else {
      await this.requireCampaign(campaignId);
    }

    const transitioned = await this.campaignRepository.transitionStatus(
      campaignId,
      "DRAFT",
      "SCHEDULED",
    );
    if (!transitioned) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_INVALID_STATE", 409);
    }
    return toDto(transitioned);
  }

  /**
   * Build the audience into `MarketingCampaignRecipient` rows. Re-entrant: accepts both
   * `SCHEDULED` (first run) and `MATERIALIZING` (resume after a crash mid-scan) as the `from`
   * state; the recipient unique index makes the scan idempotent. Ends with the campaign in
   * `MATERIALIZING` with `materializedAt` set — the M3B worker takes it to `SENDING`/`SENT`.
   */
  public async materialize(campaignId: string): Promise<MarketingCampaignDto> {
    const claimed = await this.campaignRepository.transitionStatus(
      campaignId,
      ["SCHEDULED", "MATERIALIZING"],
      "MATERIALIZING",
      { startedAt: new Date() },
    );
    if (!claimed) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_INVALID_STATE", 409);
    }

    const { audienceCount } = await this.audienceService.materializeAllOptedIn(campaignId);
    await this.campaignRepository.setAudienceCount(campaignId, audienceCount);
    await this.campaignRepository.setMaterializedAt(campaignId, new Date());

    return toDto(await this.requireCampaign(campaignId));
  }

  /**
   * Cancel a campaign. From `DRAFT`/`SCHEDULED`/`MATERIALIZING` this just stops it. From
   * `SENDING` it is best-effort: the worker sees `status !== "SENDING"` on its next batch and
   * stops claiming, and every still-`PENDING`/`PROCESSING` recipient is terminalized `CANCELLED`
   * here so `counts` reconcile — a message already handed to the provider cannot be recalled.
   */
  public async cancel(campaignId: string): Promise<MarketingCampaignDto> {
    const cancelled = await this.campaignRepository.transitionStatus(
      campaignId,
      [...cancellableMarketingCampaignStatuses],
      "CANCELLED",
      { finishedAt: new Date() },
    );
    if (!cancelled) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_INVALID_STATE", 409);
    }

    await this.recipientRepository.terminalizeOutstanding(campaignId, "CANCELLED");
    const histogram = await this.recipientRepository.aggregateCountsByStatus(campaignId);
    await this.campaignRepository.reconcileCounts(campaignId, histogram);

    return toDto(await this.requireCampaign(campaignId));
  }

  private async requireCampaign(
    campaignId: string | Types.ObjectId,
  ): Promise<MarketingCampaignDocument> {
    const campaign = await this.campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new MarketingCampaignError("MARKETING_CAMPAIGN_NOT_FOUND", 404);
    }
    return campaign;
  }
}
