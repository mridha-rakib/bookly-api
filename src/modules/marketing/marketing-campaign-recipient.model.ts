import { model, Schema, type Types } from "mongoose";

import {
  type MarketingRecipientStatus,
  marketingRecipientStatuses,
} from "./marketing-campaign.types.js";

/**
 * Marketing Email Stage M3A — one campaign ↔ one recipient.
 *
 * This collection IS the delivery queue (approved Option A) — there is NO `MarketingEmailOutbox`
 * and marketing never writes to the transactional `EmailOutbox`. M3A only ever materializes rows
 * in `PENDING`; the send-only fields (`attemptCount`, `claimedAt`, `sentAt`, …) exist so the M3B
 * worker inherits the exact `EmailOutbox` claim/backoff pattern without a schema change.
 *
 * `emailFrozen` is the normalized verified email at materialization time — kept for deterministic
 * reporting, dedupe and retry stability. It is NOT the final send address and is NEVER mutated:
 * the M3B worker re-reads the live verified `User.normalizedEmail` immediately before sending and
 * records the address it actually used in `sentToEmail`.
 *
 * Identity is `{campaignId, userId}` (unique) — the campaign-recipient idempotency key. A
 * re-run of materialization is a no-op for rows that already exist.
 */
export type MarketingCampaignRecipientDocument = {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  userId: Types.ObjectId;
  emailFrozen: string;
  status: MarketingRecipientStatus;
  attemptCount: number;
  claimedAt?: Date | undefined;
  claimedBy?: string | undefined;
  nextAttemptAt?: Date | undefined;
  /** Provider name (`sendgrid`/`resend`/`smtp`) on a `SENT` row. */
  provider?: string | undefined;
  providerMessageId?: string | undefined;
  /** The address actually sent to (the live verified email at send time). May differ from
   * `emailFrozen` if the customer changed their email after materialization. Set on `SENT`. */
  sentToEmail?: string | undefined;
  lastErrorCategory?: string | undefined;
  lastErrorMessage?: string | undefined;
  sentAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const marketingCampaignRecipientSchema = new Schema<MarketingCampaignRecipientDocument>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: "MarketingCampaign", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    emailFrozen: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    status: {
      type: String,
      enum: marketingRecipientStatuses,
      required: true,
      default: "PENDING",
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    claimedAt: { type: Date },
    claimedBy: { type: String, trim: true, maxlength: 200 },
    nextAttemptAt: { type: Date },
    provider: { type: String, trim: true, maxlength: 40 },
    providerMessageId: { type: String, trim: true, maxlength: 200 },
    sentToEmail: { type: String, trim: true, lowercase: true, maxlength: 320 },
    lastErrorCategory: { type: String, trim: true, maxlength: 80 },
    lastErrorMessage: { type: String, trim: true, maxlength: 500 },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

// Campaign-recipient idempotency — one row per (campaign, user). Materialization re-runs and
// concurrent inserts are absorbed as duplicate-key no-ops.
marketingCampaignRecipientSchema.index({ campaignId: 1, userId: 1 }, { unique: true });
// The future M3B worker's claim query: eligible rows within one campaign ordered by when due.
marketingCampaignRecipientSchema.index({ campaignId: 1, status: 1, nextAttemptAt: 1 });

export const MarketingCampaignRecipientModel = model<MarketingCampaignRecipientDocument>(
  "MarketingCampaignRecipient",
  marketingCampaignRecipientSchema,
);
