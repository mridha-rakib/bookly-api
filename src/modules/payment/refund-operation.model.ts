import { model, Schema, type Types } from "mongoose";

export const refundOperationStatuses = [
  "CREATED",
  "PROVIDER_PENDING",
  "SUCCEEDED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;
export type RefundOperationStatus = (typeof refundOperationStatuses)[number];

export const refundIncidentCategories = [
  "REFUND_RECOVERY_FAILED",
  "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED",
  "FINAL_NOTIFICATION_RECONCILIATION_FAILED",
] as const;
export type RefundIncidentCategory = (typeof refundIncidentCategories)[number];
export type RefundRecoveryIncident = {
  episodeId: Types.ObjectId;
  state: "OPEN" | "RESOLVED";
  category: RefundIncidentCategory;
  openedAt: Date;
  lastObservedAt: Date;
  observations: number;
  lastCheckedAt: Date;
  alertedAt?: Date;
  resolvedAt?: Date;
  notificationMarkerAtObservation?: Date | null;
  reconciliationAtObservation?: Date | null;
};

export type RefundOperationDocument = {
  _id: Types.ObjectId;
  logicalIdempotencyKey: string;
  sourcePaymentAttemptId?: Types.ObjectId | undefined;
  sourceFinancialTransactionId?: Types.ObjectId | undefined;
  sourcePaymentIntentId: string;
  bookingId?: Types.ObjectId | undefined;
  packageProgressId?: Types.ObjectId | undefined;
  businessId?: Types.ObjectId | undefined;
  customerUserId?: Types.ObjectId | undefined;
  businessClientId?: Types.ObjectId | undefined;
  expectedRefundAmountCents: number;
  currency: string;
  reason: string;
  provider: "STRIPE";
  providerRefundId?: string | undefined;
  providerStatus: RefundOperationStatus;
  succeededLedgerTransactionId?: Types.ObjectId | undefined;
  /** Opt-in only for new ordinary Business cancellations. Historical refunds are not replayed. */
  finalNotificationProtocolVersion?: 1 | undefined;
  finalNotificationRecordedAt?: Date | undefined;
  recoveryIncident?: RefundRecoveryIncident | undefined;
  providerCallStartedAt?: Date | undefined;
  recoveryAttemptCount: number;
  nextRecoveryAt?: Date | undefined;
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
  reconciliationNeededAt?: Date | undefined;
  lastReconciledAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<RefundOperationDocument>(
  {
    logicalIdempotencyKey: { type: String, required: true, trim: true, maxlength: 250 },
    sourcePaymentAttemptId: { type: Schema.Types.ObjectId, ref: "PaymentAttempt" },
    sourceFinancialTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BookingFinancialTransaction",
    },
    sourcePaymentIntentId: { type: String, required: true, trim: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    packageProgressId: { type: Schema.Types.ObjectId, ref: "PackageProgress" },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient" },
    expectedRefundAmountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    reason: { type: String, required: true, trim: true, maxlength: 100 },
    provider: { type: String, enum: ["STRIPE"], required: true, default: "STRIPE" },
    providerRefundId: { type: String, trim: true },
    providerStatus: {
      type: String,
      enum: refundOperationStatuses,
      required: true,
      default: "CREATED",
    },
    succeededLedgerTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "BookingFinancialTransaction",
    },
    finalNotificationProtocolVersion: { type: Number, enum: [1] },
    finalNotificationRecordedAt: { type: Date },
    recoveryIncident: {
      type: new Schema<RefundRecoveryIncident>(
        {
          episodeId: { type: Schema.Types.ObjectId, required: true },
          state: { type: String, enum: ["OPEN", "RESOLVED"], required: true },
          category: { type: String, enum: refundIncidentCategories, required: true },
          openedAt: { type: Date, required: true },
          lastObservedAt: { type: Date, required: true },
          observations: { type: Number, required: true, min: 1 },
          lastCheckedAt: { type: Date, required: true },
          alertedAt: Date,
          resolvedAt: Date,
          notificationMarkerAtObservation: Date,
          reconciliationAtObservation: Date,
        },
        { _id: false },
      ),
    },
    providerCallStartedAt: { type: Date },
    recoveryAttemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRecoveryAt: { type: Date },
    lastErrorCode: { type: String, trim: true, maxlength: 120 },
    lastErrorMessage: { type: String, trim: true, maxlength: 1000 },
    reconciliationNeededAt: { type: Date },
    lastReconciledAt: { type: Date },
  },
  { timestamps: true },
);

// Customer-owned detail: bounded, deterministic read; no financial transition.
schema.index({ bookingId: 1, createdAt: -1, _id: -1 });
schema.index({ logicalIdempotencyKey: 1 }, { unique: true });
schema.index(
  { providerRefundId: 1 },
  { unique: true, partialFilterExpression: { providerRefundId: { $type: "string" } } },
);
schema.index({ sourcePaymentIntentId: 1, providerStatus: 1 });
schema.index({ providerStatus: 1, reconciliationNeededAt: 1, updatedAt: 1 });
schema.index({ providerStatus: 1, providerCallStartedAt: 1, updatedAt: 1 });
schema.index({ nextRecoveryAt: 1, updatedAt: 1 });
schema.index({
  finalNotificationProtocolVersion: 1,
  reason: 1,
  providerStatus: 1,
  finalNotificationRecordedAt: 1,
  updatedAt: 1,
});
// P5-F1: bounded/fair operational sweep; no change to the financial recovery indexes.
schema.index({ "recoveryIncident.state": 1, "recoveryIncident.lastCheckedAt": 1, _id: 1 });

export const RefundOperationModel = model<RefundOperationDocument>("RefundOperation", schema);
