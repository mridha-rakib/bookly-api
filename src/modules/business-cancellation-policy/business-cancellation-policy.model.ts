import { model, Schema, type Types } from "mongoose";

/**
 * A Business's cancellation-fee and no-show-fee policy — the real backend for the existing
 * "Cancellation & No-show" Settings tab (see DashboardSettings.tsx / settingsMockData.ts on
 * the frontend, which renders exactly these five fixed windows). Structurally mirrors
 * BusinessOpeningHours: a 1:1 Business configuration document, owner-only, where a missing
 * document means "not configured" rather than any fabricated default fee.
 *
 * This module is persistence + validation only in this phase — nothing here executes a
 * charge. A future Cancellation/No-show batch reads this policy to decide what to charge;
 * it does not live here.
 */
export const cancellationTiers = [
  "MORE_THAN_72_HOURS",
  "BETWEEN_24_AND_72_HOURS",
  "BETWEEN_12_AND_24_HOURS",
  "BETWEEN_2_AND_12_HOURS",
  "UNDER_2_HOURS",
] as const;

export type CancellationTier = (typeof cancellationTiers)[number];

export const cancellationFeeModes = ["FREE", "PERCENTAGE"] as const;
export type CancellationFeeMode = (typeof cancellationFeeModes)[number];

/** The product-confirmed floor for any percentage-based fee — never invented per-tier. */
export const CANCELLATION_PERCENTAGE_MIN = 20;
export const CANCELLATION_PERCENTAGE_MAX = 100;

export type CancellationTierRule = {
  tier: CancellationTier;
  mode: CancellationFeeMode;
  /** Required and in [20, 100] when mode is PERCENTAGE; absent when mode is FREE. */
  percentage?: number;
};

export type BusinessCancellationPolicyDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  /** Always exactly one rule per cancellationTiers entry — see the schema hook below. */
  tiers: CancellationTierRule[];
  noShowPercentage: number;
  createdAt: Date;
  updatedAt: Date;
};

const cancellationTierRuleSchema = new Schema<CancellationTierRule>(
  {
    tier: { type: String, enum: cancellationTiers, required: true },
    mode: { type: String, enum: cancellationFeeModes, required: true },
    percentage: {
      type: Number,
      required: false,
      min: CANCELLATION_PERCENTAGE_MIN,
      max: CANCELLATION_PERCENTAGE_MAX,
    },
  },
  { _id: false },
);

// Cross-field structural check (percentage required and floored only for PERCENTAGE mode;
// absent for FREE) as a subdocument pre-validate hook — same rationale and same `this`-cast
// pattern as BusinessOpeningHours' day-level hook (Mongoose's validator-function typing does
// not compose cleanly with a `this`-typed parameter here). Defense in depth only — the real
// write path already enforces this via Zod first.
cancellationTierRuleSchema.pre("validate", function () {
  const rule = this as unknown as CancellationTierRule;

  if (rule.mode === "FREE" && rule.percentage !== undefined) {
    throw new Error(`${rule.tier} is marked FREE but has a percentage set`);
  }

  if (rule.mode === "PERCENTAGE" && rule.percentage === undefined) {
    throw new Error(`${rule.tier} is marked PERCENTAGE but has no percentage set`);
  }
});

const businessCancellationPolicySchema = new Schema<BusinessCancellationPolicyDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    tiers: {
      type: [cancellationTierRuleSchema],
      required: true,
      validate: {
        validator: (tiers: CancellationTierRule[]) =>
          tiers.length === cancellationTiers.length &&
          cancellationTiers.every((tier) => tiers.some((rule) => rule.tier === tier)),
        message: "tiers must contain exactly one rule for each cancellation window",
      },
    },
    noShowPercentage: {
      type: Number,
      required: true,
      min: CANCELLATION_PERCENTAGE_MIN,
      max: CANCELLATION_PERCENTAGE_MAX,
    },
  },
  { timestamps: true },
);

businessCancellationPolicySchema.index({ businessId: 1 }, { unique: true });

export const BusinessCancellationPolicyModel = model<BusinessCancellationPolicyDocument>(
  "BusinessCancellationPolicy",
  businessCancellationPolicySchema,
);
