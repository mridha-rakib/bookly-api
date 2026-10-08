import { logger } from "../../config/logger.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { StripeWebhookService } from "../stripe-webhook/stripe-webhook.service.js";
import type { PaymentService } from "./payment.service.js";
import type { PaymentAttemptRepository } from "./payment-attempt.repository.js";
import type { RefundOperationDocument } from "./refund-operation.model.js";
import type { RefundOperationRepository } from "./refund-operation.repository.js";

const ORPHAN_GRACE_MS = 5 * 60_000;

export class MoneyRecoveryService {
  public constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentAttemptRepository: PaymentAttemptRepository,
    private readonly refundOperationRepository: RefundOperationRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly webhookService: StripeWebhookService,
    private readonly packageProgressRepository?: PackageProgressRepository,
  ) {}

  public async runOnce(limit = 50): Promise<{
    paymentAttempts: number;
    refundOperations: number;
    webhooksProcessed: number;
    webhooksFailed: number;
    errors: number;
  }> {
    let paymentAttempts = 0;
    let refundOperations = 0;
    let errors = 0;

    const attempts = await this.paymentAttemptRepository.listRecoverable(limit);
    for (const candidate of attempts) {
      try {
        const { attempt, snapshot } = await this.paymentService.reconcilePaymentAttempt(
          candidate._id,
        );
        paymentAttempts += 1;
        if (snapshot?.status !== "succeeded" || !attempt.bookingId) continue;

        const booking = attempt.businessId
          ? await this.bookingRepository.findById(attempt.businessId, attempt.bookingId)
          : await this.bookingRepository.findByIdOnly(attempt.bookingId);
        if (booking) {
          const entries = await this.financialTransactionService.listForBooking(booking._id);
          const source = entries.find(
            (entry) => entry.providerReference === snapshot.paymentIntentId,
          );
          if (!source) continue;
          const packageProgressId = booking.serviceLines
            .map((line) => line.pricingInput.packageProgressId)
            .find(Boolean);
          const persistenceToken = await this.paymentService.claimPaymentPersistence(
            String(attempt._id),
          );
          if (!persistenceToken) continue;
          await this.paymentService.markPaymentCompleted(
            String(attempt._id),
            {
              bookingId: booking._id,
              ...(packageProgressId ? { packageProgressId } : {}),
              succeededTransactionId: source._id,
            },
            persistenceToken,
          );
          continue;
        }

        if (Date.now() - attempt.createdAt.getTime() < ORPHAN_GRACE_MS) continue;
        if (!(await this.paymentService.claimPaymentCompensation(attempt._id))) continue;
        await this.paymentService.refund({
          paymentIntentId: snapshot.paymentIntentId,
          amountCents: attempt.expectedAmountCents,
          currency: attempt.currency,
          idempotencyKey: `refund:${snapshot.paymentIntentId}:compensation`,
          reason: "requested_by_customer",
          domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
          sourcePaymentAttemptId: attempt._id,
          bookingId: attempt.bookingId,
          businessId: attempt.businessId,
          customerUserId: attempt.customerUserId,
          businessClientId: snapshot.metadata["businessClientId"],
        });
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : "Unknown recovery error";
        await this.paymentAttemptRepository
          .scheduleRecoveryRetry(candidate._id, message)
          .catch((scheduleError: unknown) =>
            logger.error(
              { err: scheduleError, recordType: "PaymentAttempt", recordId: String(candidate._id) },
              "Could not schedule money recovery retry",
            ),
          );
        logger.warn(
          {
            recordType: "PaymentAttempt",
            recordId: String(candidate._id),
            providerId: candidate.providerPaymentIntentId,
            state: candidate.providerStatus,
            errorCategory: error instanceof Error ? error.name : "UNKNOWN",
          },
          "Money recovery item failed",
        );
      }
    }

    const refunds = await this.refundOperationRepository.listRecoverable(limit);
    for (const operation of refunds) {
      try {
        const result = await this.paymentService.refund({
          paymentIntentId: operation.sourcePaymentIntentId,
          amountCents: operation.expectedRefundAmountCents,
          currency: operation.currency,
          idempotencyKey: operation.logicalIdempotencyKey,
          reason: "requested_by_customer",
          domainReason: operation.reason,
          sourcePaymentAttemptId: operation.sourcePaymentAttemptId,
          sourceFinancialTransactionId: operation.sourceFinancialTransactionId,
          bookingId: operation.bookingId,
          packageProgressId: operation.packageProgressId,
          businessId: operation.businessId,
          customerUserId: operation.customerUserId,
          businessClientId: operation.businessClientId,
        });
        refundOperations += 1;
        if (result.status === "succeeded") {
          await this.ensureRefundLedger(operation, result.refundId);
          await this.reconcilePackageVoid(operation, "SUCCEEDED", result.refundId);
        } else if (result.status === "failed") {
          await this.reconcilePackageVoid(operation, "FAILED", result.refundId);
        }
        if (
          operation.bookingId &&
          operation.reason === "BUSINESS_CANCELLATION" &&
          result.status !== "pending"
        ) {
          await this.bookingRepository.updateCancellationSettlement(
            operation.bookingId,
            result.status === "succeeded" ? "SUCCEEDED" : "FAILED",
            result.refundId,
          );
        }
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : "Unknown recovery error";
        await this.refundOperationRepository
          .scheduleRecoveryRetry(operation._id, message)
          .catch((scheduleError: unknown) =>
            logger.error(
              {
                err: scheduleError,
                recordType: "RefundOperation",
                recordId: String(operation._id),
              },
              "Could not schedule money recovery retry",
            ),
          );
        logger.warn(
          {
            recordType: "RefundOperation",
            recordId: String(operation._id),
            providerId: operation.providerRefundId,
            state: operation.providerStatus,
            errorCategory: error instanceof Error ? error.name : "UNKNOWN",
          },
          "Money recovery item failed",
        );
      }
    }

    const webhookCounts = await this.webhookService.recoverDue(limit);
    return {
      paymentAttempts,
      refundOperations,
      webhooksProcessed: webhookCounts.processed,
      webhooksFailed: webhookCounts.failed,
      errors,
    };
  }

  private async ensureRefundLedger(
    operation: RefundOperationDocument,
    providerRefundId: string,
  ): Promise<void> {
    if (
      operation.succeededLedgerTransactionId ||
      !operation.bookingId ||
      !operation.businessId ||
      !operation.businessClientId
    ) {
      return;
    }
    const idempotencyKey = `refund-operation:${String(operation._id)}:ledger`;
    let sourceType = "COMPENSATION";
    if (operation.sourceFinancialTransactionId) {
      const entries = await this.financialTransactionService.listForBooking(operation.bookingId);
      sourceType =
        entries.find(
          (entry) => String(entry._id) === String(operation.sourceFinancialTransactionId),
        )?.type ?? "UNKNOWN";
    }
    try {
      const ledger = await this.financialTransactionService.record({
        businessId: operation.businessId,
        bookingId: operation.bookingId,
        businessClientId: operation.businessClientId,
        ...(operation.customerUserId ? { customerUserId: operation.customerUserId } : {}),
        type: "REFUND",
        direction: "CREDIT",
        amountCents: operation.expectedRefundAmountCents,
        currency: operation.currency as "EUR",
        status: "SUCCEEDED",
        providerReference: providerRefundId,
        idempotencyKey,
        metadata: {
          sourceType,
          ...(operation.sourceFinancialTransactionId
            ? { sourceTransactionId: String(operation.sourceFinancialTransactionId) }
            : {}),
        },
      });
      await this.paymentService.markRefundLedgerSucceeded(String(operation._id), ledger._id);
    } catch {
      const existing = await this.financialTransactionService.findByIdempotencyKey(idempotencyKey);
      if (!existing) throw new Error("Refund ledger reconciliation failed");
      const settled =
        existing.status === "PENDING"
          ? await this.financialTransactionService.settleStatus(existing._id, "SUCCEEDED")
          : existing;
      await this.paymentService.markRefundLedgerSucceeded(
        String(operation._id),
        (settled ?? existing)._id,
      );
    }
  }

  private async reconcilePackageVoid(
    operation: RefundOperationDocument,
    status: "SUCCEEDED" | "FAILED",
    providerRefundId: string,
  ): Promise<void> {
    if (!operation.packageProgressId || !this.packageProgressRepository) return;
    const progress = await this.packageProgressRepository.findByIdInternal(
      operation.packageProgressId,
    );
    if (!progress) return;
    if (!progress.voidedAt) {
      await this.packageProgressRepository.voidPackage(progress._id, {
        status,
        amountCents: operation.expectedRefundAmountCents,
        refundOperationId: operation._id,
        providerRefundId,
      });
      return;
    }
    await this.packageProgressRepository.settleVoidRefund(operation._id, status, providerRefundId);
  }
}
