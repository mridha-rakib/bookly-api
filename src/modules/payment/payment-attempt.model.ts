import { type ClientSession, model, Schema, Types } from "mongoose";
import { verifyPackageBatchActivation } from "../booking/package-batch-authority.js";
import {
  assertPaymentBatchBinding,
  type PaymentBatchBinding,
  paymentBatchBindingSchema,
} from "./payment-batch-binding.js";
import {
  assertLifecyclePaymentBinding,
  type LifecyclePaymentBinding,
} from "./payment-lifecycle-binding.js";

/**
 * Provider (Stripe PaymentIntent) lifecycle as last observed. Only SUCCEEDED and CANCELED are
 * provider-terminal. FAILED mirrors Stripe `requires_payment_method` (decline / failed 3DS): the
 * PaymentIntent can still be re-confirmed by anyone holding its client_secret, so FAILED is
 * never a seal — an authoritative later SUCCEEDED or CANCELED supersedes it (P1.1).
 */
export const paymentAttemptProviderStatuses = [
  "NOT_CREATED",
  "CREATED",
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "UNKNOWN",
] as const;
export type PaymentAttemptProviderStatus = (typeof paymentAttemptProviderStatuses)[number];

/**
 * P1.1.1 — `lastErrorCode` of an attempt proven to have NO provider PaymentIntent (strongly
 * consistent customer-scoped list, never search alone). Such an attempt is FAILED with no
 * `providerPaymentIntentId`, a combination no other path writes; it is closed for provider
 * creation, so its logical operation can never dispatch a PaymentIntent again.
 */
export const PROVIDER_NOT_CREATED = "PROVIDER_NOT_CREATED";

export const isProviderCreationClosed = (
  attempt: Pick<
    PaymentAttemptDocument,
    "providerStatus" | "providerPaymentIntentId" | "lastErrorCode"
  >,
): boolean =>
  attempt.providerStatus === "FAILED" &&
  !attempt.providerPaymentIntentId &&
  attempt.lastErrorCode === PROVIDER_NOT_CREATED;

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
  packageLifecycleBinding?: LifecyclePaymentBinding | undefined;
  packageBatchBinding?: PaymentBatchBinding | undefined;
  _id: Types.ObjectId;
  logicalIdempotencyKey: string;
  customerUserId: Types.ObjectId;
  businessId?: Types.ObjectId | undefined;
  purpose: string;
  productKind?: "NORMAL_BOOKING" | "PACKAGE_PURCHASE" | undefined;
  /** P1 — immutable Financial Contract correlation (V2, or V3 for P2 normal bookings; absent on
   * pre-P1 / non-contract attempts). A resume that would switch FIRST <-> RETURNING fails closed. */
  financialContractVersion?: 2 | 3 | undefined;
  relationshipClassification?: "FIRST" | "RETURNING" | undefined;
  businessClientId?: Types.ObjectId | undefined;
  currency: string;
  expectedAmountCents: number;
  provider: "STRIPE";
  providerCustomerId: string;
  providerPaymentIntentId?: string | undefined;
  providerStatus: PaymentAttemptProviderStatus;
  /** P1.1.1 — when Bookly first recorded provider success (set once, on the first transition
   * into SUCCEEDED). The orphan-compensation grace runs from here, not from attempt creation.
   * Absent on pre-P1.1.1 rows, which fall back to `createdAt`. */
  providerSucceededAt?: Date | undefined;
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
    packageLifecycleBinding: { type: Schema.Types.Mixed },
    packageBatchBinding: { type: Schema.Types.Mixed },
    logicalIdempotencyKey: { type: String, required: true, trim: true, maxlength: 250 },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    purpose: { type: String, required: true, trim: true, maxlength: 80 },
    productKind: { type: String, enum: ["NORMAL_BOOKING", "PACKAGE_PURCHASE"] },
    financialContractVersion: { type: Number, enum: [2, 3] },
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
    providerSucceededAt: { type: Date },
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

// Customer-owned detail: bounded, deterministic read; no financial transition.
schema.index({ bookingId: 1, createdAt: -1, _id: -1 });
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
// P4A-2: Customer-owned ordinary history, stable keyset pages; additive rollout required.
schema.index({ customerUserId: 1, productKind: 1, purpose: 1, createdAt: -1, _id: -1 });

