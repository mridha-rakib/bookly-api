import { logger } from "../../config/logger.js";
import { TaxError } from "./tax.errors.js";
import type { TaxCalculationResult, TaxGateway } from "./tax.types.js";

export type ComputedTax = {
  /** Equals the input `amountCents` — repeated here so a consumer never has to cross-reference
   * back to its own call site to know what was actually taxed. */
  preTaxAmountCents: number;
  /** Server/Stripe-derived — NEVER client-submitted, never locally computed as `amount * rate`. */
  taxCents: number;
  /** COMPUTE-ONLY for this checkpoint — `preTaxAmountCents + taxCents` (Stripe's own
   * `amount_total`, used verbatim). This is deliberately NOT the amount actually charged to the
   * customer's card in this checkpoint: the live PaymentIntent still charges `preTaxAmountCents`
   * only (see BookingCreationService's call sites). Naming spells this out explicitly so no
   * future change mistakes this field for a live charge amount. */
  dueNowWithTaxCents: number;
  /** Absent only for a zero-amount charge (no Tax Calculation is created — nothing to tax). */
  taxCalculationId?: string;
};

/**
 * Cyprus-only VAT computation (locked product rule — Bookly operates in a single jurisdiction).
 * Deliberately NOT a general-purpose multi-country tax engine: there is exactly one supported
 * amount shape (a single "online booking charge" line) and one supported jurisdiction. Every
 * caller in BookingCreationService computes the SAME already-canonical `customerChargeNowCents`
 * (post-clamp, post-promo) before calling this — this service never re-derives or second-guesses
 * that amount, it only asks Stripe what Cyprus VAT applies to it.
 */
export class CyprusTaxService {
  public constructor(private readonly gateway: TaxGateway) {}

  /**
   * `amountCents` must already be the final online charge amount (existing deposit/clamp/promo
   * logic fully applied). Returns an all-zero result with no Stripe call for a zero-amount
   * charge (rule: never invent a minimum VAT, never call Stripe Tax for nothing to tax). Throws
   * `TaxError` — never a silently-guessed `taxCents = 0` — if Stripe Tax fails for a genuinely
   * positive amount, so a caller can never proceed as though the booking were tax-free by
   * accident.
   */
  public async computeForCharge(input: {
    amountCents: number;
    reference: string;
    idempotencyKey?: string | undefined;
  }): Promise<ComputedTax> {
    if (input.amountCents === 0) {
      return { preTaxAmountCents: 0, taxCents: 0, dueNowWithTaxCents: 0 };
    }

    let result: TaxCalculationResult;
    try {
      result = await this.gateway.calculateTax({
        amountCents: input.amountCents,
        reference: input.reference,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      // Fail closed regardless of which TaxGateway implementation is wired in — never let a
      // positive-charge tax failure surface as anything other than this canonical error (locked
      // rule: never invent VAT, never proceed as though the booking were tax-free).
      if (error instanceof TaxError) {
        throw error;
      }
      throw new TaxError("TAX_CALCULATION_FAILED", 502, [
        {
          message: error instanceof Error ? error.message : "Tax calculation failed",
          code: "TAX_CALCULATION_FAILED",
        },
      ]);
    }

    if (result.taxCents === 0) {
      // Every current Bookly service/package is a standard Cyprus-rated supply (locked product
      // rule) — a zero-tax result on a positive charge is therefore unexpected and must be
      // surfaced for QA, never silently accepted as "correct" or compensated for by inventing a
      // tax amount here.
      logger.warn(
        {
          reference: input.reference,
          amountCents: input.amountCents,
          taxCalculationId: result.taxCalculationId,
          taxabilityReason: result.taxabilityReason,
        },
        "Stripe Tax returned zero VAT for a positive Cyprus online charge — verify Stripe Tax registration/configuration",
      );
    }

    return {
      preTaxAmountCents: result.preTaxAmountCents,
      taxCents: result.taxCents,
      dueNowWithTaxCents: result.amountTotalCents,
      taxCalculationId: result.taxCalculationId,
    };
  }
}
