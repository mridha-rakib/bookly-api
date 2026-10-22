export type PackagePricingItem = {
  includedSessions: number;
  referenceUnitPriceCents?: number | undefined;
};

export type PackagePricingSummary = {
  totalSessions: number;
  referenceTotalCents: number | null;
  savingsCents: number | null;
  discountPercent: number | null;
};

const safeNumber = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Package total exceeds safe integer range");
  return Number(value);
};

const requireInteger = (value: number, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`Expected a safe integer >= ${minimum}`);
  }
};

/** Comparison values only. No live Service prices, discounts or payment allocations enter here. */
export const calculatePackagePricing = (
  items: readonly PackagePricingItem[],
  bundlePriceCents?: number,
): PackagePricingSummary => {
  let total = 0n;
  let reference = 0n;
  let complete = items.length > 0;
  for (const item of items) {
    requireInteger(item.includedSessions, 1);
    total += BigInt(item.includedSessions);
    if (item.referenceUnitPriceCents === undefined) complete = false;
    else {
      requireInteger(item.referenceUnitPriceCents, 1);
      reference += BigInt(item.referenceUnitPriceCents) * BigInt(item.includedSessions);
    }
  }
  const totalSessions = safeNumber(total);
  // Even a partial draft cannot hide overflow in its supplied reference values.
  const suppliedReference = safeNumber(reference);
  if (bundlePriceCents !== undefined) requireInteger(bundlePriceCents, 0);
  const referenceTotalCents = complete ? suppliedReference : null;
  if (referenceTotalCents === null || bundlePriceCents === undefined) {
    return { totalSessions, referenceTotalCents, savingsCents: null, discountPercent: null };
  }
  if (bundlePriceCents > referenceTotalCents)
    throw new RangeError("Bundle price cannot exceed reference total");
  const savings = reference - BigInt(bundlePriceCents);
  // Round half-up to hundredths of a percent with exact intermediates.
  const basisPoints = (savings * 20_000n + reference) / (2n * reference);
  return {
    totalSessions,
    referenceTotalCents,
    savingsCents: Number(savings),
    discountPercent: Number(basisPoints) / 100,
  };
};
