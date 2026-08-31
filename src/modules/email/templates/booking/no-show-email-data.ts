import type { BookingDocument } from "../../../booking/booking.model.js";
import {
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../components/email-format.js";

/**
 * MAILING STAGE D — pure presentation payload for the three no-show emails. Templates only
 * print these strings.
 *
 * CRITICAL: the money fields on a CHARGED payload are NOT recomputed here. They are the
 * domain's OWN already-computed values, passed in by the caller
 * ({@link import("../../../booking/no-show-resolution.service.js").NoShowResolutionService}):
 *   noShowPercentage  <- booking.cancellationPolicySnapshot.noShowPercentage (persisted)
 *   eligibleBasis     <- booking.financials.eligiblePlatformFeeBasisCents      (persisted)
 *   grossFee          <- the domain's own `grossFeeCents` local
 *   upfrontApplied    <- the domain's own resolved succeeded-upfront amount
 *   additionalCharge  <- the NO_SHOW_FEE ledger row amount actually charged
 * This module runs NO `round(basis * pct / 100)` and applies NO €5/€35 clamp.
 */
export type NoShowOutcome = "CHARGED" | "WAIVED" | "CANCELLED";

export type NoShowChargedAmounts = {
  noShowPercentage: number;
  eligibleBasisCents: number;
  grossFeeCents: number;
  upfrontAppliedCents: number;
  additionalChargeCents: number;
};

export type NoShowEmailData = {
  outcome: NoShowOutcome;
  bookingReference: string;
  customerFirstName: string;
  businessName: string;
  appointmentDate: string;
  appointmentTime: string;
  currency: string;
  /** Present only for outcome === "CHARGED". */
  charged?: {
    noShowPercentage: number;
    eligibleBasisFormatted: string;
    grossFeeFormatted: string;
    upfrontAppliedFormatted: string;
    additionalChargeFormatted: string;
  };
  customerBookingUrlPath?: string;
};

export const buildNoShowEmailData = (
  booking: BookingDocument,
  context: {
    businessName: string;
    outcome: NoShowOutcome;
    amounts?: NoShowChargedAmounts;
  },
): NoShowEmailData => {
  const tz = booking.schedule.timezone;
  const currency = booking.financials.currency;
  const money = (cents: number): string => formatMoney(cents, currency);

  return {
    outcome: context.outcome,
    bookingReference: booking.reference,
    customerFirstName: booking.customer.contact.firstName,
    businessName: context.businessName,
    appointmentDate: formatDateInTimezone(booking.schedule.startAt, tz),
    appointmentTime: formatTimeInTimezone(booking.schedule.startAt, tz),
    currency,
    ...(context.outcome === "CHARGED" && context.amounts
      ? {
          charged: {
            noShowPercentage: context.amounts.noShowPercentage,
            eligibleBasisFormatted: money(context.amounts.eligibleBasisCents),
            grossFeeFormatted: money(context.amounts.grossFeeCents),
            upfrontAppliedFormatted: money(context.amounts.upfrontAppliedCents),
            additionalChargeFormatted: money(context.amounts.additionalChargeCents),
          },
        }
      : {}),
    ...(booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
  };
};
