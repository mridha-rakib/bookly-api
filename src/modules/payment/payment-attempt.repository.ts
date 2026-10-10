import { randomUUID } from "node:crypto";

import { type ClientSession, Types } from "mongoose";

import { PaymentError } from "./payment.errors.js";
import {
  type PaymentAttemptDocument,
  PaymentAttemptModel,
  type PaymentAttemptProviderStatus,
} from "./payment-attempt.model.js";

export type CreatePaymentAttemptInput = {
  logicalIdempotencyKey: string;
  customerUserId: Types.ObjectId | string;
  businessId?: Types.ObjectId | string | undefined;
  bookingId?: Types.ObjectId | string | undefined;
  packageProgressId?: Types.ObjectId | string | undefined;
  purpose: string;
  productKind?: "NORMAL_BOOKING" | "PACKAGE_PURCHASE" | undefined;
  financialContractVersion?: 2 | undefined;
  relationshipClassification?: "FIRST" | "RETURNING" | undefined;
  businessClientId?: Types.ObjectId | string | undefined;
  currency: string;
  expectedAmountCents: number;
  providerCustomerId: string;
};

export class PaymentAttemptRepository {
  public async createOrResume(input: CreatePaymentAttemptInput): Promise<PaymentAttemptDocument> {
    return (await this.createOrResumeWithDisposition(input)).attempt;
  }

