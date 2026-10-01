export type ProcessingFeeAllocationInput = {
  actualFeeCents: number;
  preTaxChargeCents: number;
  taxCents: number;
  chargedAmountCents: number;
};

export type ProcessingFeeAllocation = {
  preTaxFeeCents: number;
  taxFeeCents: number;
};

const requireNonNegativeSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
};

/**
 * Allocates Stripe's actual aggregate processing fee between pre-tax principal and VAT using
 * exact integer arithmetic. Tax receives round-half-up(actualFee * tax / chargedAmount); the
 * pre-tax share receives the remainder, so conservation is structural rather than a second
 * independently-rounded calculation.
 *
 * This is intentionally dark in C1: no production fee-recording path calls it yet.
 */
export const allocateProcessingFee = (
  input: ProcessingFeeAllocationInput,
): ProcessingFeeAllocation => {
  requireNonNegativeSafeInteger("actualFeeCents", input.actualFeeCents);
  requireNonNegativeSafeInteger("preTaxChargeCents", input.preTaxChargeCents);
  requireNonNegativeSafeInteger("taxCents", input.taxCents);
  requireNonNegativeSafeInteger("chargedAmountCents", input.chargedAmountCents);

  if (input.chargedAmountCents <= 0) {
    throw new RangeError("chargedAmountCents must be positive");
  }
  if (input.preTaxChargeCents + input.taxCents !== input.chargedAmountCents) {
    throw new RangeError("preTaxChargeCents + taxCents must equal chargedAmountCents");
  }

  if (input.taxCents === 0 || input.actualFeeCents === 0) {
    return { preTaxFeeCents: input.actualFeeCents, taxFeeCents: 0 };
  }

  const numerator = BigInt(input.actualFeeCents) * BigInt(input.taxCents);
  const denominator = BigInt(input.chargedAmountCents);
  const taxFee = (2n * numerator + denominator) / (2n * denominator);
  const taxFeeCents = Number(taxFee);
  const preTaxFeeCents = input.actualFeeCents - taxFeeCents;

  return { preTaxFeeCents, taxFeeCents };
};

export type ProcessingFeeComponent = "pretax" | "tax";

/** Deterministic keys for the future two-row fee posting. The existing live key remains
 * untouched until split allocation is activated. */
export const processingFeeIdempotencyKey = (
  paymentIntentId: string,
  component: ProcessingFeeComponent,
): string => `processing-fee:${component}:${paymentIntentId}`;
