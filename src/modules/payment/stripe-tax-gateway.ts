import type Stripe from "stripe";
import { getStripeClient } from "./stripe-client.js";
import { TaxError } from "./tax.errors.js";
import type { CalculateTaxInput, TaxCalculationResult, TaxGateway } from "./tax.types.js";

/**
 * Bookly is Cyprus-only (locked product rule) — every current service/package is treated as a
 * standard Cyprus VAT-rated supply. This is therefore a single-jurisdiction integration by
 * design, not a simplified stand-in for a future multi-country one: the customer's own location
 * is deliberately NOT collected or used here (no new address/UI in this checkpoint — see the
 * Checkpoint B brief's explicit "do not implement multi-jurisdiction tax" instruction). The
 * `country: "CY"` below reflects WHERE Bookly supplies these services from/to under that product
 * rule, not a customer-provided address.
 */
const BOOKLY_SUPPLY_COUNTRY = "CY";

/**
 * Stripe's generic "General - Services" tax code (docs.stripe.com/tax/tax-categories) — the
 * documented fallback for a service line with no more specific category. Set explicitly on every
 * line item rather than relying on an unverified Stripe account default tax code, so this
 * integration's behavior does not silently depend on Dashboard configuration this codebase has
 * no way to inspect or assert on. Revisiting this per-service-category is an explicit LEGAL/
 * ACCOUNTING decision the VAT architecture audit deferred, not something to guess here.
 */
const DEFAULT_SERVICE_TAX_CODE = "txcd_20030000";

/**
 * The only file (besides stripe-payment-gateway.ts) allowed to import the `stripe` SDK directly
 * — every caller depends on the `TaxGateway` interface only (see tax.types.ts), matching this
 * codebase's existing Stripe-access convention.
 */
export class StripeTaxGateway implements TaxGateway {
  private get client(): Stripe {
    return getStripeClient();
  }

  public async calculateTax(input: CalculateTaxInput): Promise<TaxCalculationResult> {
    let calculation: Stripe.Tax.Calculation;
    try {
      calculation = await this.client.tax.calculations.create(
        {
          currency: "eur",
          line_items: [
            {
              amount: input.amountCents,
              reference: input.reference,
              tax_code: DEFAULT_SERVICE_TAX_CODE,
            },
          ],
          customer_details: {
            address: { country: BOOKLY_SUPPLY_COUNTRY },
            address_source: "billing",
          },
        },
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
      );
    } catch (error) {
      throw new TaxError("TAX_CALCULATION_FAILED", 502, [
        {
          message: this.safeErrorMessage(error),
          code: "TAX_CALCULATION_FAILED",
        },
      ]);
    }

    const lineItem = calculation.tax_breakdown[0];

    return {
      taxCalculationId: calculation.id as string,
      preTaxAmountCents: input.amountCents,
      taxCents: calculation.tax_amount_exclusive,
      amountTotalCents: calculation.amount_total,
      currency: calculation.currency,
      ...(lineItem ? { taxabilityReason: lineItem.taxability_reason } : {}),
    };
  }

  // Never pass a raw Stripe error object/message straight through — same discipline as
  // StripePaymentGateway.safeDeclineMessage.
  private safeErrorMessage(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    }
    return "Tax calculation failed";
  }
}