const batchPaymentTransitions = new WeakSet<object>();
const batchIdentityRoots = [
  "logicalIdempotencyKey",
  "customerUserId",
  "businessId",
  "businessClientId",
  "bookingId",
  "packageProgressId",
  "purpose",
  "productKind",
  "financialContractVersion",
  "relationshipClassification",
  "currency",
  "expectedAmountCents",
  "providerCustomerId",
];
// Batch association is set only at validated creation; ordinary status writes cannot repoint it.
schema.pre("validate", function () {
  if (this.packageLifecycleBinding) assertLifecyclePaymentBinding(this);
  if (this.packageBatchBinding) {
    paymentBatchBindingSchema.parse(this.packageBatchBinding);
    assertPaymentBatchBinding(this);
  }
});
schema.pre("save", async function () {
  if (!this.isNew && this.isModified("packageLifecycleBinding"))
    throw Error("Lifecycle payment binding is immutable");
  if (!this.isNew && !this.packageLifecycleBinding)
    this.$where = { ...this.$where, packageLifecycleBinding: { $exists: false } };
  if (this.packageLifecycleBinding) {
    await verifyPackageBatchActivation();
    assertLifecyclePaymentBinding(this);
    if (
      !this.isNew &&
      (this.isModified("packageLifecycleBinding") ||
        batchIdentityRoots.some((key) => this.isModified(key)))
    )
      throw Error("Lifecycle payment identity is immutable");
  }
  if (this.isNew && this.packageBatchBinding) await verifyPackageBatchActivation();
  if (
    !this.isNew &&
    (this.isModified("packageBatchBinding") ||
      (this.packageBatchBinding && batchIdentityRoots.some((key) => this.isModified(key))))
  )
    throw new Error("PaymentAttempt batch binding is immutable");
  if (this.packageBatchBinding) assertPaymentBatchBinding(this);
});
schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function () {
  if (batchPaymentTransitions.has(this)) {
    batchPaymentTransitions.delete(this);
    return;
  }
  const update = this.getUpdate();
  const completesLifecycle = (value: object): boolean =>
    Object.entries(value).some(
      ([key, item]) =>
        key === "succeededTransactionId" ||
        (key === "persistenceStatus" && item === "COMPLETED") ||
        (key.startsWith("$") && !!item && typeof item === "object" && completesLifecycle(item)),
    );
  if (update && !Array.isArray(update) && completesLifecycle(update))
    this.and([{ packageLifecycleBinding: { $exists: false } }]);
  const touches = (value: object): boolean =>
    Object.entries(value).some(
      ([key, item]) =>
        key === "packageLifecycleBinding" ||
        key.startsWith("packageLifecycleBinding.") ||
        item === "packageLifecycleBinding" ||
        (typeof item === "string" && item.startsWith("packageLifecycleBinding.")) ||
        key === "packageBatchBinding" ||
        key.startsWith("packageBatchBinding.") ||
        (key.startsWith("$") && item && typeof item === "object" && touches(item)) ||
        (typeof item === "string" &&
          (item === "packageBatchBinding" || item.startsWith("packageBatchBinding."))),
    );
  if (Array.isArray(update) || (update && touches(update)))
    throw new Error("PaymentAttempt batch binding is immutable");
  const changesIdentity = (value: object): boolean =>
    Object.entries(value).some(
      ([key, item]) =>
        batchIdentityRoots.some(
          (root) =>
            key === root ||
            key.startsWith(`${root}.`) ||
            item === root ||
            (typeof item === "string" && item.startsWith(`${root}.`)),
        ) ||
        (key.startsWith("$") && item && typeof item === "object" && changesIdentity(item)),
    );
  if (update && changesIdentity(update))
    this.and([
      { packageBatchBinding: { $exists: false }, packageLifecycleBinding: { $exists: false } },
    ]);
});
schema.pre(["replaceOne", "findOneAndReplace"], function () {
  this.and([
    { packageBatchBinding: { $exists: false }, packageLifecycleBinding: { $exists: false } },
  ]);
  const value = this.getUpdate();
  if (value && ("packageBatchBinding" in value || "packageLifecycleBinding" in value))
    throw new Error("Use validated batch attempt creation");
});
schema.pre("bulkWrite", () => {
  throw new Error("Use single PaymentAttempt operations");
});
schema.pre("insertMany", () => {
  throw new Error("Use validated PaymentAttempt creation");
});
schema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  this.and([
    { packageBatchBinding: { $exists: false }, packageLifecycleBinding: { $exists: false } },
  ]);
});
schema.pre("deleteOne", { document: true, query: false }, async function () {
  if (
    this.packageBatchBinding ||
    this.packageLifecycleBinding ||
    (await PaymentAttemptModel.exists({
      _id: this._id,
      packageLifecycleBinding: { $exists: true },
    }))
  )
    throw new Error("Bound payment evidence is immutable");
});

