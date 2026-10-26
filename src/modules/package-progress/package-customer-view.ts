import type { BookingDocument } from "../booking/booking.model.js";
import { PackageProgressError } from "./package-progress.errors.js";
import { computePackageBalanceSettlement } from "./package-progress.rules.js";
import type { PackageProgressV2Document } from "./package-progress-v2.types.js";

/** Explicit read DTO: no acceptance evidence, challenges, provider ids or write tokens. */
export function toCustomerPackageView(
  progress: PackageProgressV2Document,
  bookings: BookingDocument[],
) {
  const matching = bookings.filter(
    (booking) =>
      String(booking.businessId) === String(progress.businessId) &&
      String(booking.customer.customerUserId) === String(progress.customerUserId) &&
      String(booking.customer.businessClientId) === String(progress.businessClientId),
  );
  const byId = new Map(matching.map((b) => [String(b._id), b]));
  const candidateOrigin = byId.get(String(progress.originBookingId));
  const origin = candidateOrigin?.serviceLines.some(
    (line) =>
      String(line.pricingInput.packageProgressId) === String(progress._id) &&
      line.packageContext?.role === "PURCHASE",
  )
    ? candidateOrigin
    : undefined;
  const contract = progress.creditAccountingVersion === 2 ? progress.purchasedContract : undefined;
  const items = progress.items.map((item) => {
    const attempts = progress.sessions.filter(
      (s) => String(s.packageItemId) === String(item.packageItemId),
    );
    const scheduled = attempts.filter((s) => s.status === "SCHEDULED").length;
    const forfeited = attempts.filter((s) => s.status === "FORFEITED").length;
    const expired = "expiredSessions" in item ? item.expiredSessions : 0;
    if (
      item.totalSessions !==
      item.remainingSessions + scheduled + item.completedSessions + forfeited + expired
    )
      throw new PackageProgressError("PACKAGE_ACCOUNTING_UNAVAILABLE", 409);
    return {
      id: String(item.packageItemId),
      serviceId: String(item.serviceId),
      name: item.serviceSnapshot.name,
      pricingMode: item.serviceSnapshot.pricingMode,
      group: item.serviceSnapshot.group ? { credits: 1, partySize: 1 } : null,
      total: item.totalSessions,
      remaining: item.remainingSessions,
      scheduled,
      completed: item.completedSessions,
      forfeited,
      expired,
      travelCities: item.travelCities?.map((c) => ({ city: c.city, feeCents: c.feeCents })) ?? [],
    };
  });
  return {
    id: String(progress._id),
    schemaVersion: 2 as const,
    businessId: String(progress.businessId),
    name: progress.purchaseSnapshot.name,
    currency: progress.purchaseSnapshot.currency,
    bundlePriceCents: progress.purchaseSnapshot.bundlePriceCents,
    status: progress.voidedAt ? "VOIDED" : "RECORDED",
    originBookingId: String(progress.originBookingId),
    validity: contract
      ? {
          mode: contract.validity.mode,
          expiresAt:
            contract.validity.mode === "FINITE" ? contract.validity.expiresAt.toISOString() : null,
          timezone: contract.validity.mode === "FINITE" ? contract.validity.timezone : null,
        }
      : null,
    penalty: contract
      ? {
          appointmentCapCents: contract.penalty.appointmentCapCents,
          lifetimeCapCents: contract.penalty.lifetimeCapCents,
          purchaseDepositOffset: false,
        }
      : null,
    purchaseFinancials: origin
      ? {
          totalCents: origin.financials.totalCents,
          depositCents: origin.financials.depositCents,
          ...computePackageBalanceSettlement(origin),
          venueAttestedCents: origin.completionPayment?.paid
            ? (origin.completionPayment.amountCents ?? 0)
            : 0,
        }
      : null,
    actionsAvailable: false as const,
    items,
    sessions: progress.sessions.map((attempt) => {
      const booking = byId.get(String(attempt.bookingId));
      const line = booking?.serviceLines.find(
        (l) =>
          String(l.pricingInput.packageProgressId) === String(progress._id) &&
          String(l.pricingInput.packageItemId) === String(attempt.packageItemId) &&
          String(l.serviceId) === String(attempt.serviceId),
      );
      return {
        bookingId: String(attempt.bookingId),
        itemId: String(attempt.packageItemId),
        status: attempt.status,
        restoration: attempt.resolution?.restorationDisposition ?? null,
        booking:
          booking && line
            ? {
                status: booking.status,
                role: line.packageContext?.role ?? "UNKNOWN",
                startAt: booking.schedule.startAt.toISOString(),
                endAt: booking.schedule.endAt.toISOString(),
                timezone: booking.schedule.timezone,
                staffId: String(line.responsibleStaffMembershipId),
                staffName: line.staffSnapshot
                  ? [line.staffSnapshot.firstName, line.staffSnapshot.lastName]
                      .filter(Boolean)
                      .join(" ")
                  : null,
                occupiedDurationMin: line.schedulingSnapshot?.occupiedDurationMin ?? null,
                travelFeeCents: booking.financials.travelFeeCents,
                addonsSubtotalCents: booking.financials.addonsSubtotalCents,
                depositCents: booking.financials.depositCents,
                ...computePackageBalanceSettlement(booking),
                venueAttestedCents: booking.completionPayment?.paid
                  ? (booking.completionPayment.amountCents ?? 0)
                  : 0,
              }
            : null,
      };
    }),
  };
}