  public async createOrResumeWithDisposition(
    input: CreatePaymentAttemptInput,
  ): Promise<{ attempt: PaymentAttemptDocument; isNew: boolean }> {
    try {
      const attempt = await new PaymentAttemptModel({
        ...input,
        customerUserId: new Types.ObjectId(input.customerUserId),
        ...(input.businessId ? { businessId: new Types.ObjectId(input.businessId) } : {}),
        ...(input.bookingId ? { bookingId: new Types.ObjectId(input.bookingId) } : {}),
        ...(input.packageProgressId
          ? { packageProgressId: new Types.ObjectId(input.packageProgressId) }
          : {}),
        ...(input.businessClientId
          ? { businessClientId: new Types.ObjectId(input.businessClientId) }
          : {}),
        currency: input.currency.toUpperCase(),
      }).save();
      return { attempt, isNew: true };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const existing = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.logicalIdempotencyKey,
      }).orFail();
      this.assertImmutableMatch(existing, input);
      return { attempt: existing, isNew: false };
    }
  }

  public async findById(id: Types.ObjectId | string): Promise<PaymentAttemptDocument | null> {
    return PaymentAttemptModel.findById(id).exec();
  }

  public async findByLogicalKey(key: string): Promise<PaymentAttemptDocument | null> {
    return PaymentAttemptModel.findOne({ logicalIdempotencyKey: key }).exec();
  }

  public async findByProviderPaymentIntentId(id: string): Promise<PaymentAttemptDocument | null> {
    return PaymentAttemptModel.findOne({ providerPaymentIntentId: id }).exec();
  }

  public async recordProviderResult(
    id: Types.ObjectId | string,
    input: {
      providerPaymentIntentId: string;
      providerStatus: PaymentAttemptProviderStatus;
      clientSecret?: string | undefined;
      lastErrorMessage?: string | undefined;
    },
  ): Promise<PaymentAttemptDocument> {
    const allowedPrevious: Record<PaymentAttemptProviderStatus, PaymentAttemptProviderStatus[]> = {
      NOT_CREATED: ["NOT_CREATED"],
      CREATED: ["NOT_CREATED", "CREATED", "UNKNOWN"],
      REQUIRES_ACTION: ["NOT_CREATED", "CREATED", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN"],
      PROCESSING: ["NOT_CREATED", "CREATED", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN"],
      SUCCEEDED: [
        "NOT_CREATED",
        "CREATED",
        "REQUIRES_ACTION",
        "PROCESSING",
        "UNKNOWN",
        "SUCCEEDED",
      ],
      FAILED: ["NOT_CREATED", "CREATED", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN", "FAILED"],
      UNKNOWN: ["NOT_CREATED", "CREATED", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN"],
    };
    const updated = await PaymentAttemptModel.findOneAndUpdate(
      { _id: id, providerStatus: { $in: allowedPrevious[input.providerStatus] } },
      {
        $set: {
          providerPaymentIntentId: input.providerPaymentIntentId,
          providerStatus: input.providerStatus,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          ...(input.lastErrorMessage ? { lastErrorMessage: input.lastErrorMessage } : {}),
          ...(input.providerStatus === "UNKNOWN" ? { reconciliationNeededAt: new Date() } : {}),
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
    if (updated) return updated;
    const current = await PaymentAttemptModel.findById(id).orFail();
    if (
      current.providerPaymentIntentId &&
      current.providerPaymentIntentId !== input.providerPaymentIntentId
    ) {
      throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
    }
    return current;
  }

  public async markProviderUnknown(id: Types.ObjectId | string, message: string): Promise<void> {
    await PaymentAttemptModel.updateOne(
      {
        _id: id,
        providerStatus: {
          $in: ["NOT_CREATED", "CREATED", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN"],
        },
      },
      {
        $set: {
          providerStatus: "UNKNOWN",
          reconciliationNeededAt: new Date(),
          lastErrorCode: "PROVIDER_RESPONSE_AMBIGUOUS",
          lastErrorMessage: message.slice(0, 1000),
        },
      },
    ).exec();
  }

  public async claimPersistence(id: Types.ObjectId | string): Promise<string | null> {
    const now = new Date();
    const token = randomUUID();
    const claimed = await PaymentAttemptModel.findOneAndUpdate(
      {
        _id: id,
        providerStatus: "SUCCEEDED",
        compensationStatus: "NOT_REQUIRED",
        $or: [
          { persistenceStatus: { $in: ["NOT_STARTED", "FAILED"] } },
          { persistenceStatus: "PERSISTING", persistenceLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          persistenceStatus: "PERSISTING",
          persistenceLeaseExpiresAt: new Date(now.getTime() + 120_000),
          persistenceLeaseToken: token,
        },
      },
      { returnDocument: "after" },
    ).exec();
    return claimed ? token : null;
  }

  public async markCompleted(
    id: Types.ObjectId | string,
    input: {
      bookingId: Types.ObjectId | string;
      packageProgressId?: Types.ObjectId | string | undefined;
      succeededTransactionId?: Types.ObjectId | string | undefined;
    },
    persistenceLeaseToken: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const result = await PaymentAttemptModel.updateOne(
      {
        _id: id,
        providerStatus: "SUCCEEDED",
        persistenceStatus: "PERSISTING",
        persistenceLeaseToken,
        compensationStatus: "NOT_REQUIRED",
      },
      {
        $set: {
          persistenceStatus: "COMPLETED",
          compensationStatus: "NOT_REQUIRED",
          bookingId: new Types.ObjectId(input.bookingId),
          ...(input.packageProgressId
            ? { packageProgressId: new Types.ObjectId(input.packageProgressId) }
            : {}),
          ...(input.succeededTransactionId
            ? { succeededTransactionId: new Types.ObjectId(input.succeededTransactionId) }
            : {}),
        },
        $unset: {
          reconciliationNeededAt: 1,
          persistenceLeaseExpiresAt: 1,
          persistenceLeaseToken: 1,
          lastErrorCode: 1,
          lastErrorMessage: 1,
        },
      },
      session ? { session } : {},
    ).exec();
    return result.modifiedCount === 1;
  }

  public async markCompensationRequired(
    id: Types.ObjectId | string,
    message: string,
    persistenceLeaseToken: string,
  ): Promise<boolean> {
    const result = await PaymentAttemptModel.updateOne(
      {
        _id: id,
        providerStatus: "SUCCEEDED",
        persistenceStatus: "PERSISTING",
        persistenceLeaseToken,
        compensationStatus: "NOT_REQUIRED",
      },
      {
        $set: {
          persistenceStatus: "FAILED",
          compensationStatus: "REQUIRED",
          reconciliationNeededAt: new Date(),
          lastErrorCode: "BOOKLY_PERSISTENCE_FAILED",
          lastErrorMessage: message.slice(0, 1000),
        },
        $unset: { persistenceLeaseExpiresAt: 1, persistenceLeaseToken: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  public async claimCompensation(id: Types.ObjectId | string): Promise<string | null> {
    const now = new Date();
    const token = randomUUID();
    const claimed = await PaymentAttemptModel.findOneAndUpdate(
      {
        _id: id,
        providerStatus: "SUCCEEDED",
        $or: [
          {
            compensationStatus: "NOT_REQUIRED",
            $or: [
              { persistenceStatus: { $in: ["NOT_STARTED", "FAILED"] } },
              { persistenceStatus: "PERSISTING", persistenceLeaseExpiresAt: { $lte: now } },
            ],
          },
          {
            compensationStatus: { $in: ["REQUIRED", "RECONCILIATION_REQUIRED"] },
            $or: [
              { persistenceLeaseExpiresAt: { $exists: false } },
              { persistenceLeaseExpiresAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          persistenceStatus: "FAILED",
          compensationStatus: "REQUIRED",
          persistenceLeaseToken: token,
          persistenceLeaseExpiresAt: new Date(now.getTime() + 120_000),
          reconciliationNeededAt: now,
        },
      },
      { returnDocument: "after" },
    ).exec();
    return claimed ? token : null;
  }

  public async markRefundPending(id: Types.ObjectId | string): Promise<void> {
    await PaymentAttemptModel.updateOne(
      {
        _id: id,
        compensationStatus: { $in: ["REQUIRED", "REFUND_PENDING", "RECONCILIATION_REQUIRED"] },
      },
      {
        $set: { compensationStatus: "REFUND_PENDING", reconciliationNeededAt: new Date() },
        $unset: { persistenceLeaseExpiresAt: 1, persistenceLeaseToken: 1 },
      },
    ).exec();
  }

  public async markRefunded(id: Types.ObjectId | string): Promise<void> {
    await PaymentAttemptModel.updateOne(
      {
        _id: id,
        compensationStatus: {
          $in: ["REQUIRED", "REFUND_PENDING", "RECONCILIATION_REQUIRED", "REFUNDED"],
        },
      },
      {
        $set: { compensationStatus: "REFUNDED" },
        $unset: {
          reconciliationNeededAt: 1,
          persistenceLeaseExpiresAt: 1,
          persistenceLeaseToken: 1,
        },
      },
    ).exec();
  }

  public async markCompensationFailed(id: Types.ObjectId | string): Promise<void> {
    await PaymentAttemptModel.updateOne(
      { _id: id, compensationStatus: { $ne: "REFUNDED" } },
      {
        $set: {
          compensationStatus: "FAILED",
          lastErrorCode: "REFUND_PROVIDER_FAILED",
          lastErrorMessage: "The provider reported a terminal refund failure",
        },
        $unset: {
          reconciliationNeededAt: 1,
          persistenceLeaseExpiresAt: 1,
          persistenceLeaseToken: 1,
        },
      },
    ).exec();
  }

  public async listRecoverable(limit: number): Promise<PaymentAttemptDocument[]> {
    const staleUnsentCutoff = new Date(Date.now() - 60_000);
    return PaymentAttemptModel.find({
      $and: [
        { $or: [{ nextRecoveryAt: { $lte: new Date() } }, { nextRecoveryAt: { $exists: false } }] },
        {
          $or: [
            { providerStatus: "NOT_CREATED", createdAt: { $lte: staleUnsentCutoff } },
            { providerStatus: "UNKNOWN" },
            { providerStatus: "PROCESSING" },
            {
              providerStatus: "SUCCEEDED",
              persistenceStatus: { $in: ["NOT_STARTED", "PERSISTING", "FAILED"] },
            },
            {
              compensationStatus: {
                $in: ["REQUIRED", "REFUND_PENDING", "RECONCILIATION_REQUIRED"],
              },
            },
          ],
        },
      ],
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .exec();
  }

  public async scheduleRecoveryRetry(id: Types.ObjectId | string, message: string): Promise<void> {
    const current = await PaymentAttemptModel.findById(id).select("recoveryAttemptCount").lean();
    const attempt = (current?.recoveryAttemptCount ?? 0) + 1;
    const delayMs = Math.min(30_000 * 2 ** Math.min(attempt - 1, 8), 15 * 60_000);
    await PaymentAttemptModel.updateOne(
      { _id: id },
      {
        $set: {
          recoveryAttemptCount: attempt,
          nextRecoveryAt: new Date(Date.now() + delayMs),
          lastErrorMessage: message.slice(0, 1000),
        },
      },
    ).exec();
  }

  private assertImmutableMatch(
    existing: PaymentAttemptDocument,
    input: CreatePaymentAttemptInput,
  ): void {
    const mismatch =
      String(existing.customerUserId) !== String(input.customerUserId) ||
      String(existing.businessId ?? "") !== String(input.businessId ?? "") ||
      existing.purpose !== input.purpose ||
      String(existing.productKind ?? "") !== String(input.productKind ?? "") ||
      String(existing.financialContractVersion ?? "") !==
        String(input.financialContractVersion ?? "") ||
      String(existing.relationshipClassification ?? "") !==
        String(input.relationshipClassification ?? "") ||
      String(existing.businessClientId ?? "") !== String(input.businessClientId ?? "") ||
      existing.currency !== input.currency.toUpperCase() ||
      existing.expectedAmountCents !== input.expectedAmountCents ||
      existing.providerCustomerId !== input.providerCustomerId ||
      String(existing.bookingId ?? "") !== String(input.bookingId ?? "") ||
      String(existing.packageProgressId ?? "") !== String(input.packageProgressId ?? "");
    if (mismatch) throw new PaymentError("PAYMENT_IDEMPOTENCY_CONFLICT", 409);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
  }
}
