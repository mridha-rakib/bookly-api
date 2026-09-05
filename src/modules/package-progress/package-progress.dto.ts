import type { PackageProgressDocument } from "./package-progress.model.js";

export type PackageProgressSessionDto = {
  sessionIndex: number;
  bookingId: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "FORFEITED";
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
    sessions: progress.sessions.map((entry) => ({
      sessionIndex: entry.sessionIndex,
      bookingId: String(entry.bookingId),
      status: entry.status,
    })),
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
