import { Types } from "mongoose";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { buildBooking } from "./stage-b-fixtures.js";

export { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/** A cancelled booking with a persisted `cancellationOutcome`. */
export const buildCancelledBooking = (
  outcome: Partial<BookingDocument["cancellationOutcome"]> & Record<string, unknown> = {},
  bookingOverrides: Partial<BookingDocument> = {},
): BookingDocument =>
  buildBooking({
    status: (outcome["feeMode"] === "PERCENTAGE"
      ? "LATE_CANCELLATION"
      : "CANCELLED_BY_CUSTOMER") as never,
    cancellationOutcome: {
      classifiedAt: new Date("2026-09-04T10:00:00.000Z"),
      tier: "UNDER_2_HOURS",
      feeMode: "FREE",
      cancellationFeeCents: 0,
      depositAppliedCents: 0,
      additionalChargeCents: 0,
      refundOwedCents: 0,
      settlementStatus: "NOT_APPLICABLE",
      ...outcome,
    } as never,
    ...bookingOverrides,
  });

/** A booking whose no-show has resolved. `status` reflects the outcome. */
export const buildNoShowBooking = (
  status: "NO_SHOW_CHARGED" | "NO_SHOW_WAIVED" | "NO_SHOW_CANCELLED",
  overrides: Partial<BookingDocument> = {},
): BookingDocument =>
  buildBooking({
    status: status as never,
    financials: {
      currency: "EUR",
      servicesSubtotalCents: 4000,
      addonsSubtotalCents: 0,
      serviceDiscountCents: 0,
      travelFeeCents: 0,
      eligiblePlatformFeeBasisCents: 4000,
      platformFeeCents: 800,
      depositCents: 800,
      balanceDueCents: 3200,
      totalCents: 4000,
    } as never,
    cancellationPolicySnapshot: {
      tiers: [{ tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 50 }],
      noShowPercentage: 30,
    } as never,
    ...overrides,
  });

/** The domain-computed amounts for the canonical €40 basis / 30% / €8 upfront → €4 scenario. */
export const NO_SHOW_CHARGED_AMOUNTS = {
  noShowPercentage: 30,
  eligibleBasisCents: 4000,
  grossFeeCents: 1200,
  upfrontAppliedCents: 800,
  additionalChargeCents: 400,
};

export const newObjectId = (): Types.ObjectId => new Types.ObjectId();
