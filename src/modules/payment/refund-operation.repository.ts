import { Types } from "mongoose";

import { PaymentError } from "./payment.errors.js";
import {
  type RefundOperationDocument,
  RefundOperationModel,
  type RefundOperationStatus,
} from "./refund-operation.model.js";

export type CreateRefundOperationInput = {
  logicalIdempotencyKey: string;
  sourcePaymentAttemptId?: Types.ObjectId | string | undefined;
  sourceFinancialTransactionId?: Types.ObjectId | string | undefined;
  sourcePaymentIntentId: string;
  bookingId?: Types.ObjectId | string | undefined;
  packageProgressId?: Types.ObjectId | string | undefined;
  businessId?: Types.ObjectId | string | undefined;
  customerUserId?: Types.ObjectId | string | undefined;
  businessClientId?: Types.ObjectId | string | undefined;
  expectedRefundAmountCents: number;
  currency: string;
  reason: string;
};

export class RefundOperationRepository {
  public async createOrResume(input: CreateRefundOperationInput): Promise<RefundOperationDocument> {
    return (await this.createOrResumeWithDisposition(input)).operation;
  }

  public async createOrResumeWithDisposition(
    input: CreateRefundOperationInput,
  ): Promise<{ operation: RefundOperationDocument; isNew: boolean }> {
    try {
      const operation = await new RefundOperationModel({
        ...input,
        ...(input.sourcePaymentAttemptId
          ? { sourcePaymentAttemptId: new Types.ObjectId(input.sourcePaymentAttemptId) }
          : {}),
        ...(input.sourceFinancialTransactionId
          ? { sourceFinancialTransactionId: new Types.ObjectId(input.sourceFinancialTransactionId) }
          : {}),
        ...(input.bookingId ? { bookingId: new Types.ObjectId(input.bookingId) } : {}),
        ...(input.packageProgressId
          ? { packageProgressId: new Types.ObjectId(input.packageProgressId) }
          : {}),
        ...(input.businessId ? { businessId: new Types.ObjectId(input.businessId) } : {}),
        ...(input.customerUserId
          ? { customerUserId: new Types.ObjectId(input.customerUserId) }
          : {}),
        ...(input.businessClientId
          ? { businessClientId: new Types.ObjectId(input.businessClientId) }
          : {}),
        currency: input.currency.toUpperCase(),
      }).save();
      return { operation, isNew: true };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const existing = await RefundOperationModel.findOne({
        logicalIdempotencyKey: input.logicalIdempotencyKey,
      }).orFail();
      const reasonCompatible =
        existing.reason === input.reason ||
        (existing.reason === "BUSINESS_CANCELLATION" && input.reason === "PACKAGE_VOID");
      const packageCompatible =
        String(existing.packageProgressId ?? "") === String(input.packageProgressId ?? "") ||
        (!existing.packageProgressId && Boolean(input.packageProgressId));
      if (
        existing.sourcePaymentIntentId !== input.sourcePaymentIntentId ||
        existing.expectedRefundAmountCents !== input.expectedRefundAmountCents ||
        existing.currency !== input.currency.toUpperCase() ||
        !reasonCompatible ||
        String(existing.sourcePaymentAttemptId ?? "") !==
          String(input.sourcePaymentAttemptId ?? "") ||
        String(existing.sourceFinancialTransactionId ?? "") !==
          String(input.sourceFinancialTransactionId ?? "") ||
        String(existing.bookingId ?? "") !== String(input.bookingId ?? "") ||
        !packageCompatible ||
        String(existing.businessId ?? "") !== String(input.businessId ?? "") ||
        String(existing.customerUserId ?? "") !== String(input.customerUserId ?? "") ||
        String(existing.businessClientId ?? "") !== String(input.businessClientId ?? "")
      ) {
        throw new PaymentError("PAYMENT_REFUND_IDEMPOTENCY_CONFLICT", 409);
      }
      if (!existing.packageProgressId && input.packageProgressId) {
        const enriched = await RefundOperationModel.findOneAndUpdate(
          { _id: existing._id, packageProgressId: { $exists: false } },
          { $set: { packageProgressId: new Types.ObjectId(input.packageProgressId) } },
          { returnDocument: "after", runValidators: true },
        ).exec();
        return { operation: enriched ?? existing, isNew: false };
      }
      return { operation: existing, isNew: false };
    }
  }

  public async markProviderCallStarted(id: Types.ObjectId | string): Promise<void> {
    await RefundOperationModel.updateOne(
      { _id: id, providerStatus: "CREATED", providerRefundId: { $exists: false } },
      { $set: { providerCallStartedAt: new Date(), reconciliationNeededAt: new Date() } },
    ).exec();
  }

  public async findById(id: Types.ObjectId | string): Promise<RefundOperationDocument | null> {
    return RefundOperationModel.findById(id).exec();
  }

