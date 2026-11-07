import { logger } from "../../config/logger.js";
import type { ComputedTax, CyprusTaxService } from "../payment/tax.service.js";

/** Same compute-only (PRE_ACTIVATION) VAT disclosure a Normal Booking preview carries: Stripe Tax
 * on the online upfront charge only, informational, never added to the payable amount. */
export type PackageQuoteTaxDisclosure =
  | {
      status: "CALCULATED";
      taxMode: "PRE_ACTIVATION";
      currency: "EUR";
      preTaxChargeCents: number;
      taxCents: number;
    }
  | { status: "UNAVAILABLE"; taxMode: "PRE_ACTIVATION" };

const unavailable = { status: "UNAVAILABLE", taxMode: "PRE_ACTIVATION" } as const;

/**
 * The one informational Stripe Tax calculation for a retained First-Class quote's upfront charge.
 * The quote id is the Stripe idempotency key, so every quote read AND the later purchase (which
 * must happen inside the quote's 30-minute lifetime, for the same amount) reuse one calculation.
 * Returns undefined when unavailable — never a guessed zero. Never throws.
 */
export async function calculatePackageQuoteTax(
  tax: Pick<CyprusTaxService, "computeForCharge"> | undefined,
  quoteId: string,
  amountCents: number,
): Promise<ComputedTax | undefined> {
  if (!tax) return undefined;
  try {
    const computed = await tax.computeForCharge({
      amountCents,
      reference: `package-quote-${quoteId}`,
      idempotencyKey: `package-quote:${quoteId}:tax`,
    });
    return computed.preTaxAmountCents === amountCents ? computed : undefined;
  } catch {
    // No amount, provider message or customer data in logs.
    logger.warn(
      { event: "PACKAGE_QUOTE_TAX_UNAVAILABLE", quoteId },
      "Informational VAT for a Package quote could not be calculated",
    );
    return undefined;
  }
}

/**
 * Read-only companion of a retained First-Class quote. It is NOT part of the retained payload,
 * quote hash or signed disclosure, so it can never alter accepted terms or the PaymentIntent.
 * A failure is reported as UNAVAILABLE and does not block reading or accepting the quote.
 */
export async function readPackageQuoteTax(
  tax: Pick<CyprusTaxService, "computeForCharge"> | undefined,
  quote: { quoteId: string; financials: { currency: string; requiredUpfrontCents: number } },
): Promise<PackageQuoteTaxDisclosure> {
  if (quote.financials.currency !== "EUR") return unavailable;
  const computed = await calculatePackageQuoteTax(
    tax,
    quote.quoteId,
    quote.financials.requiredUpfrontCents,
  );
  if (!computed) return unavailable;
  return {
    status: "CALCULATED",
    taxMode: "PRE_ACTIVATION",
    currency: "EUR",
    preTaxChargeCents: computed.preTaxAmountCents,
    taxCents: computed.taxCents,
  };
}
