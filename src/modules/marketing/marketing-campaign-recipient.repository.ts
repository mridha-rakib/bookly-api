import { Types } from "mongoose";

import type { MarketingRecipientStatus } from "./marketing-campaign.types.js";
import {
  type MarketingCampaignRecipientDocument,
  MarketingCampaignRecipientModel,
} from "./marketing-campaign-recipient.model.js";

const toObjectId = (value: Types.ObjectId | string): Types.ObjectId =>
  typeof value === "string" ? new Types.ObjectId(value) : value;

export type MaterializeRecipientRow = {
  userId: Types.ObjectId | string;
  emailFrozen: string;
};

/** A Mongo bulk-write error carrying per-op results (duplicate-key entries have code 11000). */
type BulkWriteLikeError = {
  code?: number;
  writeErrors?: Array<{ code?: number; err?: { code?: number } }>;
};

const isAllDuplicateKeyError = (error: unknown): boolean => {
  const e = error as BulkWriteLikeError | null;
  if (!e || typeof e !== "object") {
    return false;
  }
  if (e.code === 11000 && !e.writeErrors) {
    return true;
  }
  if (Array.isArray(e.writeErrors) && e.writeErrors.length > 0) {
    return e.writeErrors.every((w) => w.code === 11000 || w.err?.code === 11000);
  }
  return false;
};

export type ClaimRecipientOptions = {
  campaignId: Types.ObjectId | string;
  now: Date;
  claimTimeoutMs: number;
  maxAttempts: number;
  claimedBy: string;
};

const TERMINAL_SKIP: ReadonlySet<MarketingRecipientStatus> = new Set([
  "SKIPPED_OPT_OUT",
  "SKIPPED_UNVERIFIED",
  "SKIPPED_INACTIVE",
  "SKIPPED_SOURCE_INVALID",
]);

/**
 * Marketing Email Stage M3A/M3B — persistence for MarketingCampaignRecipient.
 *
 * M3A: `insertPendingBatch` (materialization) + counts.
 * M3B: the delivery-queue operations, all mirroring the `EmailOutboxRepository` claim/mark
 * pattern. Every mutating M3B write is guarded on `{ _id, status: "PROCESSING", claimedBy }`
 * (the per-claim unique token) so a stale worker whose row was reclaimed can never clobber it.
 */
export class MarketingCampaignRecipientRepository {
  /** @returns the number of NEW rows actually inserted in this batch. */
  public async insertPendingBatch(
    campaignId: Types.ObjectId | string,
    rows: MaterializeRecipientRow[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const docs = rows.map((row) => ({
      campaignId,
      userId: row.userId,
      emailFrozen: row.emailFrozen,
      status: "PENDING" as const,
      attemptCount: 0,
    }));

    try {
      const inserted = await MarketingCampaignRecipientModel.insertMany(docs, {
        ordered: false,
      });
      return inserted.length;
    } catch (error) {
      if (isAllDuplicateKeyError(error)) {
        const e = error as { insertedDocs?: unknown[] };
        return Array.isArray(e.insertedDocs) ? e.insertedDocs.length : 0;
      }
      throw error;
    }
  }

  public async countForCampaign(campaignId: Types.ObjectId | string): Promise<number> {
    const filter: Record<string, unknown> = { campaignId };
    return MarketingCampaignRecipientModel.countDocuments(filter).exec();
  }

  public async countForCampaignByStatus(
    campaignId: Types.ObjectId | string,
    status: string,
  ): Promise<number> {
    const filter: Record<string, unknown> = { campaignId, status };
    return MarketingCampaignRecipientModel.countDocuments(filter).exec();
  }

  /** True while any row for the campaign is still `PENDING` or `PROCESSING` (drives completion). */
  public async hasOutstanding(campaignId: Types.ObjectId | string): Promise<boolean> {
    const filter: Record<string, unknown> = {
      campaignId,
      status: { $in: ["PENDING", "PROCESSING"] },
    };
    const outstanding = await MarketingCampaignRecipientModel.exists(filter);
    return outstanding !== null;
  }

  /** Terminal-state histogram for one campaign — the authoritative source for `counts`. */
  public async aggregateCountsByStatus(
    campaignId: Types.ObjectId | string,
  ): Promise<Record<string, number>> {
    const rows = await MarketingCampaignRecipientModel.aggregate<{ _id: string; n: number }>([
      { $match: { campaignId: toObjectId(campaignId) } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]).exec();
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row._id] = row.n;
    }
    return out;
  }

