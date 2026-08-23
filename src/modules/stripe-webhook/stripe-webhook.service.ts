import type Stripe from "stripe";

import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "../payment/payment.types.js";
import type { StripeWebhookEventRepository } from "./stripe-webhook-event.repository.js";

const HANDLED_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "setup_intent.succeeded",
  "charge.refunded",
]);

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

    const claimed = await this.eventRepository.claim(event.id, event.type);
    if (!claimed) {
      return false;
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case "payment_intent.payment_failed":
          await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
          break;
        case "charge.refunded":
          await this.handleChargeRefunded(event.data.object as Stripe.Charge);
          break;
        case "setup_intent.succeeded":
          // Informational only — see this class's own doc comment.
          break;
        default:
          break;
      }
      await this.eventRepository.markProcessed(event.id);
      return true;
    } catch (error) {
      await this.eventRepository.markFailed(
        event.id,
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }

  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const bookingId = paymentIntent.metadata?.["bookingId"];
    if (!bookingId) {
      return;
    }

    const entries = await this.financialTransactionService.listForBooking(bookingId);
    const matched = entries.find((entry) => entry.providerReference === paymentIntent.id);
    if (!matched) {
      return;
    }

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
    await this.recordProcessingFee(matched, paymentIntent.id);
  }

  private async recordProcessingFee(
    settledEntry: BookingFinancialTransactionDocument,
    paymentIntentId: string,
  ): Promise<void> {
    let fee: Awaited<ReturnType<PaymentGateway["retrieveProcessingFeeForPaymentIntent"]>>;
    try {
      fee = await this.gateway.retrieveProcessingFeeForPaymentIntent(paymentIntentId);
    } catch {
      // Best-effort enrichment — the primary charge already settled correctly above regardless.
      return;
    }

    if (!fee || fee.feeCents <= 0) {
      return;
    }

    try {
      await this.financialTransactionService.record({
        businessId: settledEntry.businessId,
        bookingId: settledEntry.bookingId,
        businessClientId: settledEntry.businessClientId,
        customerUserId: settledEntry.customerUserId,
        type: "PROCESSING_FEE",
        direction: "DEBIT",
        amountCents: fee.feeCents,
        currency: settledEntry.currency,
        status: "SUCCEEDED",
        providerReference: paymentIntentId,
        idempotencyKey: `processing-fee:${paymentIntentId}`,
        // Batch 8 — records WHICH underlying payment this processing fee belongs to, the sole
        // mechanism FinanceOwnership uses to decide who bears it ("the owner of the underlying
        // payment bears its Stripe processing fee" — see finance-ownership.ts). Without this,
        // Batch 7's assumption that every PROCESSING_FEE is Business-borne was wrong for a
        // first-booking PLATFORM_FEE charge.
        metadata: { sourceType: settledEntry.type, sourceTransactionId: String(settledEntry._id) },
      });
    } catch {
      // Duplicate key on retry (already recorded) — safe to ignore, matches the idempotent
      // spirit of every other webhook handler in this class.
    }
  }

  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
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

  private async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const bookingId = charge.metadata?.["bookingId"];
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!bookingId || !paymentIntentId) {
      return;
    }

    const entries = await this.financialTransactionService.listForBooking(bookingId);
    const pending = entries.find(
      (entry) => entry.type === "REFUND" && entry.status !== "SUCCEEDED" && entry.providerReference,
    );
    if (pending) {
      await this.financialTransactionService.settleStatus(pending._id, "SUCCEEDED");
    }
  }
}
