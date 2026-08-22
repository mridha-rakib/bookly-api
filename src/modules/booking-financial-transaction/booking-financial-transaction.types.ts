/**
 * The kinds of money movement this ledger records. Each Booking's financial history is the
 * ordered sequence of these entries — Booking.financials remains the fast current-state
 * summary (unchanged by this module); this is the auditable "how did we get there."
 *
 * DEPOSIT vs PLATFORM_FEE (Batch 6.5 — critical for payout/reporting correctness): a
 * BOOKLY_MANAGED booking's online deposit charge is ledgered as EXACTLY ONE of these two types,
 * decided by first-vs-returning at the moment it's recorded — never both, never neither:
 *   PLATFORM_FEE — the customer's FIRST eligible booking at this Business. Bookly's own
 *     activation revenue; economically Bookly's money.
 *   DEPOSIT      — a RETURNING customer's booking. The same kind of online deposit charge, but
 *     economically the Business's own already-collected service prepayment — never Bookly
 *     revenue, never to be aggregated into platform income by a future Payouts/Finance batch.
 * See BookingFinancialTransactionService.findSucceededUpfrontPayment, the one shared lookup
 * that treats both as "the customer's upfront payment" for netting/refund purposes while still
 * keeping them distinguishable for revenue attribution.
 */
export const bookingFinancialTransactionTypes = [
  "DEPOSIT",
  "PAYMENT",
  "PLATFORM_FEE",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
  "REFUND",
  "BUSINESS_PAYOUT",
  "ADJUSTMENT",
  /**
   * Batch 4 addition — Stripe's own processing cost for a settled charge (rule #12: "Stripe/
   * payment processing fees must be represented separately... do not collapse them into one
   * generic fee field"). Reuses this same ledger rather than a parallel collection, matching
   * "extend only where necessary." The exact amount is rarely known synchronously (Stripe
   * settles the balance_transaction slightly after the charge) — see PaymentIntentResult's own
   * comment — so this entry is written PENDING at charge time and updated to SUCCEEDED with the
   * real fee once the `payment_intent.succeeded` webhook resolves it (see stripe-webhook
   * module); never a hardcoded percentage estimate.
   */
  "PROCESSING_FEE",
] as const;
export type BookingFinancialTransactionType = (typeof bookingFinancialTransactionTypes)[number];

/**
 * Relative to the amount the customer owes for the Booking — DEBIT increases it (a charge:
 * DEPOSIT, PAYMENT, PLATFORM_FEE, CANCELLATION_FEE, NO_SHOW_FEE, or a debit ADJUSTMENT),
 * CREDIT decreases it (REFUND, or a credit ADJUSTMENT). BUSINESS_PAYOUT sits outside the
 * customer's balance entirely (it is money leaving Bookly's collected pool to the Business) —
 * by convention it is always recorded as CREDIT, meaning "this entry closes out/settles funds
 * already collected," never as reducing what the customer owes a second time.
 */
export const bookingFinancialTransactionDirections = ["DEBIT", "CREDIT"] as const;
export type BookingFinancialTransactionDirection =
  (typeof bookingFinancialTransactionDirections)[number];

/**
 * PENDING while awaiting an external provider's confirmation (e.g. a Stripe PaymentIntent not
 * yet settled) — the one status a later batch may transition, PENDING -> SUCCEEDED|FAILED,
 * which is the narrow, explicitly-allowed exception to this collection's immutability (see
 * the model's update-guard comment). A reversal is its own new REFUND/ADJUSTMENT entry, never
 * a mutation of an existing SUCCEEDED row.
 *
 * WAIVED (Batch 5) — an honest terminal outcome for a CANCELLATION_FEE/NO_SHOW_FEE obligation
 * the Business explicitly chose never to collect (see BookingLifecycleService.waiveFee): the
 * row still records the amount that WOULD have been charged (never fake revenue — `direction`
 * stays DEBIT per the type's fixed direction, but WAIVED means the debit never actually
 * happened), so payout/reporting aggregation can tell "charged" and "waived" apart without a
 * parallel schema. The two legal paths into WAIVED are (a) a fresh insert when nothing was ever
 * attempted, or (b) FAILED -> WAIVED (a charge attempt that definitively failed, e.g. a
 * declined card, may still be waived afterward — see
 * BookingFinancialTransactionRepository.settleFailedAsWaived). PENDING -> WAIVED is deliberately
 * NOT a legal transition: PENDING means a Stripe call is in flight right now, and racing it with
 * a waive could leave the row saying WAIVED while Stripe independently succeeds a moment later —
 * the waiver caller must instead fail with a "charge in progress, retry shortly" conflict.
 */
export const bookingFinancialTransactionStatuses = [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "WAIVED",
] as const;
export type BookingFinancialTransactionStatus =
  (typeof bookingFinancialTransactionStatuses)[number];