  public async findByLogicalKey(key: string): Promise<RefundOperationDocument | null> {
    return RefundOperationModel.findOne({ logicalIdempotencyKey: key }).exec();
  }

  public async findByProviderRefundId(id: string): Promise<RefundOperationDocument | null> {
    return RefundOperationModel.findOne({ providerRefundId: id }).exec();
  }

  public async findPendingLegacyMatch(
    paymentIntentId: string,
    amountCents: number,
  ): Promise<RefundOperationDocument | null> {
    const matches = await RefundOperationModel.find({
      sourcePaymentIntentId: paymentIntentId,
      expectedRefundAmountCents: amountCents,
      providerStatus: { $in: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED"] },
    })
      .limit(2)
      .exec();
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  public async recordProviderResult(
    id: Types.ObjectId | string,
    input: { providerRefundId: string; providerStatus: RefundOperationStatus },
  ): Promise<RefundOperationDocument> {
    const allowedPrevious: Record<RefundOperationStatus, RefundOperationStatus[]> = {
      CREATED: ["CREATED"],
      PROVIDER_PENDING: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED"],
      SUCCEEDED: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED", "SUCCEEDED"],
      FAILED: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED", "FAILED"],
      RECONCILIATION_REQUIRED: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED"],
    };
    const updated = await RefundOperationModel.findOneAndUpdate(
      { _id: id, providerStatus: { $in: allowedPrevious[input.providerStatus] } },
      {
        $set: {
          providerRefundId: input.providerRefundId,
          providerStatus: input.providerStatus,
          lastReconciledAt: new Date(),
          ...(input.providerStatus === "PROVIDER_PENDING"
            ? { reconciliationNeededAt: new Date() }
            : {}),
        },
        ...(input.providerStatus === "SUCCEEDED"
          ? { $unset: { reconciliationNeededAt: 1, lastErrorCode: 1, lastErrorMessage: 1 } }
          : {}),
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
    if (updated) return updated;
    const current = await RefundOperationModel.findById(id).orFail();
    if (current.providerRefundId && current.providerRefundId !== input.providerRefundId) {
      throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
    }
    return current;
  }

  public async markReconciliationRequired(
    id: Types.ObjectId | string,
    message: string,
  ): Promise<void> {
    await RefundOperationModel.updateOne(
      {
        _id: id,
        providerStatus: { $in: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED"] },
      },
      {
        $set: {
          providerStatus: "RECONCILIATION_REQUIRED",
          reconciliationNeededAt: new Date(),
          lastErrorCode: "PROVIDER_RESPONSE_AMBIGUOUS",
          lastErrorMessage: message.slice(0, 1000),
        },
      },
    ).exec();
  }

  public async markFailed(id: Types.ObjectId | string, message: string): Promise<void> {
    await RefundOperationModel.updateOne(
      {
        _id: id,
        providerStatus: {
          $in: ["CREATED", "PROVIDER_PENDING", "RECONCILIATION_REQUIRED", "FAILED"],
        },
      },
      {
        $set: {
          providerStatus: "FAILED",
          lastErrorCode: "PROVIDER_CORRELATION_MISMATCH",
          lastErrorMessage: message.slice(0, 1000),
        },
        $unset: { reconciliationNeededAt: 1 },
      },
    ).exec();
  }

  public async markLedgerSucceeded(
    id: Types.ObjectId | string,
    ledgerTransactionId: Types.ObjectId | string,
  ): Promise<void> {
    await RefundOperationModel.updateOne(
      { _id: id, providerStatus: "SUCCEEDED" },
      { $set: { succeededLedgerTransactionId: new Types.ObjectId(ledgerTransactionId) } },
    ).exec();
  }

  public async listRecoverable(limit: number): Promise<RefundOperationDocument[]> {
    return RefundOperationModel.find({
      $and: [
        { $or: [{ nextRecoveryAt: { $lte: new Date() } }, { nextRecoveryAt: { $exists: false } }] },
        {
          $or: [
            {
              providerStatus: "CREATED",
              providerCallStartedAt: { $exists: true },
            },
            { providerStatus: { $in: ["PROVIDER_PENDING", "RECONCILIATION_REQUIRED"] } },
            { providerStatus: "SUCCEEDED", succeededLedgerTransactionId: { $exists: false } },
          ],
        },
      ],
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .exec();
  }

  public async scheduleRecoveryRetry(id: Types.ObjectId | string, message: string): Promise<void> {
    const current = await RefundOperationModel.findById(id).select("recoveryAttemptCount").lean();
    const attempt = (current?.recoveryAttemptCount ?? 0) + 1;
    const delayMs = Math.min(30_000 * 2 ** Math.min(attempt - 1, 8), 15 * 60_000);
    await RefundOperationModel.updateOne(
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

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
  }
}
