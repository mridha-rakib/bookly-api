import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import { EmailError } from "../email/email.errors.js";
import type { EmailTransport } from "../email/email-transport.js";
import type { UserDocument, UserProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import { resolveNotificationPreferences } from "../user/user.types.js";
import type { MarketingAudienceService } from "./marketing-audience.service.js";
import type { MarketingCampaignDocument } from "./marketing-campaign.model.js";
import type { MarketingCampaignRepository } from "./marketing-campaign.repository.js";
import type { ArticleSourceSnapshot, PromoSourceSnapshot } from "./marketing-campaign.types.js";
import { renderMarketingCampaignEmail } from "./marketing-campaign-email.js";
import type { MarketingCampaignRecipientDocument } from "./marketing-campaign-recipient.model.js";
import type { MarketingCampaignRecipientRepository } from "./marketing-campaign-recipient.repository.js";
import type { MarketingCampaignSourceService } from "./marketing-campaign-source.service.js";
import {
  assertMarketingOneClickConfigured,
  buildMarketingEmailEnvelope,
} from "./marketing-email-envelope.js";

export type MarketingWorkerOptions = {
  workerId: string;
  batchSize: number;
  concurrency: number;
  maxAttempts: number;
  retryBaseMs: number;
  claimTimeoutMs: number;
  promoteBatchSize: number;
};

export type MarketingWorkerPassCounts = {
  campaignsPromoted: number;
  campaignsSending: number;
  campaignsCompleted: number;
  campaignsFailed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
};

type RecipientOutcome = "sent" | "retried" | "failed" | "skipped";

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof EmailError) {
    return error.safeProviderMessage ?? error.category;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown error";
};

const isUsableEmail = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Marketing Email Stage M3B — the campaign delivery worker.
 *
 * Not a queue framework: correctness lives in the repository's atomic claim + per-claim token
 * fence + the recipient `{campaignId,userId}` unique index (same philosophy as EmailOutbox).
 * This class orchestrates: promote due campaigns → materialize → (zero-audience) SENT, or
 * one-click + live-source gates → SENDING → drain recipients (live eligibility re-check, render,
 * envelope, provider send, retry/skip/fail) → SENT, with campaign-level FAILED for
 * source-invalid / no-one-click / transport-not-configured, and best-effort CANCELLED handling.
 *
 * Structurally isolated from all transactional mail: it never imports EmailOutbox, EmailService,
 * the transactional template registry, or any booking/OTP/reminder notifier.
 */
