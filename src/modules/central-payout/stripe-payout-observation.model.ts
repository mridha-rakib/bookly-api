import { model, Schema, type Types } from "mongoose";
import type { CentralStripeMode } from "./central-payout.types.js";

/**
 * FG03B-1 — durable, NON-MONETARY evidence that Stripe reported a payout on the platform account.
 *
 * One document per Stripe payout per mode (Stripe payout ids are unique; the mode keeps TEST and
 * LIVE evidence apart). It is written from verified webhooks and from the bounded history sync.
 * It is NOT a ledger entry, NOT a withdrawal operation and NOT proof of ownership, authorization
 * or bank receipt: it only records that Stripe reported this cash movement and how (or whether)
 * it links to a Bookly withdrawal operation.
 *
 *   VERIFIED_BOOKLY — a CentralPayoutOperation records this exact payout id in the same mode.
 *   UNRESOLVED      — metadata names an existing Bookly operation in the same mode that has not
 *                     yet recorded any payout id (e.g. awaiting confirmation). Not trusted as proof.
 *   NOT_VERIFIED    — no verified link (e.g. Stripe Dashboard or automatic payout). Never treated
 *                     as unauthorized.
 *
 * Stored fields are deliberately minimal: no metadata payload, no bank numbers (the destination is
 * only Stripe's opaque bank-account reference, masked at read time), no failure free text.
 */
export type PayoutLinkage = "VERIFIED_BOOKLY" | "UNRESOLVED" | "NOT_VERIFIED";
export const payoutLinkages = ["VERIFIED_BOOKLY", "UNRESOLVED", "NOT_VERIFIED"] as const;

export type PayoutObservationSource = "WEBHOOK" | "HISTORY_SYNC";

/**
 * FG03B-2 — every observation is bound to the Stripe platform account (acct_…) that reported it.
 * The account comes from the configured secret key's own account (never from payload metadata);
 * all readiness and review reads are scoped to `{ accountId, mode }` of the CURRENT account, so a
 * previously configured account's evidence is retained but never counted. An observation already
 * held under a different account is never rewritten (see observeProviderPayout).
 */
