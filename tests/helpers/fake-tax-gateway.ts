import { randomUUID } from "node:crypto";

import type {
  CalculateTaxInput,
  TaxCalculationResult,
  TaxGateway,
} from "../../src/modules/payment/tax.types.js";

/**
 * A deterministic, in-memory `TaxGateway` test double — no network calls, ever (same rationale as
 * FakePaymentGateway). Defaults to a configurable flat percentage (19% by default, matching
 * nothing in particular — the point is tests must assert against WHATEVER this fake returns,
 * never re-derive it via `amount * rate` themselves, exactly like production code must treat
 * Stripe's response as authoritative).
 */
export class FakeTaxGateway implements TaxGateway {
  public calls: CalculateTaxInput[] = [];
  private nextTaxCents: number | undefined;
  private nextTaxabilityReason: string | undefined;
  private nextError: Error | undefined;
  private percent = 0.19;

  /** Configure the exact tax amount the NEXT call returns (consumed once). */
  public queueNextTax(taxCents: number, taxabilityReason?: string): void {
    this.nextTaxCents = taxCents;
    this.nextTaxabilityReason = taxabilityReason;
  }

  /** Configure the NEXT call to reject (simulating a Stripe Tax API failure). Consumed once. */
  public queueNextFailure(error: Error): void {
    this.nextError = error;
  }

  public setPercent(percent: number): void {
    this.percent = percent;
  }

  public async calculateTax(input: CalculateTaxInput): Promise<TaxCalculationResult> {
    this.calls.push(input);

    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }

    const taxCents = this.nextTaxCents ?? Math.round(input.amountCents * this.percent);
    const taxabilityReason = this.nextTaxabilityReason ?? "standard_rated";
    this.nextTaxCents = undefined;
    this.nextTaxabilityReason = undefined;

    return {
      taxCalculationId: `taxcalc_fake_${randomUUID()}`,
      preTaxAmountCents: input.amountCents,
      taxCents,
      amountTotalCents: input.amountCents + taxCents,
      currency: "eur",
      taxabilityReason,
    };
  }
}
