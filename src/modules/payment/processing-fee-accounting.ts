import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "./payment.types.js";

/** The provider fee is not resolvable yet (lookup failed or no balance transaction) — retry. */
export class ProcessingFeeUnavailableError extends Error {}
/** Corrupt/incomparable currencies — investigation, never a guessed fee. */
export class ProcessingFeeCurrencyMismatchError extends Error {}
/** The ledger write failed and no idempotent row exists — retry. */
export class ProcessingFeePersistenceError extends Error {}

export const processingFeeIdempotencyKey = (paymentIntentId: string): string =>
  `processing-fee:${paymentIntentId}`;

/**
 * The single processing-fee accounting path (Batch 7/8 semantics, extracted unchanged in P6 so the
 * `payment_intent.succeeded` webhook and the money-recovery backstop record the SAME row): the
 * provider-confirmed fee of a settled principal's PaymentIntent, attributed to that principal's
 * owner via `metadata.sourceType`, exactly once per PaymentIntent (`processing-fee:<pi>`).
 * A zero fee records nothing. Never estimates a fee.
 */
export async function ensureProcessingFeeAccounting(
  settledEntry: BookingFinancialTransactionDocument,
  input: { paymentIntentId: string; paymentIntentCurrency: string | undefined },
  gateway: Pick<PaymentGateway, "retrieveProcessingFeeForPaymentIntent">,
  financials: Pick<BookingFinancialTransactionService, "record" | "findByIdempotencyKey">,
): Promise<"RECORDED" | "EXISTS" | "ZERO"> {
  const key = processingFeeIdempotencyKey(input.paymentIntentId);
  let fee: Awaited<ReturnType<PaymentGateway["retrieveProcessingFeeForPaymentIntent"]>>;
  try {
    fee = await gateway.retrieveProcessingFeeForPaymentIntent(input.paymentIntentId);
  } catch {
    throw new ProcessingFeeUnavailableError("Stripe processing fee is temporarily unavailable");
  }

  if (!fee) {
    throw new ProcessingFeeUnavailableError("Stripe balance transaction is not available yet");
  }
  if (fee.feeCents <= 0) {
    return "ZERO";
  }

  const piCurrency = input.paymentIntentCurrency?.toUpperCase();
  if (
    !piCurrency ||
    piCurrency !== settledEntry.currency ||
    fee.currency.toUpperCase() !== settledEntry.currency
  ) {
    throw new ProcessingFeeCurrencyMismatchError(
      `Processing-fee currency mismatch (pi=${piCurrency ?? "missing"}, booking=${settledEntry.currency}, balance=${fee.currency})`,
    );
  }

  try {
    await financials.record({
      businessId: settledEntry.businessId,
      bookingId: settledEntry.bookingId,
      businessClientId: settledEntry.businessClientId,
      customerUserId: settledEntry.customerUserId,
      type: "PROCESSING_FEE",
      direction: "DEBIT",
      amountCents: fee.feeCents,
      currency: settledEntry.currency,
      status: "SUCCEEDED",
      providerReference: input.paymentIntentId,
      idempotencyKey: key,
      // Batch 8 — records WHICH underlying payment this processing fee belongs to, the sole
      // mechanism FinanceOwnership uses to decide who bears it ("the owner of the underlying
      // payment bears its Stripe processing fee" — see finance-ownership.ts).
      metadata: { sourceType: settledEntry.type, sourceTransactionId: String(settledEntry._id) },
    });
    return "RECORDED";
  } catch {
    const existing = await financials.findByIdempotencyKey(key);
    if (!existing) {
      throw new ProcessingFeePersistenceError("Processing-fee ledger persistence failed");
    }
    return "EXISTS";
  }
}
