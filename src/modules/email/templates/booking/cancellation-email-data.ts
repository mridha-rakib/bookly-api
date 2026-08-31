import type { BookingDocument } from "../../../booking/booking.model.js";
import {
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../components/email-format.js";

/**
 * MAILING STAGE D — pure presentation payload for the two cancellation emails. Every value is a
 * display string; the templates only print it (no DB, no money arithmetic).
 *
 * SOURCES (all persisted, authoritative — nothing recomputed):
 *   cancelledBy                        <- which authoritative method ran (matches the persisted
 *                                         status: CANCELLED_BY_CUSTOMER / LATE_CANCELLATION vs
 *                                         CANCELLED_BY_BUSINESS). No new domain field.
 *   reference / services / appointment <- booking snapshots
 *   financialOutcome.*                 <- booking.cancellationOutcome.* verbatim
 */
export type CancellationEmailData = {
  bookingReference: string;
  cancelledBy: "CUSTOMER" | "BUSINESS";
  customerFirstName: string;
  customerName: string;
  businessName: string;
  appointmentDate: string;
  appointmentTime: string;
  services: string[];
  currency: string;
  financialOutcome: {
    /** true when a late-cancellation percentage fee was classified. */
    hasCancellationFee: boolean;
    cancellationFeeFormatted: string;
    depositAppliedFormatted: string;
    additionalChargeFormatted: string;
    refundFormatted: string;
    hasDepositApplied: boolean;
    hasAdditionalCharge: boolean;
    hasRefund: boolean;
    /** NOT_APPLICABLE | SUCCEEDED | FAILED — the persisted cancellationOutcome.settlementStatus. */
    settlementStatus: string;
  };
  customerBookingUrlPath?: string;
};

export const buildCancellationEmailData = (
  booking: BookingDocument,
  context: { businessName: string; cancelledBy: "CUSTOMER" | "BUSINESS" },
): CancellationEmailData => {
  const tz = booking.schedule.timezone;
  const currency = booking.financials.currency;
  const outcome = booking.cancellationOutcome;

  const cancellationFeeCents = outcome?.cancellationFeeCents ?? 0;
  const depositAppliedCents = outcome?.depositAppliedCents ?? 0;
  const additionalChargeCents = outcome?.additionalChargeCents ?? 0;
  const refundOwedCents = outcome?.refundOwedCents ?? 0;
  const settlementStatus = outcome?.settlementStatus ?? "NOT_APPLICABLE";
  const chargeSettled = settlementStatus === "SUCCEEDED";

  return {
    bookingReference: booking.reference,
    cancelledBy: context.cancelledBy,
    customerFirstName: booking.customer.contact.firstName,
    customerName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
      .filter(Boolean)
      .join(" "),
    businessName: context.businessName,
    appointmentDate: formatDateInTimezone(booking.schedule.startAt, tz),
    appointmentTime: formatTimeInTimezone(booking.schedule.startAt, tz),
    services: booking.serviceLines.map((line) => line.serviceSnapshot.name),
    currency,
    financialOutcome: {
      hasCancellationFee: (outcome?.feeMode ?? "FREE") === "PERCENTAGE" && cancellationFeeCents > 0,
      cancellationFeeFormatted: formatMoney(cancellationFeeCents, currency),
      depositAppliedFormatted: formatMoney(depositAppliedCents, currency),
      additionalChargeFormatted: formatMoney(additionalChargeCents, currency),
      refundFormatted: formatMoney(refundOwedCents, currency),
      hasDepositApplied: depositAppliedCents > 0,
      // Only claim an additional charge when it was actually settled with the provider.
      hasAdditionalCharge: additionalChargeCents > 0 && chargeSettled,
      hasRefund: refundOwedCents > 0,
      settlementStatus,
    },
    ...(booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
  };
};
