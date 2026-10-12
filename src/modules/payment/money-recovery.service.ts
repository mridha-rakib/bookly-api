import { logger } from "../../config/logger.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { StripeWebhookService } from "../stripe-webhook/stripe-webhook.service.js";
import type { PaymentService } from "./payment.service.js";
import type {
  PaymentAttemptDocument,
  PaymentAttemptProviderStatus,
} from "./payment-attempt.model.js";
import type { PaymentAttemptRepository } from "./payment-attempt.repository.js";
import { ensureRefundAccounting } from "./refund-accounting.js";
import type { RefundOperationDocument } from "./refund-operation.model.js";
import type { RefundOperationRepository } from "./refund-operation.repository.js";

const ORPHAN_GRACE_MS = 5 * 60_000;
/** P1.1 — a bound FIRST charge still awaiting 3DS this long is re-read from Stripe. Reading is
 * always safe; only the provider's answer (never this age) can release the claim. */
export const STALE_FIRST_REQUIRES_ACTION_MS = 30 * 60_000;
/** P1.1.1 — a bound FIRST attempt with no recorded PaymentIntent this long after creation is
 * far beyond any in-flight provider request (SDK timeout x retries), so a strongly consistent
 * provider lookup can decide whether its PaymentIntent exists. */
export const STALE_FIRST_UNSENT_MS = 15 * 60_000;
/** Outcomes a FIRST-only pass leaves reserved and simply re-checks later. */
const UNRESOLVED_PROVIDER_STATUSES: ReadonlySet<PaymentAttemptProviderStatus> = new Set([
  "NOT_CREATED",
  "UNKNOWN",
  "REQUIRES_ACTION",
]);

