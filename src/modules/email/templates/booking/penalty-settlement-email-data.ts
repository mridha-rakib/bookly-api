import type { BookingDocument } from "../../../booking/booking.model.js";
import {
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../components/email-format.js";

/**
 * P5 — pure presentation payload for the durable penalty settlement follow-up (the truthful
 * outcome of a late-cancellation / no-show shortfall collection). Every value is a display
 * string taken from durable state the caller has just committed — the settled ledger
 * obligation's own amount and outcome — never re-derived here, and never sent for an
 * unresolved (pending / unknown) provider outcome.
 */
export type PenaltySettlementKind = "CANCELLATION_FEE" | "NO_SHOW_FEE";
export type PenaltySettlementOutcome = "SUCCEEDED" | "FAILED" | "WAIVED";

export type PenaltySettlementEmailData = {
  kind: PenaltySettlementKind;
  outcome: PenaltySettlementOutcome;
  bookingReference: string;
  businessName: string;
  customerFirstName: string;
  customerName: string;
  appointmentDate: string;
  appointmentTime: string;
  amountFormatted: string;
  customerBookingUrlPath?: string;
};

export const buildPenaltySettlementEmailData = (
  booking: BookingDocument,
  context: {
    businessName: string;
    kind: PenaltySettlementKind;
    outcome: PenaltySettlementOutcome;
    amountCents: number;
  },
): PenaltySettlementEmailData => ({
  kind: context.kind,
  outcome: context.outcome,
  bookingReference: booking.reference,
  businessName: context.businessName,
  customerFirstName: booking.customer.contact.firstName,
  customerName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
    .filter(Boolean)
    .join(" "),
  appointmentDate: formatDateInTimezone(booking.schedule.startAt, booking.schedule.timezone),
  appointmentTime: formatTimeInTimezone(booking.schedule.startAt, booking.schedule.timezone),
  amountFormatted: formatMoney(context.amountCents, booking.financials.currency),
  ...(booking.customer.customerUserId
    ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
    : {}),
});
