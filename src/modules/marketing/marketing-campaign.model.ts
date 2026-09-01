import { model, Schema, type Types } from "mongoose";

import {
  type MarketingAudienceScope,
  type MarketingCampaignCounts,
  type MarketingCampaignOwnerScope,
  type MarketingCampaignSource,
  type MarketingCampaignStatus,
  type MarketingCampaignType,
  marketingAudienceScopes,
  marketingCampaignOwnerScopes,
  marketingCampaignStatuses,
  marketingCampaignTypes,
  marketingSourceKinds,
} from "./marketing-campaign.types.js";

/**
 * Marketing Email Stage M3A — a single marketing campaign.
 *
 * Content is NEVER free-typed: `source` is a reference to (+ a frozen display snapshot of) an
 * existing trusted row — a PUBLISHED `BlogPost` or an ACTIVE `PromoCode`. The campaign owns
 * scheduling metadata and a status lifecycle; it does not own a recipient list (see
 * `MarketingCampaignRecipient`). M3A drives it only as far as `MATERIALIZING`; the M3B worker
 * picks it up from there. No email is sent by anything that touches this model in M3A.
 */
export type MarketingCampaignDocument = {
  _id: Types.ObjectId;
  type: MarketingCampaignType;
  ownerScope: MarketingCampaignOwnerScope;
  createdByUserId: Types.ObjectId;
  source: MarketingCampaignSource;
  audience: { scope: MarketingAudienceScope };
  status: MarketingCampaignStatus;
  /** Absolute UTC instant the campaign should send at. Equals `createdAt` for "send now". No
   * customer/venue timezone is ever involved. */
  scheduledAt: Date;
  startedAt?: Date | undefined;
  /** Set (M3B) once `MarketingAudienceService.materializeAllOptedIn` has fully drained the
   * opted-in scan. `MATERIALIZING → SENDING` requires this — it separates "scan running" from
   * "audience complete" without a separate status. */
  materializedAt?: Date | undefined;
  finishedAt?: Date | undefined;
  /** Set (M3B) only on a campaign-level `FAILED` — a safe, generic reason (source invalid /
   * one-click unsubscribe not configured / transport not configured). Never a provider body. */
  failureReason?: string | undefined;
  counts: MarketingCampaignCounts;
  createdAt: Date;
  updatedAt: Date;
};

const countsSchema = new Schema<MarketingCampaignCounts>(
  {
    audience: { type: Number, required: true, default: 0, min: 0 },
    sent: { type: Number, required: true, default: 0, min: 0 },
    skippedOptOut: { type: Number, required: true, default: 0, min: 0 },
    skippedUnverified: { type: Number, required: true, default: 0, min: 0 },
    skippedInactive: { type: Number, required: true, default: 0, min: 0 },
    skippedSourceInvalid: { type: Number, required: true, default: 0, min: 0 },
    failed: { type: Number, required: true, default: 0, min: 0 },
    cancelled: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const sourceSchema = new Schema<MarketingCampaignSource>(
  {
    kind: { type: String, enum: marketingSourceKinds, required: true },
    sourceId: { type: String, required: true, trim: true },
    sourceSlug: { type: String, trim: true },
    ctaUrl: { type: String, required: true, trim: true },
    // Display snapshot — shape depends on `kind` (validated in the service, not structurally
    // here, matching this codebase's "Mongoose does structure, services do cross-field rules").
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const marketingCampaignSchema = new Schema<MarketingCampaignDocument>(
  {
    type: { type: String, enum: marketingCampaignTypes, required: true },
    ownerScope: {
      type: String,
      enum: marketingCampaignOwnerScopes,
      required: true,
      default: "PLATFORM",
    },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    source: { type: sourceSchema, required: true },
    audience: {
      type: {
        scope: {
          type: String,
          enum: marketingAudienceScopes,
          required: true,
          default: "ALL_OPTED_IN",
        },
      },
      required: true,
      _id: false,
    },
    status: {
      type: String,
      enum: marketingCampaignStatuses,
      required: true,
      default: "DRAFT",
    },
    scheduledAt: { type: Date, required: true },
    startedAt: { type: Date },
    materializedAt: { type: Date },
    finishedAt: { type: Date },
    failureReason: { type: String, trim: true, maxlength: 300 },
    counts: { type: countsSchema, required: true, default: () => ({}) },
  },
  { timestamps: true },
);

// The future M3B worker's "campaigns ready to run" query: filter by status, order by when
// they're due.
marketingCampaignSchema.index({ status: 1, scheduledAt: 1 });
// Super Admin campaign list — newest first.
marketingCampaignSchema.index({ createdAt: -1 });

export const MarketingCampaignModel = model<MarketingCampaignDocument>(
  "MarketingCampaign",
  marketingCampaignSchema,
);
