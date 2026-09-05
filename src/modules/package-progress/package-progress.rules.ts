import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingStatus } from "../booking/booking.types.js";

/**
 * Pure, side-effect-free Package classification rules (Phase 4B corrections) — mirrors
 * booking-cancellation-classification.ts's own precedent: a single, deterministic, trivially
 * testable place these decisions live, reused identically by every call site instead of being
 * re-derived inline at each one (BookingLifecycleService's cancellation/waive/no-show-cancel
 * paths and NoShowResolutionService's worker path all import from here).
 */

/** True for any Booking carrying a Package-linked line (the purchase session OR a redeemed
 * session — both stamp `pricingInput.packageProgressId`, see BookingCreationService's own
 * "Customer: Package purchase / session redemption" doc comment). Never a live PackageProgress
 * lookup — the linkage is already denormalized onto the Booking itself. */
export const isPackageLinkedBooking = (booking: Pick<BookingDocument, "serviceLines">): boolean =>
  booking.serviceLines.some((line) => line.pricingInput.packageProgressId);

export type PackageSessionOutcome = "RESTORE" | "FORFEIT" | "NONE";

/**
 * Given the Booking's OWN authoritative terminal status (never re-derived — see the confirmed
 * Package rules this maps 1:1 from):
 *  - CANCELLED_BY_CUSTOMER (on-time customer cancellation) -> RESTORE.
 *  - CANCELLED_BY_BUSINESS (business-initiated; never the customer's fault, same principle the
 *    existing cancelByBusiness rule already applies to fees) -> RESTORE.
 *  - LATE_CANCELLATION -> FORFEIT ("the lost session IS the penalty" — confirmed rule; no
 *    additional Package base-service fee is ever layered on top, see cancelByCustomer's own
 *    package-fee-suppression comment).
 *  - NO_SHOW_CHARGED / NO_SHOW_WAIVED (a genuinely resolved no-show, whether or not a fee was
 *    actually collectible) -> FORFEIT.
 *  - NO_SHOW_CANCELLED (the Business reverses the no-show outright — confirmed not the
 *    customer's fault, same reasoning as CANCELLED_BY_BUSINESS) -> RESTORE.
 *  - Every other status (UPCOMING, PENDING, COMPLETED, and terminal states this function is
 *    never called for) -> NONE, a defensive default; callers only invoke this once a booking has
 *    actually reached one of the six statuses above.
 */
export const packageSessionOutcomeForBookingStatus = (
  status: BookingStatus,
): PackageSessionOutcome => {
  switch (status) {
    case "CANCELLED_BY_CUSTOMER":
    case "CANCELLED_BY_BUSINESS":
    case "NO_SHOW_CANCELLED":
      return "RESTORE";
    case "LATE_CANCELLATION":
    case "NO_SHOW_CHARGED":
    case "NO_SHOW_WAIVED":
      return "FORFEIT";
    default:
      return "NONE";
  }
};

export type PackageBalanceSettlement = {
  balanceSettled: boolean;
  outstandingBalanceCents: number;
};

/**
 * Approved payment/unlock model: the Package purchase (session 1) charges the SAME online
 * deposit any normal booking would, and the remaining bundle price is a `balanceDueCents`
 * exactly like any FIXED-price booking's venue balance — reusing that EXISTING source of truth
 * (`Booking.financials.balanceDueCents` + `Booking.completionPayment`, both already written by
 * the pre-existing `completeBooking` venue-payment flow) rather than inventing a second
 * payment-status system. A Package's later sessions unlock only once this ORIGIN booking's
 * balance has been recorded as FULLY paid — a PARTIAL venue payment does not unlock them.
 * `balanceDueCents <= 0` (nothing was ever owed beyond the deposit) counts as settled with
 * nothing further required.
 */
export const computePackageBalanceSettlement = (
  originBooking: Pick<BookingDocument, "financials" | "completionPayment">,
): PackageBalanceSettlement => {
  const balanceDueCents = Math.max(0, originBooking.financials.balanceDueCents);
  if (balanceDueCents <= 0) {
    return { balanceSettled: true, outstandingBalanceCents: 0 };
  }

  const paidCents =
    originBooking.completionPayment?.paid === true
      ? (originBooking.completionPayment.amountCents ?? 0)
      : 0;
  const balanceSettled = paidCents >= balanceDueCents;

  return {
    balanceSettled,
    outstandingBalanceCents: balanceSettled ? 0 : balanceDueCents - paidCents,
  };
};