export class MoneyRecoveryService {
  public constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentAttemptRepository: PaymentAttemptRepository,
    private readonly refundOperationRepository: RefundOperationRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly webhookService: StripeWebhookService,
    private readonly packageProgressRepository?: PackageProgressRepository,
    // P1 — converges unresolved FIRST customer↔business relationship claims from the durable
    // PaymentAttempt/RefundOperation/Booking state the passes above just reconciled. Optional
    // trailing dep (same construction-compatibility convention as packageProgressRepository).
    private readonly relationshipService?: Pick<
      FinancialRelationshipService,
      "reconcilePending" | "reconcileForPaymentAttempt" | "ownsPendingFirstClaim"
    >,
  ) {}

  public async runOnce(limit = 50): Promise<{
    paymentAttempts: number;
    staleFirstUnsent: number;
    staleFirstRequiresAction: number;
    refundOperations: number;
    relationshipsScanned: number;
    webhooksProcessed: number;
    webhooksFailed: number;
    errors: number;
  }> {
    let paymentAttempts = 0;
    let refundOperations = 0;
    let errors = 0;

    // The FIRST-only passes run BEFORE the generic pass so an attempt Stripe reports as
    // succeeded is picked up by the existing P0 persistence/compensation handling below.
    const staleUnsent = await this.resolveStaleFirstUnsent(limit);
    const staleFirst = await this.reconcileStaleFirstRequiresAction(limit);
    errors += staleUnsent.errors + staleFirst.errors;

    const attempts = await this.paymentAttemptRepository.listRecoverable(limit);
    for (const candidate of attempts) {
      try {
        const { attempt, snapshot } = await this.paymentService.reconcilePaymentAttempt(
          candidate._id,
        );
        paymentAttempts += 1;
        if (!snapshot) {
          // P1.1.1 — queue fairness only: NOT_FOUND changes no provider meaning, but the row
          // must rotate out instead of staying oldest forever and starving later work.
          await this.paymentAttemptRepository.scheduleRecoveryRetry(
            attempt._id,
            "No provider PaymentIntent found for this PaymentAttempt yet",
          );
          continue;
        }
        if (snapshot.status !== "succeeded" || !attempt.bookingId) continue;

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

        // P1.1.1 — the grace runs from when success was first recorded (a slow 3DS must not spend
        // it before the money even moved); pre-P1.1.1 rows fall back to attempt creation.
        const graceFrom = attempt.providerSucceededAt ?? attempt.createdAt;
        if (Date.now() - graceFrom.getTime() < ORPHAN_GRACE_MS) continue;
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
          ["BUSINESS_CANCELLATION", "BUSINESS_PACKAGE_TERMINATION", "PACKAGE_VOID"].includes(
            operation.reason,
          ) &&
          result.status !== "pending"
        ) {
          await this.bookingRepository.updateCancellationSettlement(
            operation.bookingId,
            result.status === "succeeded" ? "SUCCEEDED" : "FAILED",
            result.refundId,
          );
        }
        if (result.status === "succeeded")
          await this.refundOperationRepository.markDomainReconciled(operation._id);
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

    // Runs AFTER the payment/refund passes so a compensation refund confirmed in this same pass
    // can restore eligibility immediately. Never a timeout unlock — see
    // FinancialRelationshipService.reconcile for the exact durable-state rules.
    const relationshipCounts = this.relationshipService
      ? await this.relationshipService.reconcilePending(limit)
      : { scanned: 0, errors: 0 };
    errors += relationshipCounts.errors;

    const webhookCounts = await this.webhookService.recoverDue(limit);
    return {
      paymentAttempts,
      staleFirstUnsent: staleUnsent.reconciled,
      staleFirstRequiresAction: staleFirst.reconciled,
      refundOperations,
      relationshipsScanned: relationshipCounts.scanned,
      webhooksProcessed: webhookCounts.processed,
      webhooksFailed: webhookCounts.failed,
      errors,
    };
  }

  /**
   * P1.1 — dedicated FIRST-only recovery for a bound charge abandoned at 3DS (never part of the
   * generic `listRecoverable` scan). Each candidate that still owns its FIRST_PENDING claim is
   * re-read from Stripe and recorded through the monotonic PaymentAttempt CAS; the relationship
   * then converges purely from that durable state:
   *   canceled                -> CANCELED, claim released (revision-guarded CAS)
   *   requires_payment_method -> FAILED, claim released; a later success still reconciles
   *   succeeded               -> SUCCEEDED, claim kept for the P0 persistence/compensation pass
   *   processing              -> PROCESSING, claim kept (generic pass follows it)
   *   requires_action         -> unchanged and backed off; the claim stays reserved
   *   provider/correlation error -> backed off; nothing released
   * Nothing is ever canceled at Stripe here: there is no approved auto-cancellation policy.
   */
  private async reconcileStaleFirstRequiresAction(
    limit: number,
  ): Promise<{ reconciled: number; errors: number }> {
    if (!this.relationshipService) return { reconciled: 0, errors: 0 };
    const candidates = await this.paymentAttemptRepository.listStaleFirstRequiresAction(
      limit,
      new Date(Date.now() - STALE_FIRST_REQUIRES_ACTION_MS),
    );
    return this.runFirstOwnedPass(
      candidates,
      "Stale FIRST requires_action",
      async (candidate) =>
        (await this.paymentService.reconcilePaymentAttempt(candidate._id)).attempt,
    );
  }

  /**
   * P1.1.1 — dedicated FIRST-only recovery for a bound charge whose dispatch left no recorded
   * PaymentIntent (crash between bind and create, or a create that failed / timed out without a
   * PaymentIntent in the response). Never part of the generic scan and never search-based: the
   * strongly consistent customer-scoped list decides.
   *   PaymentIntent found     -> recorded through the monotonic CAS; the relationship follows
   *                              the P1.1 rules above (only FAILED/CANCELED release)
   *   proven absent           -> FAILED + PROVIDER_NOT_CREATED (CAS), claim released
   *                              (revision-guarded CAS); the operation is closed for creation
   *   provider/correlation error -> backed off; nothing released
   */
  private async resolveStaleFirstUnsent(
    limit: number,
  ): Promise<{ reconciled: number; errors: number }> {
    if (!this.relationshipService) return { reconciled: 0, errors: 0 };
    const candidates = await this.paymentAttemptRepository.listStaleFirstUnsent(
      limit,
      new Date(Date.now() - STALE_FIRST_UNSENT_MS),
    );
    return this.runFirstOwnedPass(candidates, "Stale FIRST unsent", (candidate) =>
      this.paymentService.resolveUnsentPaymentAttempt(candidate._id),
    );
  }

  /** Shared driver of the FIRST-only passes: verifies the candidate still owns its FIRST_PENDING
   * claim, lets `resolve` record the authoritative provider state, then converges the
   * relationship purely from durable state. Unresolved outcomes and errors back off. */
  private async runFirstOwnedPass(
    candidates: PaymentAttemptDocument[],
    label: string,
    resolve: (candidate: PaymentAttemptDocument) => Promise<PaymentAttemptDocument>,
  ): Promise<{ reconciled: number; errors: number }> {
    const relationships = this.relationshipService;
    if (!relationships) return { reconciled: 0, errors: 0 };
    let reconciled = 0;
    let errors = 0;
    for (const candidate of candidates) {
      try {
        if (!(await relationships.ownsPendingFirstClaim(candidate))) {
          logger.warn(
            { recordType: "PaymentAttempt", recordId: String(candidate._id) },
            `${label} attempt does not own its relationship claim`,
          );
          await this.paymentAttemptRepository.scheduleRecoveryRetry(
            candidate._id,
            "PaymentAttempt does not own its FIRST relationship claim",
          );
          continue;
        }

        const attempt = await resolve(candidate);
        reconciled += 1;
        if (UNRESOLVED_PROVIDER_STATUSES.has(attempt.providerStatus)) {
          await this.paymentAttemptRepository.scheduleRecoveryRetry(
            attempt._id,
            attempt.providerStatus === "REQUIRES_ACTION"
              ? "PaymentIntent still requires customer action"
              : "Provider PaymentIntent state is not resolved yet",
          );
          continue;
        }
        await relationships.reconcileForPaymentAttempt(attempt._id);
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
          `${label} recovery item failed`,
        );
      }
    }
    return { reconciled, errors };
  }

  private async ensureRefundLedger(
    operation: RefundOperationDocument,
    providerRefundId: string,
  ): Promise<void> {
    const current = await this.refundOperationRepository.findById(operation._id);
    if (!current || current.providerRefundId !== providerRefundId)
      throw new Error("Refund operation correlation mismatch");
    await ensureRefundAccounting(
      current,
      this.financialTransactionService,
      this.refundOperationRepository,
    );
  }

  private async reconcilePackageVoid(
    operation: RefundOperationDocument,
    status: "SUCCEEDED" | "FAILED",
    providerRefundId: string,
  ): Promise<void> {
    if (
      !operation.packageProgressId ||
      !this.packageProgressRepository ||
      !["PACKAGE_VOID", "BUSINESS_PACKAGE_TERMINATION", "BUSINESS_CANCELLATION"].includes(
        operation.reason,
      )
    )
      return;
    const progress = await this.packageProgressRepository.findByIdInternal(
      operation.packageProgressId,
    );
    if (!progress) return;
    if (!progress.voidedAt) return;
    await this.packageProgressRepository.settleVoidRefund(operation._id, status, providerRefundId);
  }
}
