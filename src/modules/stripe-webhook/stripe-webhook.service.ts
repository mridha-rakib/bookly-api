import type { Types } from "mongoose";
import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import {
  type PenaltyCollectionService,
  PenaltyCorrelationError,
} from "../booking/penalty-collection.service.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { PaymentGateway } from "../payment/payment.types.js";
import type { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import {
  type ParsedPaymentIntentMetadata,
  type PaymentIntentPurpose,
  parsePaymentIntentMetadata,
} from "../payment/payment-intent-metadata.js";
import type { PaymentTaxAssociationReconciler } from "../payment/payment-tax-association-reconciler.js";
import { isPenaltyPurpose } from "../payment/penalty-attempt.js";
import {
  ensureProcessingFeeAccounting,
  ProcessingFeeCurrencyMismatchError,
  ProcessingFeePersistenceError,
  ProcessingFeeUnavailableError,
} from "../payment/processing-fee-accounting.js";
import { ensureRefundAccounting } from "../payment/refund-accounting.js";
import type { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import {
  ProviderReversalCorrelationError,
  type ProviderReversalService,
} from "../provider-reversal/provider-reversal.service.js";
import type { StripeWebhookEventRepository } from "./stripe-webhook-event.repository.js";

const HANDLED_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "setup_intent.succeeded",
  "charge.refunded",
  // P6 — provider-originated reversals: the dispute lifecycle and refunds made outside Bookly.
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.refund.updated",
]);

const DISPUTE_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);

export type WebhookReplayOutcome =
  | "NOT_FOUND"
  | "NOT_FAILED"
  | "PROCESSED"
  | "RETRYABLE"
  | "FAILED";

/** A 5xx is intentional for this class: Stripe must redeliver when durable domain state or a
 * provider settlement dependency has not caught up yet. */
class RetryableWebhookError extends Error {}
/** Corrupt correlation data is retained as FAILED for investigation and acknowledged, rather
 * than retried indefinitely or silently accepted. */
class InvestigationWebhookError extends Error {}

/**
 * Batch 4, Phase 10 — only the events this codebase actually acts on (per the brief's own
 * "do not add dozens of unsupported event handlers"). Every handler here is a RECONCILIATION
 * backstop, not the primary path: the primary path (activation/cancellation/no-show charges,
 * refunds, saved-card confirmation) already updates the ledger and Booking synchronously at the
 * moment `PaymentService`'s own call returns — see BookingCreationService.finalizeCustomerBooking
 * / BookingLifecycleService's cancellation methods / PaymentService.confirmSavedPaymentMethod.
 * This service exists for the cases the synchronous path cannot fully cover: a process crash
 * between "Stripe confirmed" and "we wrote that down," a genuinely async settlement (some
 * refunds/disputes resolve on Stripe's own timeline), or Stripe's own automatic retries.
 *
 * `setup_intent.succeeded` is logged only — the synchronous `confirmSavedPaymentMethod` flow
 * already re-verifies the SetupIntent's status server-side (never trusts the frontend's claim)
 * and is the primary, already-robust path; no additional action is taken here.
 */
export class StripeWebhookService {
  public constructor(
    private readonly gateway: PaymentGateway,
    private readonly eventRepository: StripeWebhookEventRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly taxAssociationReconciler?: PaymentTaxAssociationReconciler,
    private readonly paymentAttemptRepository?: PaymentAttemptRepository,
    private readonly refundOperationRepository?: RefundOperationRepository,
    private readonly packageProgressRepository?: PackageProgressRepository,
    private readonly bookingRepository?: BookingRepository,
    // P1 — converges a FIRST customer↔business relationship claim when its PaymentAttempt
    // definitively fails or its failed-creation compensation refund settles. Best-effort here:
    // the money-recovery worker's relationship scan is the guaranteed convergence path.
    private readonly relationshipReconciler?: Pick<
      FinancialRelationshipService,
      "reconcileForPaymentAttempt"
    > &
      Partial<Pick<FinancialRelationshipService, "reconcile">>,
    // P5 — settles a customer penalty PaymentIntent (CANCELLATION_FEE / NO_SHOW_FEE) through the
    // SAME convergence the request/worker/recovery use, correlated by its PaymentAttempt — never
    // by a pre-existing ledger providerReference. Optional trailing dep.
    private readonly penaltyCollection?: Pick<PenaltyCollectionService, "convergeAttempt">,
    // P6 — disputes / external refunds (accounting + support visibility only) and the terminal
    // FAILED support alert. Optional trailing dep: without it the pre-P6 behaviour is unchanged
    // (dispute events stay retryable for a process that has it).
    private readonly providerReversals?: Pick<
      ProviderReversalService,
      "syncDispute" | "reconcileRefundsForPaymentIntent" | "alertWebhookFailed"
    >,
  ) {}

