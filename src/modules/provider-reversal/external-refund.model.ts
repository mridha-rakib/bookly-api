import { model, Schema, type Types } from "mongoose";

/**
 * P6 — a refund the provider confirmed that Bookly did NOT initiate (no RefundOperation — e.g. a
 * refund made in the Stripe Dashboard). Provider truth wins: it is accounted as a REFUND ledger
 * row marked `refundOrigin: PROVIDER_EXTERNAL` (never a synthetic RefundOperation, whose meaning
 * is "Bookly-authorized intent"). This record is its durable identity + investigation state; one
 * provider refund id = one record = at most one ledger row.
 */
export const externalRefundStates = ["ACCOUNTED", "INVESTIGATION"] as const;
export type ExternalRefundState = (typeof externalRefundStates)[number];

export type ExternalRefundDocument = {
  _id: Types.ObjectId;
  providerRefundId: string;
  providerPaymentIntentId?: string | undefined;
  amountCents: number;
  currency: string;
  providerCreatedAt?: Date | undefined;
  state: ExternalRefundState;
  investigationReason?: string | undefined;
  sourceTransactionId?: Types.ObjectId | undefined;
  sourceType?: string | undefined;
  economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
  ledgerTransactionId?: Types.ObjectId | undefined;
  bookingId?: Types.ObjectId | undefined;
  businessId?: Types.ObjectId | undefined;
  businessClientId?: Types.ObjectId | undefined;
  detectedVia: "WEBHOOK" | "POLLING" | "REPLAY";
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<ExternalRefundDocument>(
  {
    providerRefundId: { type: String, required: true, trim: true },
    providerPaymentIntentId: { type: String, trim: true },
    amountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    providerCreatedAt: { type: Date },
    state: { type: String, enum: externalRefundStates, required: true },
    investigationReason: { type: String, trim: true, maxlength: 500 },
    sourceTransactionId: { type: Schema.Types.ObjectId, ref: "BookingFinancialTransaction" },
    sourceType: { type: String, trim: true },
    economicOwner: { type: String, enum: ["BOOKLY", "BUSINESS"] },
    ledgerTransactionId: { type: Schema.Types.ObjectId, ref: "BookingFinancialTransaction" },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient" },
    detectedVia: { type: String, enum: ["WEBHOOK", "POLLING", "REPLAY"], required: true },
  },
  { timestamps: true },
);

// Customer-owned detail: bounded, deterministic read; no financial transition.
schema.index({ bookingId: 1, createdAt: -1, _id: -1 });
schema.index({ providerRefundId: 1 }, { unique: true });
schema.index({ state: 1, createdAt: -1 });
schema.index({ businessId: 1, createdAt: -1 });

export const ExternalRefundModel = model<ExternalRefundDocument>("ExternalRefund", schema);