export class MarketingCampaignWorker {
  public constructor(
    private readonly campaignRepository: MarketingCampaignRepository,
    private readonly recipientRepository: MarketingCampaignRecipientRepository,
    private readonly audienceService: MarketingAudienceService,
    private readonly sourceService: MarketingCampaignSourceService,
    private readonly userRepository: UserRepository,
    private readonly transport: EmailTransport,
    private readonly options: MarketingWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async runOnce(): Promise<MarketingWorkerPassCounts> {
    const counts: MarketingWorkerPassCounts = {
      campaignsPromoted: 0,
      campaignsSending: 0,
      campaignsCompleted: 0,
      campaignsFailed: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    };

    const now = this.clock();
    const staleBefore = new Date(now.getTime() - this.options.claimTimeoutMs);

    // 1) Promotion pass — SCHEDULED-due, materialize-complete, or stale-mid-scan campaigns.
    const due = await this.campaignRepository.findDueForPromotion(
      now,
      staleBefore,
      this.options.promoteBatchSize,
    );
    for (const campaign of due) {
      const promoted = await this.promote(campaign);
      if (promoted === "sending") counts.campaignsPromoted += 1;
      if (promoted === "completed") counts.campaignsCompleted += 1;
      if (promoted === "failed") counts.campaignsFailed += 1;
    }

    // 2) Sending pass — drain in-flight campaigns.
    const sending = await this.campaignRepository.findSending(this.options.promoteBatchSize);
    for (const campaign of sending) {
      counts.campaignsSending += 1;
      const passCounts = await this.drainCampaign(campaign._id);
      counts.claimed += passCounts.claimed;
      counts.sent += passCounts.sent;
      counts.retried += passCounts.retried;
      counts.failed += passCounts.failed;
      counts.skipped += passCounts.skipped;
      if (passCounts.completed) counts.campaignsCompleted += 1;
      if (passCounts.failedCampaign) counts.campaignsFailed += 1;
    }

    return counts;
  }

  // ------------------------------------------------------------------ promotion

  private async promote(
    campaign: MarketingCampaignDocument,
  ): Promise<"sending" | "completed" | "failed" | "noop"> {
    const id = campaign._id;
    let current = campaign;

    if (current.status === "SCHEDULED") {
      const claimed = await this.campaignRepository.transitionStatus(
        id,
        "SCHEDULED",
        "MATERIALIZING",
        { startedAt: this.clock() },
      );
      if (!claimed) {
        return "noop"; // another worker won
      }
      current = claimed;
    }

    if (current.status !== "MATERIALIZING") {
      return "noop";
    }

    if (!current.materializedAt) {
      const { audienceCount } = await this.audienceService.materializeAllOptedIn(id);
      await this.campaignRepository.setAudienceCount(id, audienceCount);
      await this.campaignRepository.setMaterializedAt(id, this.clock());
      const refreshed = await this.campaignRepository.findById(id);
      if (!refreshed) return "noop";
      current = refreshed;
    }

    // Zero opted-in audience — a legitimate, complete outcome. No SENDING, no provider calls.
    if (current.counts.audience === 0) {
      await this.completeCampaign(id, "MATERIALIZING");
      logger.info(
        { operation: "marketing_campaign", campaignId: String(id), result: "sent_zero_audience" },
        "Marketing campaign completed with zero audience",
      );
      return "completed";
    }

    // One-click unsubscribe MUST be configured — no marketing send without it.
    try {
      assertMarketingOneClickConfigured();
    } catch {
      await this.failCampaign(id, "MATERIALIZING", "one-click unsubscribe not configured");
      return "failed";
    }

    // Live source re-validation.
    const revalidation = await this.sourceService.revalidate(
      current.type,
      current.source.sourceId,
      this.clock(),
    );
    if (!revalidation.valid) {
      await this.failCampaign(id, "MATERIALIZING", `source: ${revalidation.reason ?? "invalid"}`);
      return "failed";
    }

    const sending = await this.campaignRepository.transitionStatus(id, "MATERIALIZING", "SENDING");
    return sending ? "sending" : "noop";
  }

  // ------------------------------------------------------------------ sending

  private async drainCampaign(campaignId: Types.ObjectId | string): Promise<{
    claimed: number;
    sent: number;
    retried: number;
    failed: number;
    skipped: number;
    completed: boolean;
    failedCampaign: boolean;
  }> {
    const result = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      completed: false,
      failedCampaign: false,
    };

    const fresh = await this.campaignRepository.findById(campaignId);
    if (fresh?.status !== "SENDING") {
      return result; // cancelled / already finished elsewhere
    }
    const id = fresh._id;
    const now = this.clock();

    // Stale-claim sweep first (observable recovery; claimNext also self-reclaims).
    const staleBefore = new Date(now.getTime() - this.options.claimTimeoutMs);
    const recovered = await this.recipientRepository.recoverStale(
      id,
      staleBefore,
      this.options.maxAttempts,
    );
    result.failed += recovered.failed;

    // One-click + live source, ONCE per batch (cached; never per recipient).
    try {
      assertMarketingOneClickConfigured();
    } catch {
      await this.failCampaign(id, "SENDING", "one-click unsubscribe not configured");
      result.failedCampaign = true;
      return result;
    }
    const revalidation = await this.sourceService.revalidate(
      fresh.type,
      fresh.source.sourceId,
      now,
    );
    if (!revalidation.valid) {
      await this.recipientRepository.terminalizeOutstanding(id, "SKIPPED_SOURCE_INVALID");
      await this.failCampaign(id, "SENDING", `source: ${revalidation.reason ?? "invalid"}`);
      result.failedCampaign = true;
      return result;
    }

    // Claim a batch of rows (each claim is atomic; the loop is sequential by necessity).
    const claimed: Array<{ row: MarketingCampaignRecipientDocument; token: string }> = [];
    while (claimed.length < this.options.batchSize) {
      const token = `${this.options.workerId}:${new Types.ObjectId().toHexString()}`;
      const row = await this.recipientRepository.claimNext({
        campaignId: id,
        now: this.clock(),
        claimTimeoutMs: this.options.claimTimeoutMs,
        maxAttempts: this.options.maxAttempts,
        claimedBy: token,
      });
      if (!row) break;
      claimed.push({ row, token });
    }
    result.claimed = claimed.length;

    if (claimed.length > 0) {
      // Batch-load User + UserProfile for every claimed recipient — no N+1.
      const userIds = claimed.map((c) => c.row.userId);
      const [users, profiles] = await Promise.all([
        this.userRepository.findManyByIds(userIds),
        this.userRepository.findProfilesByUserIds(userIds),
      ]);
      const userById = new Map(users.map((u) => [String(u._id), u]));
      const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

      let abortCampaign: string | null = null;
      const queue = [...claimed];
      const runner = async (): Promise<void> => {
        for (;;) {
          const next = queue.shift();
          if (!next || abortCampaign) return;
          const outcome = await this.processRecipient(
            fresh,
            next.row,
            next.token,
            userById.get(String(next.row.userId)),
            profileByUserId.get(String(next.row.userId)),
          );
          if (outcome === "sent") result.sent += 1;
          else if (outcome === "retried") result.retried += 1;
          else if (outcome === "skipped") result.skipped += 1;
          else result.failed += 1;

          if (outcome === "failed" && this.lastFatal) {
            abortCampaign = this.lastFatal;
            this.lastFatal = null;
          }
        }
      };
      const poolSize = Math.max(1, Math.min(this.options.concurrency, claimed.length));
      await Promise.all(Array.from({ length: poolSize }, () => runner()));

      if (abortCampaign) {
        await this.recipientRepository.terminalizeOutstanding(id, "FAILED");
        await this.failCampaign(id, "SENDING", abortCampaign);
        result.failedCampaign = true;
        return result;
      }
    }

    // Completion: no PENDING / PROCESSING rows left → SENT.
    if (!(await this.recipientRepository.hasOutstanding(id))) {
      const completed = await this.completeCampaign(id, "SENDING");
      result.completed = completed;
    }

    return result;
  }

