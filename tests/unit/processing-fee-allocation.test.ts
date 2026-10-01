import { describe, expect, it } from "vitest";

import {
  allocateProcessingFee,
  processingFeeIdempotencyKey,
} from "../../src/modules/payment/processing-fee-allocation.js";

describe("VAT processing-fee allocation foundation", () => {
  it("allocates the worked example with exact round-half-up cents", () => {
    expect(
      allocateProcessingFee({
        actualFeeCents: 100,
        preTaxChargeCents: 2_000,
        taxCents: 380,
        chargedAmountCents: 2_380,
      }),
    ).toEqual({ preTaxFeeCents: 84, taxFeeCents: 16 });
  });

  it("conserves every cent across representative integer inputs", () => {
    for (let actualFeeCents = 0; actualFeeCents <= 250; actualFeeCents += 1) {
      for (const [preTaxChargeCents, taxCents] of [
        [1, 0],
        [1, 1],
        [9, 1],
        [1, 9],
        [2_000, 380],
        [3_500, 665],
      ] as const) {
        const allocation = allocateProcessingFee({
          actualFeeCents,
          preTaxChargeCents,
          taxCents,
          chargedAmountCents: preTaxChargeCents + taxCents,
        });
        expect(allocation.preTaxFeeCents + allocation.taxFeeCents).toBe(actualFeeCents);
      }
    }
  });

  it("assigns the entire fee to pre-tax when tax is zero", () => {
    expect(
      allocateProcessingFee({
        actualFeeCents: 87,
        preTaxChargeCents: 2_000,
        taxCents: 0,
        chargedAmountCents: 2_000,
      }),
    ).toEqual({ preTaxFeeCents: 87, taxFeeCents: 0 });
  });

  it.each([
    {
      name: "small tax ratio",
      input: { actualFeeCents: 1, preTaxChargeCents: 99, taxCents: 1, chargedAmountCents: 100 },
      expected: { preTaxFeeCents: 1, taxFeeCents: 0 },
    },
    {
      name: "exact half rounds to tax",
      input: { actualFeeCents: 1, preTaxChargeCents: 1, taxCents: 1, chargedAmountCents: 2 },
      expected: { preTaxFeeCents: 0, taxFeeCents: 1 },
    },
    {
      name: "large tax ratio",
      input: { actualFeeCents: 1, preTaxChargeCents: 1, taxCents: 99, chargedAmountCents: 100 },
      expected: { preTaxFeeCents: 0, taxFeeCents: 1 },
    },
  ])("handles one-cent edge: $name", ({ input, expected }) => {
    expect(allocateProcessingFee(input)).toEqual(expected);
  });

  it("fails closed when the declared total is inconsistent", () => {
    expect(() =>
      allocateProcessingFee({
        actualFeeCents: 100,
        preTaxChargeCents: 2_000,
        taxCents: 380,
        chargedAmountCents: 2_379,
      }),
    ).toThrow(/must equal chargedAmountCents/);
  });

  it("rejects unsafe, fractional, negative, and zero-total inputs", () => {
    expect(() =>
      allocateProcessingFee({
        actualFeeCents: 1.5,
        preTaxChargeCents: 1,
        taxCents: 0,
        chargedAmountCents: 1,
      }),
    ).toThrow(/safe integer/);
    expect(() =>
      allocateProcessingFee({
        actualFeeCents: 1,
        preTaxChargeCents: -1,
        taxCents: 1,
        chargedAmountCents: 0,
      }),
    ).toThrow(/non-negative/);
    expect(() =>
      allocateProcessingFee({
        actualFeeCents: 0,
        preTaxChargeCents: 0,
        taxCents: 0,
        chargedAmountCents: 0,
      }),
    ).toThrow(/must be positive/);
  });

  it("provides deterministic, distinct keys for the future two fee rows", () => {
    expect(processingFeeIdempotencyKey("pi_123", "pretax")).toBe("processing-fee:pretax:pi_123");
    expect(processingFeeIdempotencyKey("pi_123", "tax")).toBe("processing-fee:tax:pi_123");
    expect(processingFeeIdempotencyKey("pi_123", "pretax")).not.toBe(
      processingFeeIdempotencyKey("pi_123", "tax"),
    );
  });
});
