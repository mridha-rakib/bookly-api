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
 *   financialOutcome.*                 <- booking.cancellationOutcome.* verbatim, UNLESS the
 *                                         caller passes `refundOverride` (see below).
 *
 * `refundOverride` (Phase 4B close-out fix): `cancellationOutcome.refundOwedCents` is only ever
 * populated by `cancelByBusiness`'s own manually-built outcome (never by `cancelByCustomer`'s
 * classifier, which hardcodes it to 0 — customer-initiated cancellations never trigger a real
 * refund in this codebase) and, critically, is set BEFORE the refund is actually attempted — it
 * describes intent, not result. For a caller acting on a DIFFERENT booking's own refund (e.g.
 * BookingLifecycleService.voidUnusedPackage refunding the Package's origin booking, whose own
 * `cancellationOutcome` describes an unrelated, earlier-classified cancellation, not this
 * refund), that persisted field is simply the wrong data to read. Any caller that has just
 * executed a real refund and wants that exact, authoritative, just-happened result reflected
 * here instead passes it explicitly. The templates already correctly distinguish "processed"
 * (`settlementStatus === "SUCCEEDED"`) from "being arranged" (anything else) — never claiming a
 * failed refund as completed — so this override only ever corrects WHICH amount/status is shown,
 * never whether a failure is misrepresented as a success.
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
    /** NOT_APPLICABLE | SUCCEEDED | FAILED — the persisted cancellationOutcome.settlementStatus,
     * or (only when the caller passed `refundOverride`) that refund's own real outcome. */
    settlementStatus: string;
  };
  customerBookingUrlPath?: string;
};

export const buildCancellationEmailData = (
  booking: BookingDocument,
  context: {
    businessName: string;
    cancelledBy: "CUSTOMER" | "BUSINESS";
    /** The real, authoritative outcome of a refund the caller just executed — see this file's
     * own module doc comment. Overrides the persisted `cancellationOutcome`'s refund fields
     * only; every other field (fee/deposit-applied/additional-charge) is unaffected. */
    refundOverride?: { succeeded: boolean; amountCents: number };
  },
): CancellationEmailData => {
  const tz = booking.schedule.timezone;
  const currency = booking.financials.currency;
  const outcome = booking.cancellationOutcome;

  const cancellationFeeCents = outcome?.cancellationFeeCents ?? 0;
  const depositAppliedCents = outcome?.depositAppliedCents ?? 0;
  const additionalChargeCents = outcome?.additionalChargeCents ?? 0;
  const chargeSettled = (outcome?.settlementStatus ?? "NOT_APPLICABLE") === "SUCCEEDED";

  // Refund fields: prefer the caller's just-executed, authoritative result over the persisted
  // classification, which only ever records INTENT (see module doc comment) — never both mixed.
  const refundAmountCents = context.refundOverride
    ? context.refundOverride.amountCents
    : (outcome?.refundOwedCents ?? 0);
  const settlementStatus = context.refundOverride
    ? context.refundOverride.succeeded
      ? "SUCCEEDED"
      : "FAILED"
    : (outcome?.settlementStatus ?? "NOT_APPLICABLE");

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
      refundFormatted: formatMoney(refundAmountCents, currency),
      hasDepositApplied: depositAppliedCents > 0,
      // Only claim an additional charge when it was actually settled with the provider.
      hasAdditionalCharge: additionalChargeCents > 0 && chargeSettled,
      // Unchanged from before this fix: `hasRefund` means "there is a refund amount worth
      // mentioning" — the templates below already correctly branch wording on `settlementStatus`
      // ("has been processed" only for SUCCEEDED, "is being arranged" otherwise), so a FAILED
      // refund is never described as completed. What this fix corrects is the SOURCE of
      // `refundAmountCents`/`settlementStatus` themselves (see refundOverride above), not this
      // gate.
      hasRefund: refundAmountCents > 0,
      settlementStatus,
    },
    ...(booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
  };
};
