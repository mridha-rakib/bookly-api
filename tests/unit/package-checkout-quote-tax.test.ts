import { describe, expect, it } from "vitest";
import { readPackageQuoteTax } from "../../src/modules/booking/package-checkout-quote-tax.js";
import { CyprusTaxService } from "../../src/modules/payment/tax.service.js";
import { FakeTaxGateway } from "../helpers/fake-tax-gateway.js";

const quote = (requiredUpfrontCents: number, currency = "EUR") => ({
  quoteId: "665f1c2e9b1e8a0012345678",
  financials: { currency, requiredUpfrontCents },
});

describe("First-Class quote informational VAT", () => {
  it("uses Stripe Tax on the upfront payment only, with a per-quote idempotency key", async () => {
    const gateway = new FakeTaxGateway();
    gateway.queueNextTax(608);
    const tax = new CyprusTaxService(gateway);
    expect(await readPackageQuoteTax(tax, quote(3200))).toEqual({
      status: "CALCULATED",
      taxMode: "PRE_ACTIVATION",
      currency: "EUR",
      preTaxChargeCents: 3200,
      taxCents: 608,
    });
    await readPackageQuoteTax(tax, quote(3200));
    expect(gateway.calls).toHaveLength(2);
    // Repeated reads of one quote reuse one Stripe Tax Calculation via the same idempotency key.
    expect(new Set(gateway.calls.map((c) => c.idempotencyKey))).toEqual(
      new Set(["package-quote:665f1c2e9b1e8a0012345678:tax"]),
    );
    expect(gateway.calls.every((c) => c.amountCents === 3200)).toBe(true);
  });

  it("reports a RETURNING zero upfront as calculated zero without calling Stripe", async () => {
    const gateway = new FakeTaxGateway();
    const result = await readPackageQuoteTax(new CyprusTaxService(gateway), quote(0));
    expect(result).toMatchObject({ status: "CALCULATED", preTaxChargeCents: 0, taxCents: 0 });
    expect(gateway.calls).toHaveLength(0);
  });

  it("keeps a Stripe-returned zero VAT distinct from unavailable", async () => {
    const gateway = new FakeTaxGateway();
    gateway.queueNextTax(0, "not_collecting");
    const result = await readPackageQuoteTax(new CyprusTaxService(gateway), quote(3200));
    expect(result).toMatchObject({ status: "CALCULATED", taxCents: 0 });
  });

  it.each([
    ["provider failure", true, "EUR"],
    ["no tax service", false, "EUR"],
    ["unsupported currency", true, "USD"],
  ])("returns UNAVAILABLE (never zero) on %s", async (_name, withService, currency) => {
    const gateway = new FakeTaxGateway();
    gateway.queueNextFailure(new Error("stripe down"));
    const result = await readPackageQuoteTax(
      withService ? new CyprusTaxService(gateway) : undefined,
      quote(3200, currency),
    );
    expect(result).toEqual({ status: "UNAVAILABLE", taxMode: "PRE_ACTIVATION" });
    expect(result).not.toHaveProperty("taxCents");
  });
});
