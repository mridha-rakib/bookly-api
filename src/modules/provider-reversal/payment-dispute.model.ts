import { model, Schema, type Types } from "mongoose";

/**
 * P6 — durable provider dispute (chargeback) LIFECYCLE record. It is audit/support state only:
 * every money movement of a dispute is an immutable ledger row (DISPUTE_WITHDRAWAL /
 * DISPUTE_REINSTATEMENT / DISPUTE_FEE / DISPUTE_FEE_REVERSAL, keyed per provider balance
 * transaction) — this record never stores or derives a balance. No evidence content is kept.
 */
export const disputeCorrelationStates = ["PENDING", "CORRELATED", "INVESTIGATION"] as const;
export type DisputeCorrelationState = (typeof disputeCorrelationStates)[number];

export const disputeOutcomes = ["WON", "LOST", "PREVENTED", "WARNING_CLOSED"] as const;
export type DisputeOutcome = (typeof disputeOutcomes)[number];

export type PaymentDisputeDocument = {
  _id: Types.ObjectId;
  providerDisputeId: string;
  providerChargeId?: string | undefined;
  providerPaymentIntentId?: string | undefined;
  amountCents: number;
  currency: string;
  /** The provider's latest known status (e.g. needs_response, under_review, won, lost). */
  providerStatus: string;
  reason?: string | undefined;
  evidenceDueAt?: Date | undefined;
  providerCreatedAt: Date;
  /** Set once, when the provider reports a final status; a final record is never reopened. */
  final: boolean;
  outcome?: DisputeOutcome | undefined;
  closedAt?: Date | undefined;
  /** Earliest provider-confirmed withdrawal / reinstatement (informational; money is ledgered). */
  fundsWithdrawnAt?: Date | undefined;
  fundsReinstatedAt?: Date | undefined;
  correlation: DisputeCorrelationState;
  investigationReason?: string | undefined;
  sourceTransactionId?: Types.ObjectId | undefined;
  sourceType?: string | undefined;
  economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
  bookingId?: Types.ObjectId | undefined;
  businessId?: Types.ObjectId | undefined;
  businessClientId?: Types.ObjectId | undefined;
  customerUserId?: Types.ObjectId | undefined;
  lastSyncedAt: Date;
  lastSyncedVia: "WEBHOOK" | "POLLING" | "REPLAY";
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<PaymentDisputeDocument>(
  {
    providerDisputeId: { type: String, required: true, trim: true },
    providerChargeId: { type: String, trim: true },
    providerPaymentIntentId: { type: String, trim: true },
    amountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    providerStatus: { type: String, required: true, trim: true, maxlength: 60 },
    reason: { type: String, trim: true, maxlength: 120 },
    evidenceDueAt: { type: Date },
    providerCreatedAt: { type: Date, required: true },
    final: { type: Boolean, required: true, default: false },
    outcome: { type: String, enum: disputeOutcomes },
    closedAt: { type: Date },
    fundsWithdrawnAt: { type: Date },
    fundsReinstatedAt: { type: Date },
    correlation: {
      type: String,
      enum: disputeCorrelationStates,
      required: true,
      default: "PENDING",
    },
    investigationReason: { type: String, trim: true, maxlength: 500 },
    sourceTransactionId: { type: Schema.Types.ObjectId, ref: "BookingFinancialTransaction" },
    sourceType: { type: String, trim: true },
    economicOwner: { type: String, enum: ["BOOKLY", "BUSINESS"] },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient" },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    lastSyncedAt: { type: Date, required: true },
    lastSyncedVia: { type: String, enum: ["WEBHOOK", "POLLING", "REPLAY"], required: true },
  },
  { timestamps: true },
);

schema.index({ providerDisputeId: 1 }, { unique: true });
// Support list / open-dispute backstop.
schema.index({ final: 1, updatedAt: 1 });
// Business-scoped read.
schema.index({ businessId: 1, createdAt: -1 });

export const PaymentDisputeModel = model<PaymentDisputeDocument>("PaymentDispute", schema);
