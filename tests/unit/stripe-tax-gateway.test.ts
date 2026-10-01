import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTaxCalculation } = vi.hoisted(() => ({
  createTaxCalculation: vi.fn(),
}));

vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => ({
    tax: { calculations: { create: createTaxCalculation } },
  }),
}));

import { StripeTaxGateway } from "../../src/modules/payment/stripe-tax-gateway.js";

describe("StripeTaxGateway", () => {
  beforeEach(() => {
    createTaxCalculation.mockReset();
    createTaxCalculation.mockResolvedValue({
      id: "taxcalc_test",
      tax_amount_exclusive: 380,
      amount_total: 2380,
      currency: "eur",
      tax_breakdown: [{ taxability_reason: "standard_rated" }],
    });
  });

  it("marks its Cyprus address as billing when creating a Stripe Tax calculation", async () => {
    await new StripeTaxGateway().calculateTax({
      amountCents: 2000,
      reference: "booking-tax-request",
    });

    expect(createTaxCalculation).toHaveBeenCalledWith(
      {
        currency: "eur",
        line_items: [
          {
            amount: 2000,
            reference: "booking-tax-request",
            tax_code: "txcd_20030000",
          },
        ],
        customer_details: {
          address: { country: "CY" },
          address_source: "billing",
        },
      },
      undefined,
    );
  });
});
