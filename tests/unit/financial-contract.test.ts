import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  calculateFirstUpfrontCents,
  type FinancialContract,
  findFinancialContractInvariantViolation,
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
  const base = (): FinancialContract => ({
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

  it.each<[keyof FinancialContract, Partial<FinancialContract>]>([
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

describe("P2 — Financial Contract V3 (business-funded booking-price promo)", () => {
  const promoId = new Types.ObjectId("eeeeeeeeeeeeeeeeeeeeeeee");
  // €100 base, 20% promo -> €80 discounted basis, FIRST 20% of €80 = €16, travel €15 -> €95.
  const v3 = (): FinancialContract => ({
    version: 3,
    productKind: "NORMAL_BOOKING",
    classification: "FIRST",
    idempotencyKey: "key-1",
    bookingId: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
    customerUserId: new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"),
    businessId: new Types.ObjectId("cccccccccccccccccccccccc"),
    businessClientId: new Types.ObjectId("dddddddddddddddddddddddd"),
    currency: "EUR",
    promoEligibleBaseCents: 10_000,
    promoDiscountCents: 2_000,
    eligibleBasisCents: 8_000,
    requiredUpfrontCents: calculateFirstUpfrontCents(8_000),
    onlineChargeCents: 1_600,
    travelFeeCents: 1_500,
    bookingTotalCents: 9_500,
    upfrontLedgerType: "PLATFORM_FEE",
    promo: {
      promoId,
      normalizedCode: "TWENTY",
      type: "PERCENTAGE",
      value: 20,
      fundingOwner: "BUSINESS",
    },
  });

  it("the spec example is internally consistent (FIRST receives the discounted basis)", () => {
    expect(v3().requiredUpfrontCents).toBe(1_600);
    expect(findFinancialContractInvariantViolation(v3())).toBeUndefined();
  });

  it.each<[string, Partial<FinancialContract>]>([
    ["upfront − promo charged online (pre-P2 arithmetic)", { onlineChargeCents: 0 }],
    ["discount exceeds the base", { promoDiscountCents: 10_001, eligibleBasisCents: -1 }],
    ["basis not base − discount", { eligibleBasisCents: 8_100 }],
    ["travel inside the promo base", { promoEligibleBaseCents: 11_500, eligibleBasisCents: 9_500 }],
    ["total not basis + travel", { bookingTotalCents: 11_500 }],
    ["missing promo base", { promoEligibleBaseCents: undefined }],
    ["discount without a frozen promo identity", { promo: undefined }],
    [
      "package contract on V3",
      { productKind: "PACKAGE_PURCHASE", packageBundlePriceCents: 10_000 },
    ],
    [
      "Bookly-funded V3 promo",
      { promo: { ...v3().promo, fundingOwner: "BOOKLY" } as unknown as FinancialContract["promo"] },
    ],
  ])("rejects a V3 contract with %s", (_label, change) => {
    expect(findFinancialContractInvariantViolation({ ...v3(), ...change })).toBeDefined();
  });

  it("a V2 contract keeps its legacy arithmetic and may never carry P2 promo terms", () => {
    const v2: FinancialContract = {
      ...v3(),
      version: 2,
      promoEligibleBaseCents: undefined,
      promo: undefined,
      eligibleBasisCents: 10_000,
      requiredUpfrontCents: 2_000,
      promoDiscountCents: 500,
      onlineChargeCents: 1_500,
      bookingTotalCents: 11_500,
    };
    expect(findFinancialContractInvariantViolation(v2)).toBeUndefined();
    expect(
      findFinancialContractInvariantViolation({ ...v2, onlineChargeCents: 2_000 }),
    ).toBeDefined();
    expect(
      findFinancialContractInvariantViolation({ ...v2, promoEligibleBaseCents: 10_000 }),
    ).toBeDefined();
  });

  it.each<[string, Partial<FinancialContract>]>([
    ["promoEligibleBaseCents", { promoEligibleBaseCents: 10_100 }],
    ["promoDiscountCents", { promoDiscountCents: 2_020 }],
    ["eligibleBasisCents", { eligibleBasisCents: 7_980 }],
    ["requiredUpfrontCents", { requiredUpfrontCents: 1_596 }],
    ["onlineChargeCents", { onlineChargeCents: 1_596 }],
    ["promo", { promo: undefined }],
  ])("fails closed on a changed %s", (field, change) => {
    expect(findFinancialContractMismatch(v3(), { ...v3(), ...change })).toBe(field);
  });

  it.each<[string, Partial<NonNullable<FinancialContract["promo"]>>]>([
    ["promo.promoId", { promoId: new Types.ObjectId() }],
    ["promo.normalizedCode", { normalizedCode: "OTHER20" }],
    ["promo.type", { type: "FIXED" }],
    ["promo.value", { value: 20.004 }],
  ])("an identical discount from a different/edited promo still fails (%s)", (field, change) => {
    const candidate = {
      ...v3(),
      promo: { ...(v3().promo as NonNullable<FinancialContract["promo"]>), ...change },
    };
    // Same money terms, different promo identity.
    expect(findFinancialContractMismatch(v3(), candidate)).toBe(field);
  });

  it("a V2 operation never matches a V3 candidate", () => {
    expect(findFinancialContractMismatch({ ...v3(), version: 2 }, v3())).toBe("version");
  });
});

describe("P3 — RETURNING €0 contracts (no V4, no package V3, no tightened invariant)", () => {
  const ids = {
    bookingId: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
    customerUserId: new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"),
    businessId: new Types.ObjectId("cccccccccccccccccccccccc"),
    businessClientId: new Types.ObjectId("dddddddddddddddddddddddd"),
  };
  // €100 normal RETURNING (V3) and a €100 bundle + €40 add-on package RETURNING (V2).
  const normalReturning = (upfront: number): FinancialContract => ({
    version: 3,
    productKind: "NORMAL_BOOKING",
    classification: "RETURNING",
    idempotencyKey: "normal",
    ...ids,
    currency: "EUR",
    promoEligibleBaseCents: 10_000,
    promoDiscountCents: 0,
    eligibleBasisCents: 10_000,
    requiredUpfrontCents: upfront,
    onlineChargeCents: upfront,
    travelFeeCents: 0,
    bookingTotalCents: 10_000,
    upfrontLedgerType: "DEPOSIT",
  });
  const packageReturning = (upfront: number): FinancialContract => ({
    version: 2,
    productKind: "PACKAGE_PURCHASE",
    classification: "RETURNING",
    idempotencyKey: "package",
    ...ids,
    currency: "EUR",
    eligibleBasisCents: 14_000,
    requiredUpfrontCents: upfront,
    promoDiscountCents: 0,
    onlineChargeCents: upfront,
    travelFeeCents: 0,
    packageBundlePriceCents: 10_000,
    bookingTotalCents: 14_000,
    upfrontLedgerType: "DEPOSIT",
  });

  it("a P3 normal RETURNING V3 contract with 0/0 is valid", () => {
    expect(findFinancialContractInvariantViolation(normalReturning(0))).toBeUndefined();
  });

  it("a P3 package RETURNING V2 contract with 0/0 is valid", () => {
    expect(findFinancialContractInvariantViolation(packageReturning(0))).toBeUndefined();
  });

  it("pre-P3 RETURNING contracts with a deposit stay valid and readable (both versions)", () => {
    expect(findFinancialContractInvariantViolation(normalReturning(2_000))).toBeUndefined();
    expect(findFinancialContractInvariantViolation(packageReturning(2_800))).toBeUndefined();
  });

  it("a package purchase can never be expressed as a V3 contract", () => {
    expect(
      findFinancialContractInvariantViolation({ ...packageReturning(0), version: 3 }),
    ).toBeDefined();
  });

  it("a pre-P3 deposit contract never matches its P3 €0 candidate (fail closed, never repriced)", () => {
    expect(findFinancialContractMismatch(normalReturning(2_000), normalReturning(0))).toBe(
      "requiredUpfrontCents",
    );
    expect(findFinancialContractMismatch(packageReturning(2_800), packageReturning(0))).toBe(
      "requiredUpfrontCents",
    );
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
