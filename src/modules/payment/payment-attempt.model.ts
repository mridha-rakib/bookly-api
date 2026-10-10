import { model, Schema, type Types } from "mongoose";

export const paymentAttemptProviderStatuses = [
  "NOT_CREATED",
  "CREATED",
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const;
export type PaymentAttemptProviderStatus = (typeof paymentAttemptProviderStatuses)[number];

export const paymentAttemptPersistenceStatuses = [
  "NOT_STARTED",
  "PERSISTING",
  "COMPLETED",
  "FAILED",
] as const;
export type PaymentAttemptPersistenceStatus = (typeof paymentAttemptPersistenceStatuses)[number];

export const paymentAttemptCompensationStatuses = [
  "NOT_REQUIRED",
  "REQUIRED",
  "REFUND_PENDING",
  "REFUNDED",
  "RECONCILIATION_REQUIRED",
  "FAILED",
] as const;
export type PaymentAttemptCompensationStatus = (typeof paymentAttemptCompensationStatuses)[number];

export type PaymentAttemptDocument = {
  _id: Types.ObjectId;
  logicalIdempotencyKey: string;
  customerUserId: Types.ObjectId;
  businessId?: Types.ObjectId | undefined;
  purpose: string;
  productKind?: "NORMAL_BOOKING" | "PACKAGE_PURCHASE" | undefined;
  /** P1 — immutable Financial Contract V2 correlation (absent on pre-P1 / non-contract
   * attempts). A resume that would switch FIRST <-> RETURNING fails closed. */
  financialContractVersion?: 2 | undefined;
  relationshipClassification?: "FIRST" | "RETURNING" | undefined;
  businessClientId?: Types.ObjectId | undefined;
  currency: string;
  expectedAmountCents: number;
  provider: "STRIPE";
  providerCustomerId: string;
  providerPaymentIntentId?: string | undefined;
  providerStatus: PaymentAttemptProviderStatus;
  persistenceStatus: PaymentAttemptPersistenceStatus;
  compensationStatus: PaymentAttemptCompensationStatus;
  bookingId?: Types.ObjectId | undefined;
  packageProgressId?: Types.ObjectId | undefined;
  succeededTransactionId?: Types.ObjectId | undefined;
  clientSecret?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
  reconciliationNeededAt?: Date | undefined;
  lastReconciledAt?: Date | undefined;
  persistenceLeaseExpiresAt?: Date | undefined;
  persistenceLeaseToken?: string | undefined;
  recoveryAttemptCount: number;
  nextRecoveryAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<PaymentAttemptDocument>(
  {
    logicalIdempotencyKey: { type: String, required: true, trim: true, maxlength: 250 },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    purpose: { type: String, required: true, trim: true, maxlength: 80 },
    productKind: { type: String, enum: ["NORMAL_BOOKING", "PACKAGE_PURCHASE"] },
    financialContractVersion: { type: Number, enum: [2] },
    relationshipClassification: { type: String, enum: ["FIRST", "RETURNING"] },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient" },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    expectedAmountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    provider: { type: String, enum: ["STRIPE"], required: true, default: "STRIPE" },
    providerCustomerId: { type: String, required: true, trim: true },
    providerPaymentIntentId: { type: String, trim: true },
    providerStatus: {
      type: String,
      enum: paymentAttemptProviderStatuses,
      required: true,
      default: "NOT_CREATED",
    },
    persistenceStatus: {
      type: String,
      enum: paymentAttemptPersistenceStatuses,
      required: true,
      default: "NOT_STARTED",
    },
    compensationStatus: {
      type: String,
      enum: paymentAttemptCompensationStatuses,
      required: true,
      default: "NOT_REQUIRED",
    },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    packageProgressId: { type: Schema.Types.ObjectId, ref: "PackageProgress" },
    succeededTransactionId: { type: Schema.Types.ObjectId, ref: "BookingFinancialTransaction" },
    clientSecret: { type: String, trim: true, select: false },
    lastErrorCode: { type: String, trim: true, maxlength: 120 },
    lastErrorMessage: { type: String, trim: true, maxlength: 1000 },
    reconciliationNeededAt: { type: Date },
    lastReconciledAt: { type: Date },
    persistenceLeaseExpiresAt: { type: Date },
    persistenceLeaseToken: { type: String, trim: true },
    recoveryAttemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRecoveryAt: { type: Date },
  },
  { timestamps: true },
);

schema.index({ logicalIdempotencyKey: 1 }, { unique: true });
schema.index(
  { providerPaymentIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerPaymentIntentId: { $type: "string" } },
  },
);
schema.index({
  providerStatus: 1,
  persistenceStatus: 1,
  compensationStatus: 1,
  persistenceLeaseExpiresAt: 1,
});
schema.index({ providerStatus: 1, createdAt: 1 });
schema.index({ compensationStatus: 1, persistenceLeaseExpiresAt: 1, updatedAt: 1 });
schema.index({ nextRecoveryAt: 1, updatedAt: 1 });

export const PaymentAttemptModel = model<PaymentAttemptDocument>("PaymentAttempt", schema);
