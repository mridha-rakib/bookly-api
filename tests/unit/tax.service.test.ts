import { beforeEach, describe, expect, it } from "vitest";
import { TaxError } from "../../src/modules/payment/tax.errors.js";
import { CyprusTaxService } from "../../src/modules/payment/tax.service.js";
import { FakeTaxGateway } from "../helpers/fake-tax-gateway.js";

describe("CyprusTaxService (Checkpoint B — compute-only)", () => {
  let gateway: FakeTaxGateway;
  let service: CyprusTaxService;

  beforeEach(() => {
    gateway = new FakeTaxGateway();
    service = new CyprusTaxService(gateway);
  });

  // A. Normal booking — the pre-tax charge is €20; the service must respect whatever Stripe's
  // Tax Calculation actually returns, never a locally-multiplied 20 * 0.19.
  it("respects the Stripe-returned tax amount rather than computing it locally", async () => {
    gateway.queueNextTax(380); // Stripe says €3.80 tax on a €20 charge — could be any number
    const result = await service.computeForCharge({ amountCents: 2000, reference: "booking-a" });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.amountCents).toBe(2000);
    expect(result.preTaxAmountCents).toBe(2000);
    expect(result.taxCents).toBe(380);
    // dueNowWithTaxCents must be Stripe's own amount_total, not a locally re-summed value.
    expect(result.dueNowWithTaxCents).toBe(2380);
    expect(result.taxCalculationId).toBeDefined();
  });

  // B. Maximum deposit clamp — whatever canonical amount the caller passes IS the taxable basis;
  // this proves the service never re-derives or caps the amount itself (that already happened
  // upstream in BookingCreationService before this is ever called).
  it("sends the caller's exact amount as the taxable basis (post-clamp, e.g. the €35 cap)", async () => {
    gateway.queueNextTax(665);
    const result = await service.computeForCharge({ amountCents: 3500, reference: "booking-b" });

    expect(gateway.calls[0]?.amountCents).toBe(3500);
    expect(result.preTaxAmountCents).toBe(3500);
  });

  // C. Promo — the caller passes the POST-promo `customerChargeNowCents` (€15), never the
  // pre-promo deposit (€20); this service must never see or reconstruct the pre-promo figure.
  it("taxes the post-promo charge amount, never a pre-promo figure", async () => {
    gateway.queueNextTax(285);
    const result = await service.computeForCharge({ amountCents: 1500, reference: "booking-c" });

    expect(gateway.calls[0]?.amountCents).toBe(1500);
    expect(result.preTaxAmountCents).toBe(1500);
  });

  // D. Package — the basis is whatever the caller passes as the actual online package charge,
  // never a full bundle total the service has no knowledge of.
  it("taxes exactly the amount passed in, regardless of a larger bundle/package total", async () => {
    gateway.queueNextTax(608);
    const result = await service.computeForCharge({ amountCents: 3200, reference: "package-d" });

    expect(gateway.calls[0]?.amountCents).toBe(3200);
    expect(result.dueNowWithTaxCents).toBe(3200 + 608);
  });

  // E/F. Add-ons and travel fee never introduce a separate VAT basis — this service has no
  // add-on/travel-specific logic at all; it only ever sees ONE final `amountCents` figure,
  // proving no expanded basis is invented here.
  it("has no add-on- or travel-fee-specific basis logic — one amount in, one amount taxed", async () => {
    gateway.queueNextTax(30);
    await service.computeForCharge({ amountCents: 500, reference: "extras-e-f" });

    expect(gateway.calls[0]?.amountCents).toBe(500);
  });

  // G. Zero charge — no Stripe Tax API call at all, taxCents = 0, dueNow = 0.
  it("skips the Stripe Tax API entirely for a zero-amount charge", async () => {
    const result = await service.computeForCharge({ amountCents: 0, reference: "booking-g" });

    expect(gateway.calls).toHaveLength(0);
    expect(result).toEqual({ preTaxAmountCents: 0, taxCents: 0, dueNowWithTaxCents: 0 });
    expect(result.taxCalculationId).toBeUndefined();
  });

  // H. Stripe Tax failure — a positive charge whose calculation fails must fail closed: a
  // canonical TaxError, never a silently-guessed taxCents = 0.
  it("fails closed (throws) when Stripe Tax fails for a positive charge, never guessing zero", async () => {
    gateway.queueNextFailure(new Error("Stripe Tax unavailable (test)"));

    await expect(
      service.computeForCharge({ amountCents: 2000, reference: "booking-h" }),
    ).rejects.toBeInstanceOf(TaxError);
  });

  // I. Unexpected zero tax on a positive Cyprus charge (e.g. missing registration) must be
  // surfaced, never compensated for by inventing a tax amount — the result still faithfully
  // reports the zero Stripe returned.
  it("surfaces (never invents around) an unexpected zero-tax result on a positive charge", async () => {
    gateway.queueNextTax(0, "not_collecting");
    const result = await service.computeForCharge({ amountCents: 2000, reference: "booking-i" });

    expect(result.taxCents).toBe(0);
    expect(result.dueNowWithTaxCents).toBe(2000);
  });

  it("threads the caller's idempotency key through to the gateway", async () => {
    gateway.queueNextTax(100);
    await service.computeForCharge({
      amountCents: 1000,
      reference: "booking-idem",
      idempotencyKey: "abc123:tax",
    });

    expect(gateway.calls[0]?.idempotencyKey).toBe("abc123:tax");
  });
});