export type StripePayoutObservationDocument = {
  _id: Types.ObjectId;
  accountId: string;
  mode: CentralStripeMode;
  providerPayoutId: string;
  amountCents: number;
  currency: string;
  automatic: boolean;
  providerCreatedAt: Date;
  destinationId?: string | undefined;
  /** Masked last 4 of the destination bank, when the account's bank inventory named it. */
  destinationLast4?: string | undefined;
  status: string;
  /** Lifecycle rank of `status`; an observation never moves back to a lower rank. */
  statusRank: number;
  arrivalDate?: Date | undefined;
  failureCode?: string | undefined;
  linkage: PayoutLinkage;
  /** Set only for VERIFIED_BOOKLY. */
  operationId?: Types.ObjectId | undefined;
  /** Set only for UNRESOLVED: the Bookly operation the metadata names (unconfirmed). */
  claimedOperationId?: Types.ObjectId | undefined;
  firstObservedVia: PayoutObservationSource;
  lastObservedVia: PayoutObservationSource;
  lastProviderEventId?: string | undefined;
  firstObservedAt: Date;
  lastObservedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<StripePayoutObservationDocument>(
  {
    accountId: { type: String, required: true, match: /^acct_[A-Za-z0-9]+$/ },
    mode: { type: String, enum: ["TEST", "LIVE"], required: true },
    providerPayoutId: { type: String, required: true, match: /^po_[A-Za-z0-9_]+$/ },
    amountCents: { type: Number, required: true, validate: Number.isSafeInteger },
    currency: { type: String, required: true, match: /^[a-z]{3}$/ },
    automatic: { type: Boolean, required: true },
    providerCreatedAt: { type: Date, required: true },
    destinationId: { type: String, maxlength: 64 },
    destinationLast4: { type: String, match: /^[A-Za-z0-9]{4}$/ },
    status: { type: String, required: true, maxlength: 32 },
    statusRank: { type: Number, required: true },
    arrivalDate: { type: Date },
    failureCode: { type: String, maxlength: 64 },
    linkage: { type: String, enum: payoutLinkages, required: true },
    operationId: { type: Schema.Types.ObjectId, ref: "CentralPayoutOperation" },
    claimedOperationId: { type: Schema.Types.ObjectId, ref: "CentralPayoutOperation" },
    firstObservedVia: { type: String, enum: ["WEBHOOK", "HISTORY_SYNC"], required: true },
    lastObservedVia: { type: String, enum: ["WEBHOOK", "HISTORY_SYNC"], required: true },
    lastProviderEventId: { type: String, maxlength: 255 },
    firstObservedAt: { type: Date, required: true },
    lastObservedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Additive provisioning (production autoIndex is off) — see docs/CENTRAL-PAYOUT-OBSERVATIONS.md.
// One record per Stripe payout per mode (payout ids are globally unique), so a payout can never be
// re-recorded under a second account; the scoped indexes serve readiness counts and review pages.
schema.index({ mode: 1, providerPayoutId: 1 }, { unique: true });
schema.index({ accountId: 1, mode: 1, providerCreatedAt: -1 });
schema.index({ accountId: 1, mode: 1, linkage: 1, providerCreatedAt: -1 });
schema.index({ accountId: 1, mode: 1, status: 1, providerCreatedAt: -1 });

export const StripePayoutObservationModel = model<StripePayoutObservationDocument>(
  "StripePayoutObservation",
  schema,
);

/**
 * FG03B-1 — one checkpoint per mode for the bounded, resumable Stripe payout history sync.
 *
 *   NEVER_RUN   — no history enumeration has been attempted.
 *   IN_PROGRESS — a run has started and not yet reached Stripe's last page (it may be paused at
 *                 its page budget, interrupted by a provider error, or awaiting resume).
 *   COMPLETE    — a run reached Stripe's last page (`has_more: false`) with every page observed.
 *                 Coverage then holds only for payouts created before `completeAsOf`; later
 *                 payouts depend on webhook delivery until the next completed run.
 *
 * The lease (`leaseId` + `leaseExpiresAt`) admits one run at a time; every checkpoint write is
 * conditional on still holding it.
 */
export type HistoryCoverageState = "NEVER_RUN" | "IN_PROGRESS" | "COMPLETE";

export type StripePayoutHistoryCoverageDocument = {
  _id: Types.ObjectId;
  mode: CentralStripeMode;
  /** The Stripe platform account the coverage belongs to (acct_…); coverage resets on change. */
  accountId?: string | undefined;
  state: HistoryCoverageState;
  completeAsOf?: Date | undefined;
  lastCompletedAt?: Date | undefined;
  run?:
    | {
        startedAt: Date;
        createdGte?: Date | undefined;
        cursor?: string | undefined;
        pages: number;
        observed: number;
      }
    | undefined;
  lastRunAt?: Date | undefined;
  lastError?: string | undefined;
  leaseId?: string | undefined;
  leaseExpiresAt?: Date | undefined;
  audit: {
    at: Date;
    kind: string;
    actorUserId?: Types.ObjectId | undefined;
    detail?: string | undefined;
  }[];
  createdAt: Date;
  updatedAt: Date;
};

const coverageSchema = new Schema<StripePayoutHistoryCoverageDocument>(
  {
    mode: { type: String, enum: ["TEST", "LIVE"], required: true },
    accountId: { type: String, maxlength: 64 },
    state: { type: String, enum: ["NEVER_RUN", "IN_PROGRESS", "COMPLETE"], required: true },
    completeAsOf: { type: Date },
    lastCompletedAt: { type: Date },
    run: {
      type: new Schema(
        {
          startedAt: { type: Date, required: true },
          createdGte: { type: Date },
          cursor: { type: String, maxlength: 64 },
          pages: { type: Number, required: true },
          observed: { type: Number, required: true },
        },
        { _id: false },
      ),
    },
    lastRunAt: { type: Date },
    lastError: { type: String, maxlength: 500 },
    leaseId: { type: String },
    leaseExpiresAt: { type: Date },
    audit: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            kind: { type: String, required: true },
            actorUserId: { type: Schema.Types.ObjectId, ref: "User" },
            detail: { type: String, maxlength: 500 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

coverageSchema.index({ mode: 1 }, { unique: true });

export const StripePayoutHistoryCoverageModel = model<StripePayoutHistoryCoverageDocument>(
  "StripePayoutHistoryCoverage",
  coverageSchema,
);
