import { model, Schema, type Types } from "mongoose";
import { type ProviderPayoutStatus, providerPayoutStatuses } from "./central-payout.types.js";

/**
 * One Super Admin withdrawal request from Bookly's central Stripe balance (P0.6).
 *
 * Its own collection on purpose: the booking ledger requires a bookingId, and BusinessPayout is a
 * Business-scoped settlement record. A withdrawal moves Bookly's Stripe balance to Bookly's own
 * bank; it is neither revenue nor a customer payment, so it never writes ledger rows (the money is
 * already represented by Stripe balance transactions — writing rows would double-count it).
 *
 * `state` is Bookly's knowledge of the provider request:
 *  - PREPARED  — persisted, not yet sent (or crashed before sending);
 *  - UNKNOWN   — sent, outcome not confirmed (response lost / Stripe 5xx). Reconciled, never re-created
 *                under a new identity;
 *  - SUBMITTED — Stripe returned/confirmed a payout; `providerStatus` follows Stripe;
 *  - REJECTED  — Stripe certainly created nothing.
 * `activeSlot` exists only while PREPARED/UNKNOWN; its unique index admits one unresolved
 * withdrawal at a time, so concurrent submissions cannot both reach Stripe.
 */
export type CentralPayoutState = "PREPARED" | "UNKNOWN" | "SUBMITTED" | "REJECTED";

export type CentralPayoutAuditEntry = {
  at: Date;
  kind:
    | "REQUESTED"
    | "DISPATCHED"
    | "PROVIDER_ACCEPTED"
    | "PROVIDER_REJECTED"
    | "OUTCOME_UNKNOWN"
    | "RECOVERED"
    | "STATUS_CHANGED"
    | "MISMATCH"
    | "REQUIRES_REVIEW"
    | "BLOCKED";
  source?: "API" | "WEBHOOK" | "REFRESH" | "RECOVERY" | undefined;
  detail?: string | undefined;
  providerEventId?: string | undefined;
  actorUserId?: Types.ObjectId | undefined;
};

export type CentralPayoutOperationDocument = {
  _id: Types.ObjectId;
  /** Super Admin-scoped browser request id: a resubmission returns this same operation. */
  requestKey: string;
  initiatedByUserId: Types.ObjectId;
  initiatedByEmail: string;
  mode: "TEST" | "LIVE";
  amountCents: number;
  currency: string;
  destinationId: string;
  destinationBankName?: string | undefined;
  destinationLast4: string;
  state: CentralPayoutState;
  activeSlot?: "CENTRAL" | undefined;
  providerIdempotencyKey: string;
  providerPayoutId?: string | undefined;
  providerStatus?: ProviderPayoutStatus | undefined;
  providerCreatedAt?: Date | undefined;
  estimatedArrivalAt?: Date | undefined;
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
  dispatchCount: number;
  lastDispatchedAt?: Date | undefined;
  lastSyncedAt?: Date | undefined;
  audit: CentralPayoutAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
};

const auditSchema = new Schema<CentralPayoutAuditEntry>(
  {
    at: { type: Date, required: true },
    kind: { type: String, required: true },
    source: { type: String },
    detail: { type: String, maxlength: 500 },
    providerEventId: { type: String },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const schema = new Schema<CentralPayoutOperationDocument>(
  {
    requestKey: { type: String, required: true },
    initiatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    initiatedByEmail: { type: String, required: true },
    mode: { type: String, enum: ["TEST", "LIVE"], required: true },
    amountCents: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    currency: { type: String, required: true, match: /^[a-z]{3}$/ },
    destinationId: { type: String, required: true },
    destinationBankName: { type: String },
    destinationLast4: { type: String, required: true },
    state: {
      type: String,
      enum: ["PREPARED", "UNKNOWN", "SUBMITTED", "REJECTED"],
      required: true,
    },
    activeSlot: { type: String, enum: ["CENTRAL"] },
    providerIdempotencyKey: { type: String, required: true },
    providerPayoutId: { type: String },
    providerStatus: { type: String, enum: providerPayoutStatuses },
    providerCreatedAt: { type: Date },
    estimatedArrivalAt: { type: Date },
    failureCode: { type: String },
    failureMessage: { type: String, maxlength: 500 },
    dispatchCount: { type: Number, required: true, default: 0 },
    lastDispatchedAt: { type: Date },
    lastSyncedAt: { type: Date },
    audit: { type: [auditSchema], default: [] },
  },
  { timestamps: true },
);

schema.index({ requestKey: 1 }, { unique: true });
schema.index({ providerIdempotencyKey: 1 }, { unique: true });
schema.index(
  { providerPayoutId: 1 },
  { unique: true, partialFilterExpression: { providerPayoutId: { $type: "string" } } },
);
schema.index(
  { activeSlot: 1 },
  { unique: true, partialFilterExpression: { activeSlot: { $type: "string" } } },
);
schema.index({ createdAt: -1, _id: -1 });

export const CentralPayoutOperationModel = model<CentralPayoutOperationDocument>(
  "CentralPayoutOperation",
  schema,
);
