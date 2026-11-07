import { describe, expect, it } from "vitest";

import {
  buildPaymentIntentMetadata,
  parsePaymentIntentMetadata,
} from "../../src/modules/payment/payment-intent-metadata.js";

const ids = {
  bookingId: "0123456789abcdef01234567",
  businessId: "1123456789abcdef01234567",
  businessClientId: "2123456789abcdef01234567",
};

const build = () =>
  buildPaymentIntentMetadata({
    ...ids,
    purpose: "BOOKING_DEPOSIT",
    preTaxChargeCents: 2000,
    taxCents: 380,
    chargedAmountCents: 2000,
    taxCalculationId: "taxcalc_test_1",
    taxMode: "PRE_ACTIVATION",
  });

describe("PaymentIntent metadata contract", () => {
  it("round-trips the complete pre-activation contract without changing the live PI amount", () => {
    expect(parsePaymentIntentMetadata(build())).toMatchObject({
      ...ids,
      purpose: "BOOKING_DEPOSIT",
      taxMode: "PRE_ACTIVATION",
      preTaxChargeCents: 2000,
      taxCents: 380,
      chargedAmountCents: 2000,
    });
  });

  it("treats an unversioned legacy PI as compatible rather than manufacturing a tax contract", () => {
    expect(parsePaymentIntentMetadata({ bookingId: ids.bookingId })).toBeUndefined();
  });

  it.each([
    ["bookingId", ""],
    ["businessId", "not-an-object-id"],
    ["preTaxChargeCents", "20.5"],
    ["taxCents", "-1"],
    ["purpose", "UNKNOWN"],
  ])("fails closed for malformed %s", (key, value) => {
    expect(() => parsePaymentIntentMetadata({ ...build(), [key]: value })).toThrow();
  });

  it("records a Stripe calculation as CALCULATED and informational VAT as not collected", () => {
    const metadata = build();
    expect(metadata).toMatchObject({
      taxStatus: "CALCULATED",
      taxCalculationId: "taxcalc_test_1",
      taxCents: "380",
      taxCollectedCents: "0",
      chargedAmountCents: "2000",
    });
    expect(metadata["taxNotCalculatedReason"]).toBeUndefined();
    expect(parsePaymentIntentMetadata(metadata)).toMatchObject({
      taxStatus: "CALCULATED",
      taxCollectedCents: 0,
    });
  });

  it("marks an uncalculated fee charge NOT_CALCULATED with its reason, never as zero VAT", () => {
    const metadata = buildPaymentIntentMetadata({
      ...ids,
      purpose: "CANCELLATION_FEE",
      preTaxChargeCents: 3000,
      taxCents: 0,
      chargedAmountCents: 3000,
      taxMode: "PRE_ACTIVATION",
      taxNotCalculatedReason: "BUSINESS_SUPPLY_TAX_CONTEXT_UNAVAILABLE",
    });
    expect(metadata).toMatchObject({
      taxStatus: "NOT_CALCULATED",
      taxNotCalculatedReason: "BUSINESS_SUPPLY_TAX_CONTEXT_UNAVAILABLE",
      taxCollectedCents: "0",
      chargedAmountCents: "3000",
    });
    expect(parsePaymentIntentMetadata(metadata)).toMatchObject({
      taxStatus: "NOT_CALCULATED",
      taxNotCalculatedReason: "BUSINESS_SUPPLY_TAX_CONTEXT_UNAVAILABLE",
    });
  });

  it("refuses a tax amount without a Stripe calculation, and a reason on a calculated tax", () => {
    const base = {
      ...ids,
      purpose: "NO_SHOW_FEE" as const,
      preTaxChargeCents: 3000,
      chargedAmountCents: 3000,
      taxMode: "PRE_ACTIVATION" as const,
    };
    expect(() => buildPaymentIntentMetadata({ ...base, taxCents: 570 })).toThrow(
      "taxCalculationId",
    );
    expect(() =>
      buildPaymentIntentMetadata({
        ...base,
        taxCents: 570,
        taxCalculationId: "taxcalc_1",
        taxNotCalculatedReason: "TAX_CALCULATION_UNAVAILABLE",
      }),
    ).toThrow("not-calculated reason");
  });

  it("keeps older PaymentIntents without a tax status readable as unknown (not zero)", () => {
    const legacy = build();
    for (const key of ["taxStatus", "taxCollectedCents", "taxNotCalculatedReason"])
      Reflect.deleteProperty(legacy, key);
    const parsed = parsePaymentIntentMetadata(legacy);
    expect(parsed?.taxStatus).toBeUndefined();
    expect(parsed?.taxCollectedCents).toBeUndefined();
  });

  it.each([
    ["unknown status", { taxStatus: "MAYBE" }],
    ["CALCULATED without a calculation", { taxStatus: "CALCULATED", taxCalculationId: "" }],
    ["NOT_CALCULATED with a tax amount", { taxStatus: "NOT_CALCULATED", taxCalculationId: "" }],
    ["collected VAT on a pre-activation charge", { taxCollectedCents: "380" }],
    ["unknown reason", { taxNotCalculatedReason: "GUESSED" }],
  ])("fails closed for inconsistent tax metadata: %s", (_name, override) => {
    const metadata: Record<string, string> = { ...build(), ...override };
    if (metadata["taxCalculationId"] === "") Reflect.deleteProperty(metadata, "taxCalculationId");
    expect(() => parsePaymentIntentMetadata(metadata)).toThrow();
  });

  it("enforces the future VAT-inclusive total invariant", () => {
    expect(() =>
      buildPaymentIntentMetadata({
        ...ids,
        purpose: "BOOKING_DEPOSIT",
        preTaxChargeCents: 2000,
        taxCents: 380,
        chargedAmountCents: 2000,
        taxMode: "VAT_INCLUSIVE",
      }),
    ).toThrow("chargedAmountCents");
  });
});
