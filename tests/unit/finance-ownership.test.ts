import { describe, expect, it } from "vitest";

import type { OwnershipAggregateBucket } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import {
  ALL_OWNERSHIP_RELEVANT_TYPES,
  BUSINESS_PAYABLE_TYPES,
  classifyProcessingFeeOwner,
  classifySourceOwner,
  combineBooklyOwnedBuckets,
  combineBusinessOwnedBuckets,
} from "../../src/modules/finance/finance-ownership.js";

const bucket = (
  type: OwnershipAggregateBucket["type"],
  totalCents: number,
  sourceType: string | null = null,
): OwnershipAggregateBucket => ({ type, sourceType, totalCents, count: 1 });

describe("Cyprus VAT ownership foundation", () => {
  it("keeps TAX_LIABILITY and TAX_REVERSAL principal outside both revenue owners", () => {
    const buckets = [bucket("TAX_LIABILITY", 380), bucket("TAX_REVERSAL", 380)];

    expect(combineBusinessOwnedBuckets(buckets)).toEqual({
      grossCents: 0,
      processingFeesCents: 0,
      refundsCents: 0,
      netCents: 0,
      promoSubsidyCents: 0,
    });
    expect(combineBooklyOwnedBuckets(buckets)).toEqual({
      grossCents: 0,
      processingFeesCents: 0,
      refundsCents: 0,
      netCents: 0,
      promoSubsidyCents: 0,
    });
    expect(classifySourceOwner("TAX_LIABILITY")).toBe("UNKNOWN");
    expect(ALL_OWNERSHIP_RELEVANT_TYPES).not.toContain("TAX_LIABILITY");
    expect(ALL_OWNERSHIP_RELEVANT_TYPES).not.toContain("TAX_REVERSAL");
    expect(BUSINESS_PAYABLE_TYPES).not.toContain("TAX_LIABILITY");
    expect(BUSINESS_PAYABLE_TYPES).not.toContain("TAX_REVERSAL");
  });

  it("makes only the TAX_LIABILITY-sourced processing cost Bookly-borne", () => {
    const buckets = [bucket("PROCESSING_FEE", 16, "TAX_LIABILITY")];

    expect(classifyProcessingFeeOwner("TAX_LIABILITY")).toBe("BOOKLY");
    expect(combineBusinessOwnedBuckets(buckets).netCents).toBe(0);
    expect(combineBooklyOwnedBuckets(buckets)).toMatchObject({
      grossCents: 0,
      processingFeesCents: 16,
      netCents: -16,
    });
  });

  it("preserves existing first- and returning-booking ownership", () => {
    expect(
      combineBooklyOwnedBuckets([
        bucket("PLATFORM_FEE", 2_000),
        bucket("PROCESSING_FEE", 84, "PLATFORM_FEE"),
      ]),
    ).toMatchObject({ grossCents: 2_000, processingFeesCents: 84, netCents: 1_916 });

    expect(
      combineBusinessOwnedBuckets([
        bucket("DEPOSIT", 2_000),
        bucket("PROCESSING_FEE", 84, "DEPOSIT"),
      ]),
    ).toMatchObject({ grossCents: 2_000, processingFeesCents: 84, netCents: 1_916 });
  });
});
