import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { packagePurchaseBodySchema } from "../../src/modules/booking/booking.schema.js";
import {
  FINANCIAL_CONTRACT_V2,
  type FinancialContract,
  findFinancialContractInvariantViolation,
} from "../../src/modules/booking/financial-contract.js";
import { batchFinancialContractSchema } from "../../src/modules/booking/package-batch-completion-contract.js";
import { packageCheckoutIntentSchema } from "../../src/modules/booking/package-checkout-contract.js";
import { promoScopes } from "../../src/modules/promo/promo.types.js";

/**
 * Promo Codes stay NORMAL-booking-only until the Owner approves a package promo policy
 * (docs/PACKAGE-PROMO-POLICY-DECISIONS.md). These guards fail loudly if any package path starts
 * accepting or carrying a promo without that decision.
 */
describe("package purchase promo codes remain disabled", () => {
  it("no package request schema accepts a promoCode", () => {
    expect(Object.keys(packagePurchaseBodySchema.shape)).not.toContain("promoCode");
    expect(Object.keys(packageCheckoutIntentSchema.shape)).not.toContain("promoCode");
  });

  it("a First-Class batch financial contract carries a zero promo discount only", () => {
    const field = batchFinancialContractSchema.shape.promoDiscountCents;
    expect(field.safeParse(0).success).toBe(true);
    expect(field.safeParse(1).success).toBe(false);
  });

  it("promos have no package-eligibility scope (no existing promo is reinterpreted)", () => {
    expect([...promoScopes].sort()).toEqual([
      "ALL_BOOKINGS",
      "ALL_FIRST_BOOKINGS",
      "SELECTED_BUSINESSES",
    ]);
  });

  it("the financial contract invariants refuse promo terms on a package (V2) contract", () => {
    const packageContract = {
      version: FINANCIAL_CONTRACT_V2,
      productKind: "PACKAGE_PURCHASE",
      classification: "FIRST",
      upfrontLedgerType: "PLATFORM_FEE",
      idempotencyKey: "k",
      bookingId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      businessId: new Types.ObjectId(),
      businessClientId: new Types.ObjectId(),
      currency: "EUR",
      eligibleBasisCents: 15_000,
      packageBundlePriceCents: 15_000,
      requiredUpfrontCents: 3_000,
      promoDiscountCents: 0,
      onlineChargeCents: 3_000,
      travelFeeCents: 0,
      bookingTotalCents: 15_000,
    } as unknown as FinancialContract;
    expect(findFinancialContractInvariantViolation(packageContract)).toBeUndefined();
    expect(
      findFinancialContractInvariantViolation({
        ...packageContract,
        promoEligibleBaseCents: 15_000,
      } as FinancialContract),
    ).toBe("A V2 contract never carries P2 promo terms");
  });
});