export const PaymentAttemptModel = model<PaymentAttemptDocument>("PaymentAttempt", schema);

/** Fixed-shape batch-only completion. It cannot repoint immutable roots or complete outside
 * the same transaction as the real origin ledger. Shipped activation still rejects first. */
export async function completeBoundPaymentAttempt(
  id: Types.ObjectId | string,
  token: string,
  ledgerId: Types.ObjectId | string,
  session: ClientSession,
) {
  await verifyPackageBatchActivation();
  if (!session.inTransaction()) throw new Error("Batch payment requires active parent transaction");
  const row = await PaymentAttemptModel.findById(id).session(session).orFail();
  const originalBinding = row.packageBatchBinding;
  if (!originalBinding) throw new Error("Batch binding missing");
  const binding = assertPaymentBatchBinding(row);
  const { assertFreshPackageBatchMaterialization } = await import(
    "../booking/booking-creation-claim.model.js"
  );
  assertFreshPackageBatchMaterialization(session, binding.claimId);
  const { inspectBatchPaymentAuthority } = await import(
    "../booking/package-batch-payment-recovery.js"
  );
  if (!(await inspectBatchPaymentAuthority(row, session)))
    throw new Error("Canonical batch payment authority missing");
  if (!row.providerPaymentIntentId || row.currency !== "EUR")
    throw new Error("Batch provider result missing");
  const { BookingFinancialTransactionModel } = await import(
    "../booking-financial-transaction/booking-financial-transaction.model.js"
  );
  const ledger = await BookingFinancialTransactionModel.findOne({
    _id: new Types.ObjectId(ledgerId),
    bookingId: new Types.ObjectId(binding.originBookingId),
    businessId: new Types.ObjectId(binding.businessId),
    businessClientId: new Types.ObjectId(binding.businessClientId),
    customerUserId: new Types.ObjectId(binding.customerUserId),
    status: "SUCCEEDED",
    direction: "DEBIT",
    amountCents: row.expectedAmountCents,
    currency: "EUR",
    providerReference: row.providerPaymentIntentId,
    idempotencyKey: `${row.logicalIdempotencyKey}:deposit`,
  }).session(session);
  if (!ledger || !["PLATFORM_FEE", "DEPOSIT"].includes(ledger.type))
    throw new Error("Batch origin ledger mismatch");
  const query = PaymentAttemptModel.updateOne(
    {
      _id: row._id,
      packageBatchBinding: originalBinding,
      providerStatus: "SUCCEEDED",
      persistenceStatus: "PERSISTING",
      persistenceLeaseToken: token,
      compensationStatus: "NOT_REQUIRED",
    },
    {
      $set: { persistenceStatus: "COMPLETED", succeededTransactionId: ledger._id },
      $unset: {
        persistenceLeaseToken: 1,
        persistenceLeaseExpiresAt: 1,
        reconciliationNeededAt: 1,
        lastErrorCode: 1,
        lastErrorMessage: 1,
      },
    },
    { session },
  );
  batchPaymentTransitions.add(query);
  return (await query).modifiedCount === 1;
}

/** Same-parent lifecycle completion; never accepts origin-only proof. */
export async function completeLifecyclePaymentAttempt(
  id: Types.ObjectId | string,
  token: string,
  session: ClientSession,
) {
  await verifyPackageBatchActivation();
  if (!session.inTransaction()) throw Error("Lifecycle payment requires active parent");
  const attempt = await PaymentAttemptModel.findById(id).session(session).orFail();
  const { inspectLifecyclePaymentAuthority } = await import(
    "../booking/package-lifecycle-payment-recovery.js"
  );
  const authority = await inspectLifecyclePaymentAuthority(attempt, session);
  if (authority?.kind !== "COMPLETE") throw Error("Complete lifecycle proof required");
  const money = authority.result.money;
  if (!money || !attempt.packageLifecycleBinding) throw Error("Lifecycle money evidence required");
  const query = PaymentAttemptModel.updateOne(
    {
      _id: attempt._id,
      packageLifecycleBinding: attempt.packageLifecycleBinding,
      providerStatus: "SUCCEEDED",
      persistenceStatus: "PERSISTING",
      persistenceLeaseToken: token,
      compensationStatus: "NOT_REQUIRED",
    },
    {
      $set: { persistenceStatus: "COMPLETED", succeededTransactionId: money.ledgerId },
      $unset: { persistenceLeaseToken: 1, persistenceLeaseExpiresAt: 1, reconciliationNeededAt: 1 },
    },
    { session },
  );
  batchPaymentTransitions.add(query);
  return (await query).modifiedCount === 1;
}
