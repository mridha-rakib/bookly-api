import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingStatus } from "../booking/booking.types.js";
import type { PackageProgressDocument } from "./package-progress.model.js";

/** A customer-safe, historical summary for one persisted Package session Booking. The staff
 * name comes from the Booking's immutable staffSnapshot, never a current staff-profile lookup,
 * so Package history remains truthful after a professional renames or leaves. `booking: null`
 * deliberately represents a corrupt/legacy dangling relationship; no appointment facts are
 * manufactured in that case. */
export type PackageProgressSessionDto = {
  sessionIndex: number;
  bookingId: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "FORFEITED";
  booking: {
    status: BookingStatus;
    schedule: { timezone: string; startAt: string; endAt: string };
    professional: { membershipId: string; displayName?: string | undefined };
  } | null;
};

const toPackageProgressSessionDto = (
  packageProgressId: string,
  entry: PackageProgressDocument["sessions"][number],
  booking: BookingDocument | undefined,
): PackageProgressSessionDto => {
  if (!booking) {
    return {
      sessionIndex: entry.sessionIndex,
      bookingId: String(entry.bookingId),
      status: entry.status,
      booking: null,
    };
  }

  // A Package Booking is created with exactly one service line. Locate it by its entitlement
  // link rather than relying on that construction detail, so this DTO remains safe if a legacy
  // document contains additional lines.
  const packageLine = booking.serviceLines.find(
    (candidate) => String(candidate.pricingInput.packageProgressId) === packageProgressId,
  );
  if (!packageLine) {
    return {
      sessionIndex: entry.sessionIndex,
      bookingId: String(entry.bookingId),
      status: entry.status,
      booking: null,
    };
  }
  const displayName = packageLine.staffSnapshot
    ? [packageLine.staffSnapshot.firstName, packageLine.staffSnapshot.lastName]
        .filter(Boolean)
        .join(" ")
    : undefined;

  return {
    sessionIndex: entry.sessionIndex,
    bookingId: String(entry.bookingId),
    status: entry.status,
    booking: {
      status: booking.status,
      schedule: {
        timezone: booking.schedule.timezone,
        startAt: booking.schedule.startAt.toISOString(),
        endAt: booking.schedule.endAt.toISOString(),
      },
      professional: {
        membershipId: String(packageLine.responsibleStaffMembershipId),
        ...(displayName ? { displayName } : {}),
      },
    },
  };
};

/** Live settlement facts about the origin (session 1) Booking — computed by
 * PackageProgressService from the Booking's own authoritative `financials`/`completionPayment`
 * (never a second, separately-tracked payment-status field — see that service's own doc
 * comment), passed in here purely for DTO assembly. */
export type PackageProgressSettlement = {
  balanceSettled: boolean;
  outstandingBalanceCents: number;
};

export type PackageProgressDto = {
  id: string;
  businessId: string;
  serviceId: string;
  totalSessions: number;
  remainingSessions: number;
  completedSessions: number;
  /** Derived, never stored — see package-progress.model.ts's own doc comment on why `status`
   * is not a persisted field. Precedence: VOIDED (refunded) > AWAITING_BALANCE (session 1 not
   * yet settled — sessions 2..N cannot be redeemed yet) > DEPLETED (no sessions left) > ACTIVE. */
  status: "ACTIVE" | "AWAITING_BALANCE" | "DEPLETED" | "VOIDED";
  balanceSettled: boolean;
  outstandingBalanceCents: number;
  sessions: PackageProgressSessionDto[];
  originBookingId: string;
  purchaseSnapshot: {
    name: string;
    packageServicesName?: string | undefined;
    bundlePriceCents: number;
    durationMin: number;
    sessionsInPackage: number;
    discountPercent?: number | undefined;
  };
  voidedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export const toPackageProgressDto = (
  progress: PackageProgressDocument,
  settlement: PackageProgressSettlement,
  bookingsById: ReadonlyMap<string, BookingDocument> = new Map(),
): PackageProgressDto => {
  const status: PackageProgressDto["status"] = progress.voidedAt
    ? "VOIDED"
    : progress.remainingSessions <= 0
      ? "DEPLETED"
      : !settlement.balanceSettled
        ? "AWAITING_BALANCE"
        : "ACTIVE";

  return {
    id: String(progress._id),
    businessId: String(progress.businessId),
    serviceId: String(progress.serviceId),
    totalSessions: progress.totalSessions,
    remainingSessions: progress.remainingSessions,
    completedSessions: progress.completedSessions,
    status,
    balanceSettled: settlement.balanceSettled,
    outstandingBalanceCents: settlement.outstandingBalanceCents,
    // Session indices are intentionally not unique across cancellation/rebooking attempts: a
    // restored entitlement can be claimed again as the same logical session number. Preserve
    // all Booking history, ordered deterministically by logical index then persisted session
    // history order (the latter is the creation order established by recordScheduledSession).
    sessions: progress.sessions
      .map((entry, insertionOrder) => ({ entry, insertionOrder }))
      .sort(
        (left, right) =>
          left.entry.sessionIndex - right.entry.sessionIndex ||
          left.insertionOrder - right.insertionOrder,
      )
      .map(({ entry }) =>
        toPackageProgressSessionDto(
          String(progress._id),
          entry,
          bookingsById.get(String(entry.bookingId)),
        ),
      ),
    originBookingId: String(progress.originBookingId),
    purchaseSnapshot: {
      name: progress.purchaseSnapshot.name,
      packageServicesName: progress.purchaseSnapshot.packageServicesName,
      bundlePriceCents: progress.purchaseSnapshot.bundlePriceCents,
      durationMin: progress.purchaseSnapshot.durationMin,
      sessionsInPackage: progress.purchaseSnapshot.sessionsInPackage,
      discountPercent: progress.purchaseSnapshot.discountPercent,
    },
    voidedAt: progress.voidedAt?.toISOString(),
    createdAt: progress.createdAt.toISOString(),
    updatedAt: progress.updatedAt.toISOString(),
  };
};
