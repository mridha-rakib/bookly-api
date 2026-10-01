/**
 * Checkpoint B (Cyprus VAT, compute-only) — the Tax-provider surface, mirroring this module's
 * existing `PaymentGateway` convention (payment.types.ts) so `CyprusTaxService` never imports the
 * `stripe` SDK directly and stays unit-testable against a deterministic fake (see
 * tests/helpers/fake-tax-gateway.ts), matching stripe-payment-gateway.ts's own "only file allowed
 * to import stripe directly" discipline — StripeTaxGateway is now that file's sibling for tax.
 */

export type CalculateTaxInput = {
  /** The exact amount actually being charged online, in cents — the canonical
   * `customerChargeNowCents` (post-clamp, post-promo). Never the pre-clamp deposit, never a full
   * booking/package total. */
  amountCents: number;
  /** A unique identifier for this calculation's line item — surfaced in Stripe's own tax
   * reports (bookingId at finalize time; a throwaway id at preview time). */
  reference: string;
  /** Passed through to Stripe as the Tax Calculation request's own Idempotency-Key, so a retried
   * call within the same logical booking attempt reuses the same calculation rather than minting
   * a new one — mirrors this codebase's existing PaymentIntent idempotency-key threading. Omit
   * for a read-only preview call, where there is no logical "attempt" to deduplicate against. */
  idempotencyKey?: string | undefined;
};

export type TaxCalculationResult = {
  /** Stripe's `tax.calculation` id — needed later (Checkpoint D) to create/reverse a Tax
   * Transaction. Not persisted anywhere in this checkpoint. */
  taxCalculationId: string;
  /** The exact amount tax was calculated on (should equal the input `amountCents`). */
  preTaxAmountCents: number;
  /** Stripe-computed tax amount, in cents. Never derived by application code. */
  taxCents: number;
  /** Stripe's own `amount_total` (pre-tax + tax) — used verbatim, never re-summed locally. */
  amountTotalCents: number;
  currency: string;
  /** The `taxability_reason` of the (first/primary) tax breakdown line, when Stripe returned one
   * — lets the caller distinguish "genuinely zero-rated" from "not_collecting" (missing
   * registration) for a positive charge. */
  taxabilityReason?: string;
};

export interface TaxGateway {
  calculateTax(input: CalculateTaxInput): Promise<TaxCalculationResult>;
}
