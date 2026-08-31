import type { BookingDocument } from "../../../booking/booking.model.js";
import {
  durationMinutesBetween,
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../components/email-format.js";

/**
 * MAILING STAGE C — the ONE typed invoice DTO that drives BOTH the BOOKING_COMPLETED email body
 * summary AND the attached PDF. There is exactly one financial builder ({@link buildInvoiceData}).
 * Every value here is a display-ready string / enum / boolean; the email and PDF renderers only
 * print it — they never compute.
 *
 * SOURCES (all already-persisted, authoritative Booking fields — nothing re-fetched, no current
 * mutable Service/Addon lookup, no VAT/tax, no invoice-number sequence):
 *   bookingReference / invoiceReference  <- booking.reference        (Bookly has no formal
 *       accounting invoice sequence; the booking reference IS the invoice reference — documented
 *       limitation, no counter/collection added)
 *   issuedAt                             <- booking.completionPayment.recordedAt ?? booking.updatedAt
 *   appointment.*                        <- booking.schedule.*
 *   lineItems                            <- booking.serviceLines[].serviceSnapshot / .addons / .amountCents
 *   servicesSubtotal / addonsSubtotal / serviceDiscount / travelFee / total
 *                                        <- booking.financials.*                      (verbatim)
 *   promoDiscount                        <- booking.promo.discountCents                (verbatim, 0 if none)
 *   upfrontPaid ("Paid online")          <- booking.promo ? booking.promo.chargeCents
 *                                                         : booking.financials.depositCents   (field selection)
 *   venuePayment ("Paid at venue")       <- booking.completionPayment.amountCents ?? 0 (verbatim / 0)
 *
 * DOCUMENTED DERIVATIONS (isolated here, proven against completeBooking's own semantics):
 *   settlementStatus:
 *     no completionPayment                         -> NOT_RECORDED   (venuePayment arg was omitted)
 *     completionPayment.paid === false             -> NOT_PAID       (completeBooking: NOT_PAID)
 *     venuePayment >= financials.balanceDueCents    -> FULL           (completeBooking FULL sets
 *                                                                       venueAmountCents = balanceDueCents;
 *                                                                       also the balanceDue===0 FULL case)
 *     else (0 < venuePayment < balanceDueCents)    -> PARTIAL        (completeBooking PARTIAL: strict)
 *   totalPaid    = upfrontPaid + venuePayment                (sum of two authoritative amounts)
 *   outstanding  = FULL      -> 0
 *                  PARTIAL   -> financials.balanceDueCents - venuePayment   (>0 by the PARTIAL rule)
 *                  NOT_PAID / NOT_RECORDED -> financials.balanceDueCents
 *                  then max(0, .) — a defensive floor only: the Booking schema invariants
 *                  (depositCents <= totalCents, balanceDueCents === totalCents - depositCents,
 *                  promo.chargeCents <= depositCents, venuePayment <= balanceDueCents) make a
 *                  negative value impossible; the clamp never masks a real inconsistency.
 */

export type InvoiceLineItem = {
  label: string;
  kind: "SERVICE" | "ADDON";
  amountFormatted: string;
};

export type InvoiceSettlementStatus = "FULL" | "PARTIAL" | "NOT_PAID" | "NOT_RECORDED";

const SETTLEMENT_LABELS: Record<InvoiceSettlementStatus, string> = {
  FULL: "Paid in full",
  PARTIAL: "Partially paid",
  NOT_PAID: "Not paid at venue",
  NOT_RECORDED: "Venue payment not recorded",
};

export type InvoiceData = {
  bookingReference: string;
  invoiceReference: string;
  issuedAtIso: string;
  issuedAtFormatted: string;
  business: { name: string; phone?: string; address?: string };
  customer: { name: string; firstName: string; email?: string };
  appointment: {
    startAtIso: string;
    timezone: string;
    dateFormatted: string;
    timeFormatted: string;
    durationMin: number;
  };
  lineItems: InvoiceLineItem[];
  financial: {
    currency: string;
    servicesSubtotalFormatted: string;
    addonsSubtotalFormatted: string;
    serviceDiscountFormatted: string;
    promoDiscountFormatted: string;
    travelFeeFormatted: string;
    totalFormatted: string;
    upfrontPaidFormatted: string;
    venuePaymentFormatted: string;
    totalPaidFormatted: string;
    outstandingFormatted: string;
    settlementStatus: InvoiceSettlementStatus;
    settlementLabel: string;
    show: {
      addons: boolean;
      serviceDiscount: boolean;
      promoDiscount: boolean;
      travelFee: boolean;
      venuePayment: boolean;
      outstanding: boolean;
    };
  };
};

export type BuildInvoiceDataContext = {
  businessName: string;
  businessPhone?: string;
  businessAddress?: string;
};

export const sanitizeInvoiceReference = (reference: string): string =>
  reference.replace(/[^A-Za-z0-9._-]/g, "") || "booking";

export const buildInvoiceData = (
  booking: BookingDocument,
  context: BuildInvoiceDataContext,
): InvoiceData => {
  const fin = booking.financials;
  const currency = fin.currency;
  const tz = booking.schedule.timezone;
  const money = (cents: number): string => formatMoney(cents, currency);

  const lineItems: InvoiceLineItem[] = [];
  for (const line of booking.serviceLines) {
    lineItems.push({
      label: line.serviceSnapshot.name,
      kind: "SERVICE",
      amountFormatted: money(line.amountCents),
    });
    for (const addon of line.addons) {
      lineItems.push({
        label: addon.name,
        kind: "ADDON",
        amountFormatted: money(addon.priceCents),
      });
    }
  }

  // ---- amounts: verbatim persisted values + isolated, documented derivations ----------------
  const promoDiscountCents = booking.promo?.discountCents ?? 0;
  const upfrontPaidCents = booking.promo
    ? booking.promo.chargeCents
    : booking.financials.depositCents;
  const completionPayment = booking.completionPayment;
  const venuePaymentCents = completionPayment?.amountCents ?? 0;
  const balanceDueCents = fin.balanceDueCents;

  let settlementStatus: InvoiceSettlementStatus;
  if (!completionPayment) {
    settlementStatus = "NOT_RECORDED";
  } else if (completionPayment.paid === false) {
    settlementStatus = "NOT_PAID";
  } else if (venuePaymentCents >= balanceDueCents) {
    settlementStatus = "FULL";
  } else {
    settlementStatus = "PARTIAL";
  }

  const totalPaidCents = upfrontPaidCents + venuePaymentCents;
  const outstandingRaw =
    settlementStatus === "FULL"
      ? 0
      : settlementStatus === "PARTIAL"
        ? balanceDueCents - venuePaymentCents
        : balanceDueCents;
  const outstandingCents = Math.max(0, outstandingRaw);

  const issuedAt = completionPayment?.recordedAt ?? booking.updatedAt;

  return {
    bookingReference: booking.reference,
    invoiceReference: booking.reference,
    issuedAtIso: issuedAt.toISOString(),
    issuedAtFormatted: formatDateInTimezone(issuedAt, tz),
    business: {
      name: context.businessName,
      ...(context.businessPhone ? { phone: context.businessPhone } : {}),
      ...(context.businessAddress ? { address: context.businessAddress } : {}),
    },
    customer: {
      name: [booking.customer.contact.firstName, booking.customer.contact.lastName]
        .filter(Boolean)
        .join(" "),
      firstName: booking.customer.contact.firstName,
      email: booking.customer.contact.normalizedEmail,
    },
    appointment: {
      startAtIso: booking.schedule.startAt.toISOString(),
      timezone: tz,
      dateFormatted: formatDateInTimezone(booking.schedule.startAt, tz),
      timeFormatted: formatTimeInTimezone(booking.schedule.startAt, tz),
      durationMin: durationMinutesBetween(booking.schedule.startAt, booking.schedule.endAt),
    },
    lineItems,
    financial: {
      currency,
      servicesSubtotalFormatted: money(fin.servicesSubtotalCents),
      addonsSubtotalFormatted: money(fin.addonsSubtotalCents),
      serviceDiscountFormatted: money(fin.serviceDiscountCents),
      promoDiscountFormatted: money(promoDiscountCents),
      travelFeeFormatted: money(fin.travelFeeCents),
      totalFormatted: money(fin.totalCents),
      upfrontPaidFormatted: money(upfrontPaidCents),
      venuePaymentFormatted: money(venuePaymentCents),
      totalPaidFormatted: money(totalPaidCents),
      outstandingFormatted: money(outstandingCents),
      settlementStatus,
      settlementLabel: SETTLEMENT_LABELS[settlementStatus],
      show: {
        addons: fin.addonsSubtotalCents > 0,
        serviceDiscount: fin.serviceDiscountCents > 0,
        promoDiscount: promoDiscountCents > 0,
        travelFee: fin.travelFeeCents > 0,
        venuePayment: venuePaymentCents > 0,
        outstanding: outstandingCents > 0,
      },
    },
  };
};