  public isHandled(type: string): boolean {
    return HANDLED_EVENT_TYPES.has(type);
  }

  public verifyAndParse(rawBody: Buffer, signature: string): Stripe.Event {
    return this.gateway.constructWebhookEvent(rawBody, signature);
  }

  /** Returns `true` if this call actually processed the event (`false` for an already-seen or
   * unhandled event) — the controller returns 200 either way, matching Stripe's guidance that a
   * webhook endpoint should acknowledge receipt regardless of whether any new work happened. */
  public async process(event: Stripe.Event): Promise<boolean> {
    if (!this.isHandled(event.type)) {
      return false;
    }

    const processingLeaseToken = await this.eventRepository.claim(
      event.id,
      event.type,
      this.toReplayPayload(event),
    );
    if (!processingLeaseToken) {
      return false;
    }

    await this.processClaimed(event, processingLeaseToken);
    return true;
  }

  public async recoverDue(limit = 50): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.eventRepository.claimNextDue();
      if (!claimed) break;
      try {
        await this.processClaimed(
          claimed.payload as unknown as Stripe.Event,
          claimed.processingLeaseToken as string,
        );
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return { processed, failed };
  }

  private async processClaimed(event: Stripe.Event, processingLeaseToken: string): Promise<void> {
    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case "payment_intent.payment_failed":
          await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
          break;
        case "payment_intent.canceled":
          await this.handlePaymentIntentCanceled(event.data.object as Stripe.PaymentIntent);
          break;
        case "charge.refunded":
          await this.handleChargeRefunded(event.data.object as Stripe.Charge);
          break;
        case "charge.refund.updated":
          await this.handleRefundUpdated(event.data.object as Stripe.Refund);
          break;
        case "setup_intent.succeeded":
          // Informational only — see this class's own doc comment.
          break;
        default:
          if (DISPUTE_EVENT_TYPES.has(event.type)) {
            await this.handleDisputeEvent(event.data.object as Stripe.Dispute);
          }
          break;
      }
      await this.eventRepository.markProcessed(event.id, processingLeaseToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (error instanceof InvestigationWebhookError) {
        await this.eventRepository.markFailed(event.id, processingLeaseToken, message);
        await this.alertIfFailed(event, message);
        return;
      }
      await this.eventRepository.markRetryable(event.id, processingLeaseToken, message);
      await this.alertIfFailed(event, message);
      throw error;
    }
  }

  /** P6 — Support learns of every event that reaches the terminal FAILED state (investigation, or
   * the retry limit). Best-effort: never changes the event's own outcome. */
  private async alertIfFailed(event: Stripe.Event, message: string): Promise<void> {
    if (!this.providerReversals) return;
    try {
      const stored = await this.eventRepository.findByEventId(event.id);
      if (stored?.status !== "FAILED") return;
      const object = event.data.object as { id?: unknown };
      await this.providerReversals.alertWebhookFailed({
        eventId: event.id,
        type: event.type,
        error: stored.error ?? message,
        providerObjectId: typeof object?.id === "string" ? object.id : undefined,
        replayCount: stored.replayCount ?? 0,
      });
    } catch (error) {
      logger.error(
        { err: error, eventId: event.id },
        "Failed to alert support of a FAILED webhook",
      );
    }
  }

  /**
   * P6 — Super Admin replay of a terminal FAILED event from its stored replay payload. The handlers
   * are idempotent (ledger keys, CAS state transitions), so a replay can only converge, never
   * double-account. A replay that fails retryably is left RETRYABLE for the recovery worker.
   */
  public async replayEvent(eventId: string, actorUserId: string): Promise<WebhookReplayOutcome> {
    const existing = await this.eventRepository.findByEventId(eventId);
    if (!existing) return "NOT_FOUND";
    const reset = await this.eventRepository.resetFailedForReplay(eventId, actorUserId);
    if (!reset) return "NOT_FAILED";
    const claimed = await this.eventRepository.claimStoredEvent(eventId);
    if (!claimed) return "RETRYABLE";
    try {
      await this.processClaimed(
        claimed.payload as unknown as Stripe.Event,
        claimed.processingLeaseToken as string,
      );
    } catch {
      // Recorded as RETRYABLE (or FAILED at the limit) by processClaimed itself.
    }
    const after = await this.eventRepository.findByEventId(eventId);
    return after?.status === "PROCESSED" || after?.status === "FAILED" ? after.status : "RETRYABLE";
  }

  private toReplayPayload(event: Stripe.Event): Record<string, unknown> {
    const object = event.data.object;
    if (
      event.type === "payment_intent.succeeded" ||
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled"
    ) {
      const paymentIntent = object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: event.type,
        data: {
          object: {
            id: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            customer:
              typeof paymentIntent.customer === "string"
                ? paymentIntent.customer
                : paymentIntent.customer?.id,
            metadata: paymentIntent.metadata,
            ...(event.type === "payment_intent.canceled"
              ? { cancellation_reason: paymentIntent.cancellation_reason ?? null }
              : {}),
          },
        },
      };
    }
    if (event.type === "charge.refunded") {
      const charge = object as Stripe.Charge;
      return {
        id: event.id,
        type: event.type,
        data: {
          object: {
            id: charge.id,
            payment_intent:
              typeof charge.payment_intent === "string"
                ? charge.payment_intent
                : charge.payment_intent?.id,
            metadata: charge.metadata,
            refunds: {
              data: (charge.refunds?.data ?? []).map((refund) => ({
                id: refund.id,
                amount: refund.amount,
                currency: refund.currency,
                status: refund.status,
                metadata: refund.metadata,
              })),
            },
          },
        },
      };
    }
    if (DISPUTE_EVENT_TYPES.has(event.type)) {
      const dispute = object as Stripe.Dispute;
      return {
        id: event.id,
        type: event.type,
        data: {
          object: {
            id: dispute.id,
            charge: typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id,
            payment_intent:
              typeof dispute.payment_intent === "string"
                ? dispute.payment_intent
                : dispute.payment_intent?.id,
            amount: dispute.amount,
            currency: dispute.currency,
            status: dispute.status,
          },
        },
      };
    }
    if (event.type === "charge.refund.updated") {
      const refund = object as Stripe.Refund;
      return {
        id: event.id,
        type: event.type,
        data: {
          object: {
            id: refund.id,
            payment_intent:
              typeof refund.payment_intent === "string"
                ? refund.payment_intent
                : refund.payment_intent?.id,
            amount: refund.amount,
            currency: refund.currency,
            status: refund.status,
            metadata: refund.metadata,
          },
        },
      };
    }
    return { id: event.id, type: event.type, data: { object: {} } };
  }

  /** The durable PaymentAttempt this PaymentIntent belongs to (by stored PI id, else by the
   * attempt id stamped into its metadata), after verifying amount/currency/customer. */
  private async findCorrelatedAttempt(paymentIntent: Stripe.PaymentIntent) {
    let attempt = await this.paymentAttemptRepository?.findByProviderPaymentIntentId(
      paymentIntent.id,
    );
    const metadataAttemptId = paymentIntent.metadata?.["booklyPaymentAttemptId"];
    if (!attempt && metadataAttemptId) {
      attempt = await this.paymentAttemptRepository?.findById(metadataAttemptId);
    }
    if (!attempt) return undefined;
    const customerId =
      typeof paymentIntent.customer === "string"
        ? paymentIntent.customer
        : paymentIntent.customer?.id;
    if (
      paymentIntent.amount !== attempt.expectedAmountCents ||
      paymentIntent.currency.toUpperCase() !== attempt.currency ||
      customerId !== attempt.providerCustomerId
    ) {
      throw new InvestigationWebhookError("PaymentAttempt provider correlation mismatch");
    }
    // P5 — a penalty PaymentIntent must carry its attempt's own purpose: a mismatch is corrupt
    // correlation, retained for investigation before anything is recorded or settled.
    if (
      isPenaltyPurpose(attempt.purpose) &&
      paymentIntent.metadata?.["purpose"] !== attempt.purpose
    ) {
      throw new InvestigationWebhookError(
        "Penalty PaymentIntent purpose does not match its attempt",
      );
    }
    return attempt;
  }

  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const attempt = await this.findCorrelatedAttempt(paymentIntent);
    if (attempt) {
      // FAILED (requires_payment_method) is superseded here; only CANCELED conflicts.
      const storedAttempt = await this.paymentAttemptRepository?.recordProviderResult(attempt._id, {
        providerPaymentIntentId: paymentIntent.id,
        providerStatus: "SUCCEEDED",
      });
      if (storedAttempt && storedAttempt.providerStatus !== "SUCCEEDED") {
        throw new InvestigationWebhookError("PaymentAttempt terminal provider state conflict");
      }
      // P5 — a penalty success settles its obligation (exact PI as providerReference) BEFORE the
      // processing-fee step below, which then finds that row like any other settled charge.
      if (isPenaltyPurpose(attempt.purpose)) {
        await this.convergePenalty(attempt._id, "SUCCEEDED");
      }
    }
    let metadata: ParsedPaymentIntentMetadata | undefined;
    try {
      metadata = parsePaymentIntentMetadata(paymentIntent.metadata);
    } catch (error) {
      throw new InvestigationWebhookError(
        error instanceof Error ? error.message : "Invalid PaymentIntent metadata",
      );
    }

    // Legacy PIs predate the C3 contract. Preserve their existing pre-tax reconciliation path;
    // strict metadata/amount validation applies only when a PI explicitly declares c3-prep-v1.
    const bookingId = metadata?.bookingId ?? paymentIntent.metadata?.["bookingId"];
    if (!bookingId) {
      return;
    }

    const entries = await this.financialTransactionService.listForBooking(bookingId);
    const matched = entries.find((entry) => entry.providerReference === paymentIntent.id);
    if (!matched) {
      throw new RetryableWebhookError("PaymentIntent source ledger row is not persisted yet");
    }

    if (metadata) this.validateMetadataAgainstSource(paymentIntent, metadata, matched);

    if (matched.status === "PENDING") {
      await this.financialTransactionService.settleStatus(matched._id, "SUCCEEDED");
    }

    // Batch 8 correction: MOST real charges in this codebase settle synchronously at the
    // moment the charge is made (`PaymentIntentResult.status === "succeeded"` in the SAME API
    // response — see PaymentIntentResult's own comment) — the ledger entry is therefore
    // usually ALREADY "SUCCEEDED" by the time this webhook arrives, not "PENDING". Gating
    // PROCESSING_FEE capture on "this webhook call is the one that performed PENDING ->
    // SUCCEEDED" (Batch 7's original condition) meant it almost never fired for the common
    // case. Stripe sends `payment_intent.succeeded` for EVERY successful PaymentIntent
    // regardless of whether our own synchronous call already observed success, so this now
    // always attempts capture once a matching entry is found (by `providerReference`,
    // any status) — `recordProcessingFee`'s own unique `idempotencyKey` is what actually
    // guards against duplicate recording on webhook redelivery, not this branch.
    await this.recordProcessingFee(matched, paymentIntent);
    if (metadata && this.taxAssociationReconciler) {
      const taxAssociation = await this.taxAssociationReconciler.reconcile(
        paymentIntent.id,
        metadata,
      );
      if (taxAssociation.status === "pending") {
        throw new RetryableWebhookError(taxAssociation.reason);
      }
      if (taxAssociation.status === "investigation") {
        throw new InvestigationWebhookError(taxAssociation.reason);
      }
    }
  }

  private async recordProcessingFee(
    settledEntry: BookingFinancialTransactionDocument,
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    // P6 — the shared processing-fee path (also used by the money-recovery backstop); the
    // retry/investigation mapping below is the pre-existing webhook contract, unchanged.
    try {
      await ensureProcessingFeeAccounting(
        settledEntry,
        { paymentIntentId: paymentIntent.id, paymentIntentCurrency: paymentIntent.currency },
        this.gateway,
        this.financialTransactionService,
      );
    } catch (error) {
      if (error instanceof ProcessingFeeCurrencyMismatchError) {
        throw new InvestigationWebhookError(error.message);
      }
      if (
        error instanceof ProcessingFeeUnavailableError ||
        error instanceof ProcessingFeePersistenceError
      ) {
        throw new RetryableWebhookError(error.message);
      }
      throw error;
    }
  }

  private validateMetadataAgainstSource(
    paymentIntent: Stripe.PaymentIntent,
    metadata: ParsedPaymentIntentMetadata,
    source: BookingFinancialTransactionDocument,
  ): void {
    if (paymentIntent.amount !== metadata.chargedAmountCents) {
      throw new InvestigationWebhookError("PaymentIntent amount does not match immutable metadata");
    }
    if (
      String(source.businessId) !== metadata.businessId ||
      String(source.businessClientId) !== metadata.businessClientId ||
      !this.sourceTypeMatchesPurpose(source.type, metadata.purpose)
    ) {
      throw new InvestigationWebhookError(
        "PaymentIntent metadata ownership does not match source ledger row",
      );
    }
  }

  private sourceTypeMatchesPurpose(
    sourceType: BookingFinancialTransactionDocument["type"],
    purpose: PaymentIntentPurpose,
  ): boolean {
    if (
      purpose === "BOOKING_DEPOSIT" ||
      purpose === "PACKAGE_PURCHASE" ||
      purpose === "PACKAGE_SESSION_EXTRAS"
    ) {
      return sourceType === "DEPOSIT" || sourceType === "PLATFORM_FEE";
    }
    if (purpose === "CANCELLATION_FEE") return sourceType === "CANCELLATION_FEE";
    return sourceType === "NO_SHOW_FEE";
  }

  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const attempt = await this.findCorrelatedAttempt(paymentIntent);
    if (attempt) {
      const storedAttempt = await this.paymentAttemptRepository?.recordProviderResult(attempt._id, {
        providerPaymentIntentId: paymentIntent.id,
        providerStatus: "FAILED",
      });
      if (storedAttempt && storedAttempt.providerStatus !== "FAILED") return;
      // P5 — penalty attempts never touch the FIRST relationship.
      if (isPenaltyPurpose(attempt.purpose)) {
        await this.convergePenalty(attempt._id, "FAILED");
        return;
      }
      await this.reconcileRelationship(attempt._id);
    }
    await this.settlePendingLedgerAsFailed(paymentIntent);
  }

  /**
   * P1.1 — a canceled PaymentIntent is provider-terminal: Stripe never cancels a succeeded PI and
   * a canceled PI can never be confirmed again, so the event type alone is authoritative and
   * out-of-order delivery cannot make it stale. Records CANCELED (+ Stripe's cancellation
   * reason), then converges a bound FIRST claim through the CAS-guarded relationship release.
   * Never consumes FIRST and never creates a ledger entry.
   */
  private async handlePaymentIntentCanceled(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const attempt = await this.findCorrelatedAttempt(paymentIntent);
    if (attempt) {
      const storedAttempt = await this.paymentAttemptRepository?.recordProviderResult(attempt._id, {
        providerPaymentIntentId: paymentIntent.id,
        providerStatus: "CANCELED",
        lastErrorCode: "PROVIDER_CANCELED",
        lastErrorMessage: `Stripe cancellation_reason: ${paymentIntent.cancellation_reason ?? "unspecified"}`,
      });
      // Only an internal SUCCEEDED can refuse CANCELED — impossible for a genuine Stripe event,
      // so the recorded success is kept untouched and the event is retained for investigation.
      if (storedAttempt && storedAttempt.providerStatus !== "CANCELED") {
        throw new InvestigationWebhookError("PaymentAttempt terminal provider state conflict");
      }
      if (isPenaltyPurpose(attempt.purpose)) {
        await this.convergePenalty(attempt._id, "FAILED");
        return;
      }
      await this.reconcileRelationship(attempt._id);
    }
    await this.settlePendingLedgerAsFailed(paymentIntent);
  }

  /**
   * P5 — penalty convergence from a webhook (purpose already verified by findCorrelatedAttempt).
   * A success that did not converge yet (another path holds the persistence lease, or a
   * transient error) is retried by redelivery so the processing fee is still captured
   * afterwards; a definitive local outcome that contradicts the provider is investigation,
   * never a regression.
   */
  private async convergePenalty(
    paymentAttemptId: Types.ObjectId,
    expected: "SUCCEEDED" | "FAILED",
  ): Promise<void> {
    if (!this.penaltyCollection) {
      throw new RetryableWebhookError("Penalty convergence is not available in this process");
    }
    let outcome: string;
    try {
      outcome = await this.penaltyCollection.convergeAttempt(paymentAttemptId);
    } catch (error) {
      if (error instanceof PenaltyCorrelationError) {
        throw new InvestigationWebhookError(error.message);
      }
      throw new RetryableWebhookError(
        error instanceof Error ? error.message : "Penalty convergence failed",
      );
    }
    if (expected === "SUCCEEDED" && outcome !== "SUCCEEDED") {
      throw new RetryableWebhookError("Penalty success is not converged yet");
    }
  }

  private async settlePendingLedgerAsFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const bookingId = paymentIntent.metadata?.["bookingId"];
    if (!bookingId) {
      return;
    }

    const entries = await this.financialTransactionService.listForBooking(bookingId);
    const pending = entries.find(
      (entry) => entry.providerReference === paymentIntent.id && entry.status === "PENDING",
    );
    if (pending) {
      await this.financialTransactionService.settleStatus(pending._id, "FAILED");
    }
  }

  private async reconcileRelationship(paymentAttemptId: Types.ObjectId): Promise<void> {
    if (!this.relationshipReconciler) return;
    try {
      await this.relationshipReconciler.reconcileForPaymentAttempt(paymentAttemptId);
    } catch (error) {
      logger.warn(
        { err: error, recordType: "PaymentAttempt", recordId: String(paymentAttemptId) },
        "Financial relationship reconciliation deferred to money recovery",
      );
    }
  }

  private async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const bookingId = charge.metadata?.["bookingId"];
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId) {
      return;
    }

    for (const refund of charge.refunds?.data ?? []) {
      let operation = await this.refundOperationRepository?.findByProviderRefundId(refund.id);
      const operationId = refund.metadata?.["booklyRefundOperationId"];
      if (!operation && operationId) {
        operation = await this.refundOperationRepository?.findById(operationId);
      }
      if (!operation) {
        operation = await this.refundOperationRepository?.findPendingLegacyMatch(
          paymentIntentId,
          refund.amount,
        );
      }
      if (!operation) continue;
      if (
        operation.sourcePaymentIntentId !== paymentIntentId ||
        operation.expectedRefundAmountCents !== refund.amount ||
        operation.currency !== refund.currency.toUpperCase()
      ) {
        throw new InvestigationWebhookError("RefundOperation provider correlation mismatch");
      }
      const storedOperation = await this.refundOperationRepository?.recordProviderResult(
        operation._id,
        {
          providerRefundId: refund.id,
          providerStatus:
            refund.status === "succeeded"
              ? "SUCCEEDED"
              : refund.status === "failed" || refund.status === "canceled"
                ? "FAILED"
                : "PROVIDER_PENDING",
        },
      );
      const effectiveStatus = storedOperation?.providerStatus;
      if (operation.sourcePaymentAttemptId && this.paymentAttemptRepository) {
        if (effectiveStatus === "SUCCEEDED") {
          await this.paymentAttemptRepository.markRefunded(operation.sourcePaymentAttemptId);
        } else if (effectiveStatus === "PROVIDER_PENDING") {
          await this.paymentAttemptRepository.markRefundPending(operation.sourcePaymentAttemptId);
        } else if (effectiveStatus === "FAILED") {
          await this.paymentAttemptRepository.markCompensationFailed(
            operation.sourcePaymentAttemptId,
          );
        }
        if (operation.reason === "BOOKING_PERSISTENCE_COMPENSATION") {
          await this.reconcileRelationship(operation.sourcePaymentAttemptId);
        }
      }
      if (effectiveStatus === "SUCCEEDED" || effectiveStatus === "FAILED") {
        const settlementStatus = effectiveStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
        if (operation.packageProgressId && this.packageProgressRepository) {
          const progress = await this.packageProgressRepository.findByIdInternal(
            operation.packageProgressId,
          );
          if (progress?.voidedAt) {
            await this.packageProgressRepository.settleVoidRefund(
              operation._id,
              settlementStatus,
              refund.id,
            );
          }
        }
      }
      if (
        operation.bookingId &&
        ["BUSINESS_CANCELLATION", "BUSINESS_PACKAGE_TERMINATION", "PACKAGE_VOID"].includes(
          operation.reason,
        ) &&
        (effectiveStatus === "SUCCEEDED" || effectiveStatus === "FAILED")
      ) {
        await this.bookingRepository?.updateCancellationSettlement(
          operation.bookingId,
          effectiveStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
          refund.id,
        );
      }
      if (effectiveStatus === "SUCCEEDED" && storedOperation && this.refundOperationRepository) {
        await ensureRefundAccounting(
          storedOperation,
          this.financialTransactionService,
          this.refundOperationRepository,
        );
        if (operation.businessClientId)
          await this.relationshipReconciler?.reconcile?.(operation.businessClientId);
        await this.refundOperationRepository.markDomainReconciled(operation._id);
      }
      if (effectiveStatus === "FAILED") {
        const pendingLedger = await this.financialTransactionService.findByIdempotencyKey(
          `refund-operation:${String(operation._id)}:ledger`,
        );
        if (pendingLedger?.status === "PENDING") {
          await this.financialTransactionService.settleStatus(pendingLedger._id, "FAILED");
        }
      }
    }
    if (bookingId) {
      const entries = await this.financialTransactionService.listForBooking(bookingId);
      const succeededRefundIds = new Set(
        (charge.refunds?.data ?? [])
          .filter((refund) => refund.status === "succeeded")
          .map((refund) => refund.id),
      );
      for (const pending of entries.filter(
        (entry) =>
          entry.type === "REFUND" &&
          entry.status === "PENDING" &&
          entry.providerReference !== undefined &&
          succeededRefundIds.has(entry.providerReference),
      )) {
        await this.financialTransactionService.settleStatus(pending._id, "SUCCEEDED");
      }
    }

    // P6 — AFTER every Bookly-authorized refund above is attached to its RefundOperation: any
    // remaining provider refund of this PaymentIntent was made outside Bookly (Dashboard / API).
    await this.reconcileExternalRefunds(paymentIntentId);
  }

  /** P6 — a refund's later status change (e.g. pending -> succeeded / failed) re-reads the
   * PaymentIntent's provider refunds; Bookly-authorized refunds keep their own paths. */
  private async handleRefundUpdated(refund: Stripe.Refund): Promise<void> {
    const paymentIntentId =
      typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
    if (!paymentIntentId) return;
    await this.reconcileExternalRefunds(paymentIntentId);
  }

  private async reconcileExternalRefunds(paymentIntentId: string): Promise<void> {
    if (!this.providerReversals) return;
    try {
      await this.providerReversals.reconcileRefundsForPaymentIntent(paymentIntentId, "WEBHOOK");
    } catch (error) {
      throw this.toReversalWebhookError(error, "External refund reconciliation failed");
    }
  }

  /** P6 — every dispute event re-reads the dispute from the provider (authoritative current
   * state), so duplicate / out-of-order dispute events converge to the same accounting. */
  private async handleDisputeEvent(dispute: Stripe.Dispute): Promise<void> {
    if (!this.providerReversals) {
      throw new RetryableWebhookError("Dispute reconciliation is not available in this process");
    }
    try {
      await this.providerReversals.syncDispute(dispute.id, "WEBHOOK");
    } catch (error) {
      throw this.toReversalWebhookError(error, "Dispute reconciliation failed");
    }
  }

  private toReversalWebhookError(error: unknown, fallback: string): Error {
    const message = error instanceof Error ? error.message : fallback;
    return error instanceof ProviderReversalCorrelationError
      ? new InvestigationWebhookError(message)
      : new RetryableWebhookError(message);
  }
}
