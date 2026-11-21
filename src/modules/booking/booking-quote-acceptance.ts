import { createHash } from "node:crypto";
import type { BookingFinancials, BookingServiceLineAddon } from "./booking.model.js";

/**
 * Fix #1 — Customer payment consent. A Customer's finalize request must carry the digest of the
 * exact preview they confirmed; finalize recomputes the SAME digest from its own authoritative,
 * freshly established terms (classification, promo, prices) and refuses with
 * `BOOKING_QUOTE_CHANGED` (409) before any Financial Contract, relationship consumption,
 * PaymentIntent, ledger row or promo redemption exists whenever the two differ.
 *
 * The digest is NOT a pricing authority and carries no secret: it is only an equality witness of
 * "these are the terms the Customer saw". The server never derives an amount from it — a client
 * that sends the digest of terms it never displayed can only ever be charged those exact
 * server-computed terms. Informational VAT (`taxCents`, never charged in PRE_ACTIVATION) is
 * deliberately excluded so a Stripe Tax rounding/rate response can never block consent.
 */
export const BOOKING_QUOTE_DIGEST_PATTERN = /^bq1_[a-f0-9]{64}$/;

export type BookingQuoteTerms = {
  productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
  classification: "FIRST" | "RETURNING";
  financials: Pick<
    BookingFinancials,
    | "currency"
    | "servicesSubtotalCents"
    | "addonsSubtotalCents"
    | "serviceDiscountCents"
    | "promoDiscountCents"
    | "travelFeeCents"
    | "depositCents"
    | "balanceDueCents"
    | "totalCents"
  >;
  lines: ReadonlyArray<{
    serviceId: string;
    staffMembershipId: string;
    amountCents: number;
    discountCents: number;
    addons: ReadonlyArray<Pick<BookingServiceLineAddon, "addonId" | "priceCents">>;
  }>;
  promo?: { normalizedCode: string; type: string; value: number; discountCents: number };
  packageBundlePriceCents?: number;
};

/** Deterministic: fixed field order, arrays kept in request order (line order is part of the
 * request and of the Booking itself). */
export const computeBookingQuoteDigest = (terms: BookingQuoteTerms): string => {
  const f = terms.financials;
  const canonical = [
    "bq1",
    terms.productKind,
    terms.classification,
    f.currency,
    f.servicesSubtotalCents,
    f.addonsSubtotalCents,
    f.serviceDiscountCents,
    f.promoDiscountCents ?? 0,
    f.travelFeeCents,
    f.depositCents,
    f.balanceDueCents,
    f.totalCents,
    terms.packageBundlePriceCents ?? null,
    terms.promo
      ? [terms.promo.normalizedCode, terms.promo.type, terms.promo.value, terms.promo.discountCents]
      : null,
    terms.lines.map((line) => [
      line.serviceId,
      line.staffMembershipId,
      line.amountCents,
      line.discountCents,
      line.addons.map((addon) => [String(addon.addonId), addon.priceCents]),
    ]),
  ];
  return `bq1_${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
};
