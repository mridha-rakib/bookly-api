import { describe, expect, it } from "vitest";

import { calculatePackagePricing } from "../../src/modules/packages/package-pricing.js";

describe("Package reference pricing (comparison only)", () => {
  it("sums real per-item cent references independently of Service prices", () => {
    expect(
      calculatePackagePricing(
        [
          { includedSessions: 3, referenceUnitPriceCents: 6000 },
          { includedSessions: 2, referenceUnitPriceCents: 4000 },
        ],
        20000,
      ),
    ).toEqual({
      totalSessions: 5,
      referenceTotalCents: 26000,
      savingsCents: 6000,
      discountPercent: 23.08,
    });
  });
  it.each([
    [0, 100, 100],
    [100, 0, 0],
    [99, 1, 1],
  ])("bundle %i against 100 cents has savings %i / percent %i", (bundle, savings, percentage) => {
    expect(
      calculatePackagePricing([{ includedSessions: 1, referenceUnitPriceCents: 100 }], bundle),
    ).toMatchObject({ savingsCents: savings, discountPercent: percentage });
  });
  it("rounds exact percentage ties half-up", () => {
    expect(
      calculatePackagePricing([{ includedSessions: 1, referenceUnitPriceCents: 20000 }], 19999)
        .discountPercent,
    ).toBe(0.01);
    expect(
      calculatePackagePricing([{ includedSessions: 1, referenceUnitPriceCents: 3 }], 2)
        .discountPercent,
    ).toBe(33.33);
  });
  it("uses exact overflow-safe intermediates near the safe-integer boundary", () => {
    expect(
      calculatePackagePricing(
        [{ includedSessions: 1, referenceUnitPriceCents: Number.MAX_SAFE_INTEGER }],
        0,
      ).discountPercent,
    ).toBe(100);
  });
  it.each([
    [[{ includedSessions: 1, referenceUnitPriceCents: 0 }], 0],
    [[{ includedSessions: 1, referenceUnitPriceCents: 10 }], 11],
    [[{ includedSessions: 2, referenceUnitPriceCents: Number.MAX_SAFE_INTEGER }], 0],
    [[{ includedSessions: Number.MAX_SAFE_INTEGER }, { includedSessions: 1 }], undefined],
    [[{ includedSessions: 0 }], 0],
    [[{ includedSessions: 1.5 }], 0],
    [[{ includedSessions: 1 }], 1.1],
    [[{ includedSessions: 1 }], Number.NaN],
  ] as const)("rejects invalid or overflowing input %#", (items, bundle) => {
    expect(() => calculatePackagePricing(items, bundle)).toThrow(RangeError);
  });
  it("does not invent totals/percentages for incomplete drafts", () => {
    expect(calculatePackagePricing([], 0)).toEqual({
      totalSessions: 0,
      referenceTotalCents: null,
      savingsCents: null,
      discountPercent: null,
    });
    expect(calculatePackagePricing([{ includedSessions: 2 }], 100)).toMatchObject({
      totalSessions: 2,
      referenceTotalCents: null,
      discountPercent: null,
    });
    expect(
      calculatePackagePricing([{ includedSessions: 1, referenceUnitPriceCents: 100 }]),
    ).toMatchObject({ referenceTotalCents: 100, savingsCents: null, discountPercent: null });
  });
});
