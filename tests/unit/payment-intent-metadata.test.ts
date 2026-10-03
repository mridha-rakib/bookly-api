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