  /** Set by processRecipient when a recipient failure is actually a campaign-fatal condition
   * (transport NOT_CONFIGURED). Read + cleared by the batch runner. */
  private lastFatal: string | null = null;

  private async processRecipient(
    campaign: MarketingCampaignDocument,
    row: MarketingCampaignRecipientDocument,
    token: string,
    user: UserDocument | undefined,
    profile: UserProfileDocument | undefined,
  ): Promise<RecipientOutcome> {
    // --- live eligibility (from the batch-loaded maps — no DB here) ---
    if (user?.role !== "CUSTOMER" || user.status !== "ACTIVE") {
      await this.recipientRepository.markSkipped(row._id, token, "SKIPPED_INACTIVE");
      return "skipped";
    }
    if (!(user.emailVerifiedAt instanceof Date) || !isUsableEmail(user.normalizedEmail)) {
      await this.recipientRepository.markSkipped(row._id, token, "SKIPPED_UNVERIFIED");
      return "skipped";
    }
    if (!profile || resolveNotificationPreferences(profile.notifications).marketingEmail !== true) {
      await this.recipientRepository.markSkipped(row._id, token, "SKIPPED_OPT_OUT");
      return "skipped";
    }

    const liveEmail = user.normalizedEmail.trim().toLowerCase();

    // --- envelope (unsubscribe URL + one-click headers) ---
    const envelope = await buildMarketingEmailEnvelope(String(user._id));
    if (!envelope.headers["List-Unsubscribe"] || !envelope.headers["List-Unsubscribe-Post"]) {
      await this.recipientRepository.markFailed(row._id, token, {
        category: "ONE_CLICK_NOT_CONFIGURED",
        message: "marketing envelope produced no one-click headers",
      });
      this.lastFatal = "one-click unsubscribe not configured";
      return "failed";
    }

    // --- render (pure; derived from the frozen snapshot) ---
    const rendered = renderMarketingCampaignEmail(
      campaign.type === "ARTICLE"
        ? {
            type: "ARTICLE",
            snapshot: campaign.source.snapshot as ArticleSourceSnapshot,
            ctaUrl: campaign.source.ctaUrl,
            unsubscribeUrl: envelope.unsubscribePageUrl,
          }
        : {
            type: "PROMO",
            snapshot: campaign.source.snapshot as PromoSourceSnapshot,
            ctaUrl: campaign.source.ctaUrl,
            unsubscribeUrl: envelope.unsubscribePageUrl,
          },
    );

    // --- send ---
    try {
      const send = await this.transport.send({
        to: liveEmail,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.html ? { html: rendered.html } : {}),
        ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
        headers: envelope.headers,
        metadata: { campaignId: String(campaign._id), campaignType: campaign.type },
      });
      await this.recipientRepository.markSent(row._id, token, {
        provider: send.provider,
        ...(send.providerMessageId ? { providerMessageId: send.providerMessageId } : {}),
        sentToEmail: liveEmail,
        now: this.clock(),
      });
      logger.info(
        {
          operation: "marketing_campaign_send",
          campaignId: String(campaign._id),
          recipientId: String(row._id),
          result: "sent",
          provider: send.provider,
          ...(send.providerMessageId ? { providerMessageId: send.providerMessageId } : {}),
        },
        "Marketing email accepted by provider",
      );
      return "sent";
    } catch (error) {
      const emailError = error instanceof EmailError ? error : null;
      const category = emailError?.category ?? "UNKNOWN";
      const message = safeErrorMessage(error);

      // Transport misconfig is campaign-fatal — don't burn the audience one 502 at a time.
      if (category === "NOT_CONFIGURED") {
        await this.recipientRepository.markFailed(row._id, token, { category, message });
        this.lastFatal = "transport not configured";
        return "failed";
      }

      const retryable = emailError?.retryable === true;
      const hasAttemptsLeft = row.attemptCount < this.options.maxAttempts;
      if (retryable && hasAttemptsLeft) {
        const delayMs = this.options.retryBaseMs * 2 ** Math.max(0, row.attemptCount - 1);
        await this.recipientRepository.scheduleRetry(row._id, token, {
          category,
          message,
          nextAttemptAt: new Date(this.clock().getTime() + delayMs),
        });
        logger.warn(
          {
            operation: "marketing_campaign_send",
            campaignId: String(campaign._id),
            recipientId: String(row._id),
            result: "retry",
            errorCategory: category,
            attemptCount: row.attemptCount,
          },
          "Marketing email delivery failed — retry scheduled",
        );
        return "retried";
      }

      await this.recipientRepository.markFailed(row._id, token, { category, message });
      logger.warn(
        {
          operation: "marketing_campaign_send",
          campaignId: String(campaign._id),
          recipientId: String(row._id),
          result: "failed",
          errorCategory: category,
          attemptCount: row.attemptCount,
        },
        "Marketing email delivery failed",
      );
      return "failed";
    }
  }

  // ------------------------------------------------------------------ terminal

  private async completeCampaign(
    campaignId: Types.ObjectId | string,
    from: "MATERIALIZING" | "SENDING",
  ): Promise<boolean> {
    const done = await this.campaignRepository.transitionStatus(campaignId, from, "SENT", {
      finishedAt: this.clock(),
    });
    if (!done) {
      return false;
    }
    const histogram = await this.recipientRepository.aggregateCountsByStatus(campaignId);
    await this.campaignRepository.reconcileCounts(campaignId, histogram);
    logger.info(
      { operation: "marketing_campaign", campaignId: String(campaignId), result: "sent" },
      "Marketing campaign completed",
    );
    return true;
  }

  private async failCampaign(
    campaignId: Types.ObjectId | string,
    from: "MATERIALIZING" | "SENDING",
    reason: string,
  ): Promise<void> {
    const failed = await this.campaignRepository.transitionStatus(campaignId, from, "FAILED", {
      finishedAt: this.clock(),
      failureReason: reason.slice(0, 300),
    });
    if (!failed) {
      return;
    }
    const histogram = await this.recipientRepository.aggregateCountsByStatus(campaignId);
    await this.campaignRepository.reconcileCounts(campaignId, histogram);
    logger.warn(
      { operation: "marketing_campaign", campaignId: String(campaignId), result: "failed", reason },
      "Marketing campaign failed",
    );
  }
}
