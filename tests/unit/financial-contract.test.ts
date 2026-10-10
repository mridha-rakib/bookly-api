import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  calculateFirstUpfrontCents,
  type FinancialContractV2,
  findFinancialContractMismatch,
} from "../../src/modules/booking/financial-contract.js";
import type { BusinessClientDocument } from "../../src/modules/client/client.model.js";
import { FinancialRelationshipService } from "../../src/modules/client/financial-relationship.service.js";

/** The legacy (pre-P1, still-current RETURNING) deposit formula, reproduced verbatim from
 * BookingService.calculateBookingDepositCents for an equivalence check. */
const legacyDepositCents = (basis: number): number =>
  Math.min(Math.max(Math.round(basis * 0.2), 500), 3500);

describe("P1 canonical FIRST upfront formula (integer cents)", () => {
  it.each([
    [10_000, 2_000], // €100 -> 20% = €20
    [30_000, 3_500], // €300 -> capped at €35
    [1_000, 500], // €10 -> €5 minimum
    [300, 300], // €3 -> capped to the basis, NOT €5
    [0, 0], // €0 -> €0, never an invented €5
    [500, 500], // basis exactly €5
    [1, 1],
    [499, 499],
  ])("basis %i -> upfront %i", (basis, expected) => {
    expect(calculateFirstUpfrontCents(basis)).toBe(expected);
  });

  it.each([
    [1_247, 500], // 249.4 -> floor applies
    [2_502, 500], // 500.4 -> 500
    [2_503, 501], // 500.6 -> 501 (round half up never meets an exact .5 for integer cents)
    [10_002, 2_000], // 2000.4 -> 2000
    [10_003, 2_001], // 2000.6 -> 2001
    [17_497, 3_499], // 3499.4 -> 3499
    [17_498, 3_500], // 3499.6 -> 3500
    [17_503, 3_500], // above the cap
  ])("rounding boundary: basis %i -> %i", (basis, expected) => {
    expect(calculateFirstUpfrontCents(basis)).toBe(expected);
  });

  it("equals min(basis, legacy deposit) for every basis — only the cap-to-basis rule differs", () => {
    for (let basis = 0; basis <= 60_000; basis += 1) {
      const expected = basis === 0 ? 0 : Math.min(basis, legacyDepositCents(basis));
      if (calculateFirstUpfrontCents(basis) !== expected) {
        throw new Error(`mismatch at basis ${basis}`);
      }
    }
  });

  it("never exceeds the eligible basis and never exceeds €35", () => {
    for (let basis = 0; basis <= 60_000; basis += 7) {
      const upfront = calculateFirstUpfrontCents(basis);
      expect(upfront).toBeLessThanOrEqual(basis);
      expect(upfront).toBeLessThanOrEqual(3_500);
      expect(Number.isInteger(upfront)).toBe(true);
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid basis %s", (basis) => {
    expect(() => calculateFirstUpfrontCents(basis)).toThrow();
  });
});

describe("Financial Contract V2 immutability", () => {
  const base = (): FinancialContractV2 => ({
    version: 2,
    productKind: "NORMAL_BOOKING",
    classification: "FIRST",
    idempotencyKey: "key-1",
    bookingId: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
    customerUserId: new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"),
    businessId: new Types.ObjectId("cccccccccccccccccccccccc"),
    businessClientId: new Types.ObjectId("dddddddddddddddddddddddd"),
    currency: "EUR",
    eligibleBasisCents: 10_000,
    requiredUpfrontCents: 2_000,
    promoDiscountCents: 0,
    onlineChargeCents: 2_000,
    travelFeeCents: 0,
    bookingTotalCents: 10_000,
    upfrontLedgerType: "PLATFORM_FEE",
  });

  it("accepts an identical resumed contract", () => {
    expect(findFinancialContractMismatch(base(), base())).toBeUndefined();
  });

  it.each<[keyof FinancialContractV2, Partial<FinancialContractV2>]>([
    ["classification", { classification: "RETURNING" }],
    ["productKind", { productKind: "PACKAGE_PURCHASE" }],
    ["customerUserId", { customerUserId: new Types.ObjectId() }],
    ["businessId", { businessId: new Types.ObjectId() }],
    ["eligibleBasisCents", { eligibleBasisCents: 10_100 }],
    ["requiredUpfrontCents", { requiredUpfrontCents: 2_020 }],
    ["onlineChargeCents", { onlineChargeCents: 1_000 }],
    ["upfrontLedgerType", { upfrontLedgerType: "DEPOSIT" }],
    ["packageBundlePriceCents", { packageBundlePriceCents: 10_000 }],
  ])("fails closed on a changed %s", (field, change) => {
    expect(findFinancialContractMismatch(base(), { ...base(), ...change })).toBe(field);
  });
});

describe("relationship preview estimate (read-only)", () => {
  const service = new FinancialRelationshipService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const client = (fields: Partial<BusinessClientDocument>) => fields as BusinessClientDocument;

  it("treats no client and a legacy unactivated client as FIRST", () => {
    expect(service.peekClassification(null)).toBe("FIRST");
    expect(service.peekClassification(client({}))).toBe("FIRST");
  });

  it("treats a legacy activated client as RETURNING", () => {
    expect(service.peekClassification(client({ activatedAt: new Date() }))).toBe("RETURNING");
  });

  it("lets v2 state override activatedAt — no split-brain", () => {
    const v2 = (state: "ELIGIBLE" | "FIRST_PENDING" | "CONSUMED" | "RESTORATION_PENDING") =>
      ({
        version: 2,
        state,
        revision: 1,
        initializedFrom: "LEGACY_UNACTIVATED",
        stateChangedAt: new Date(),
      }) as const;
    expect(
      service.peekClassification(
        client({ activatedAt: new Date(), financialRelationship: v2("ELIGIBLE") }),
      ),
    ).toBe("FIRST");
    expect(service.peekClassification(client({ financialRelationship: v2("CONSUMED") }))).toBe(
      "RETURNING",
    );
    // A pending first operation is not yet consumed — never presented as RETURNING.
    expect(service.peekClassification(client({ financialRelationship: v2("FIRST_PENDING") }))).toBe(
      "FIRST",
    );
    expect(
      service.peekClassification(client({ financialRelationship: v2("RESTORATION_PENDING") })),
    ).toBe("FIRST");
  });
});
