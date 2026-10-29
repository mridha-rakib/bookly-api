import type { BookingDocument } from "./booking.model.js";

/** One server calculation shared by detail presentation and confirmation preconditions.
 * Original balance and outstanding balance are distinct once venue payment is recorded. */
export function bookingPaymentSummary(
  booking: Pick<BookingDocument, "source" | "promo" | "financials" | "completionPayment">,
) {
  const actualOnlinePaidCents =
    booking.source === "MANUAL"
      ? 0
      : (booking.promo?.chargeCents ?? booking.financials.depositCents);
  const originalVenueBalanceCents = Math.max(0, booking.financials.balanceDueCents);
  const venuePaidCents =
    booking.completionPayment?.paid === true
      ? Math.min(originalVenueBalanceCents, booking.completionPayment.amountCents ?? 0)
      : 0;
  const outstandingVenueBalanceCents = Math.max(0, originalVenueBalanceCents - venuePaidCents);
  let venueSettlementStatus:
    | "NOT_REQUIRED"
    | "NOT_RECORDED"
    | "NOT_PAID"
    | "PARTIALLY_PAID"
    | "PAID_IN_FULL";
  if (originalVenueBalanceCents <= 0) venueSettlementStatus = "NOT_REQUIRED";
  else if (!booking.completionPayment) venueSettlementStatus = "NOT_RECORDED";
  else if (!booking.completionPayment.paid) venueSettlementStatus = "NOT_PAID";
  else if (outstandingVenueBalanceCents > 0) venueSettlementStatus = "PARTIALLY_PAID";
  else venueSettlementStatus = "PAID_IN_FULL";
  return {
    actualOnlinePaidCents,
    originalVenueBalanceCents,
    venuePaidCents,
    outstandingVenueBalanceCents,
    venueSettlementStatus,
  };
}