  /**
   * Atomically claims ONE eligible recipient of the campaign → `PROCESSING` (`null` when none).
   * Eligible: `PENDING` and due, OR `PROCESSING` with a stale claim — both only while attempts
   * remain. `attemptCount` is incremented on claim. `claimedBy` is the caller's per-claim token.
   */
  public async claimNext(
    options: ClaimRecipientOptions,
  ): Promise<MarketingCampaignRecipientDocument | null> {
    const staleBefore = new Date(options.now.getTime() - options.claimTimeoutMs);
    return MarketingCampaignRecipientModel.findOneAndUpdate(
      {
        campaignId: options.campaignId,
        attemptCount: { $lt: options.maxAttempts },
        $or: [
          {
            status: "PENDING",
            $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: options.now } }],
          },
          { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: { status: "PROCESSING", claimedAt: options.now, claimedBy: options.claimedBy },
        $inc: { attemptCount: 1 },
      },
      { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
    ).exec();
  }

  public async markSent(
    id: Types.ObjectId,
    claimedBy: string,
    input: {
      provider: string;
      providerMessageId?: string | undefined;
      sentToEmail: string;
      now: Date;
    },
  ): Promise<MarketingCampaignRecipientDocument | null> {
    return MarketingCampaignRecipientModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy },
      {
        $set: {
          status: "SENT",
          sentAt: input.now,
          provider: input.provider,
          sentToEmail: input.sentToEmail,
          ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        },
        $unset: { claimedAt: "", claimedBy: "", nextAttemptAt: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public async scheduleRetry(
    id: Types.ObjectId,
    claimedBy: string,
    input: { category: string; message: string; nextAttemptAt: Date },
  ): Promise<MarketingCampaignRecipientDocument | null> {
    return MarketingCampaignRecipientModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy },
      {
        $set: {
          status: "PENDING",
          nextAttemptAt: input.nextAttemptAt,
          lastErrorCategory: input.category,
          lastErrorMessage: input.message.slice(0, 500),
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public async markFailed(
    id: Types.ObjectId,
    claimedBy: string,
    input: { category: string; message: string },
  ): Promise<MarketingCampaignRecipientDocument | null> {
    return MarketingCampaignRecipientModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy },
      {
        $set: {
          status: "FAILED",
          lastErrorCategory: input.category,
          lastErrorMessage: input.message.slice(0, 500),
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  /** Terminal `SKIPPED_*` — the recipient failed a live eligibility / source check, no retry. */
  public async markSkipped(
    id: Types.ObjectId,
    claimedBy: string,
    status: MarketingRecipientStatus,
  ): Promise<MarketingCampaignRecipientDocument | null> {
    if (!TERMINAL_SKIP.has(status)) {
      throw new Error(`markSkipped called with non-skip status ${status}`);
    }
    return MarketingCampaignRecipientModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy },
      { $set: { status }, $unset: { claimedAt: "", claimedBy: "" } },
      { returnDocument: "after" },
    ).exec();
  }

  /** Pass-start sweep: stale `PROCESSING` rows with attempts left → `PENDING`; attempts
   * exhausted → `FAILED`. Returns `{ recovered, failed }` counts. */
  public async recoverStale(
    campaignId: Types.ObjectId | string,
    staleBefore: Date,
    maxAttempts: number,
  ): Promise<{ recovered: number; failed: number }> {
    const [recovered, failed] = await Promise.all([
      MarketingCampaignRecipientModel.updateMany(
        {
          campaignId,
          status: "PROCESSING",
          claimedAt: { $lte: staleBefore },
          attemptCount: { $lt: maxAttempts },
        },
        { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
      ).exec(),
      MarketingCampaignRecipientModel.updateMany(
        {
          campaignId,
          status: "PROCESSING",
          claimedAt: { $lte: staleBefore },
          attemptCount: { $gte: maxAttempts },
        },
        {
          $set: {
            status: "FAILED",
            lastErrorCategory: "ATTEMPTS_EXHAUSTED",
            lastErrorMessage: "max attempts reached while claimed",
          },
          $unset: { claimedAt: "", claimedBy: "" },
        },
      ).exec(),
    ]);
    return { recovered: recovered.modifiedCount ?? 0, failed: failed.modifiedCount ?? 0 };
  }

  /** Campaign cancellation / campaign-level FAILED: terminalize every still-outstanding row so
   * `counts` reconcile. `to` is `CANCELLED` (admin cancel), `SKIPPED_SOURCE_INVALID` (source
   * went bad mid-run), or `FAILED` (transport not configured / fatal). Rows already
   * `SENT`/`FAILED`/`SKIPPED_*` are untouched. */
  public async terminalizeOutstanding(
    campaignId: Types.ObjectId | string,
    to: "CANCELLED" | "SKIPPED_SOURCE_INVALID" | "FAILED",
  ): Promise<number> {
    const result = await MarketingCampaignRecipientModel.updateMany(
      { campaignId, status: { $in: ["PENDING", "PROCESSING"] } },
      { $set: { status: to }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }
}
