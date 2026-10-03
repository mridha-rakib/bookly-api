import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  toBookingCalendarEntryDto,
  toBookingDetailDto,
  toBookingListItemDto,
} from "../../src/modules/booking/booking.dto.js";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import type { PackageProgressDocument } from "../../src/modules/package-progress/package-progress.model.js";

/**
 * Batch 6 — the frontend Business Owner booking screens (List/Calendar/Detail) read these
 * mapper functions directly; this file locks down the exact fields they depend on
 * (staffNames/businessClientId/platformFeeCents/depositCents on the list DTO, source/staffNames/
 * totalCents/currency on the calendar DTO, noShowStartedAt/noShowDeadlineAt on the detail DTO)
 * so a future refactor can't silently drop one without a test failing.
 */
const buildBooking = (overrides: Partial<BookingDocument> = {}): BookingDocument => {
  const now = new Date("2026-08-25T10:00:00.000Z");
  const staffMembershipId = new Types.ObjectId();

  return {
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    reference: "BK-TEST0001",
    source: "BOOKLY_MANAGED",
    status: "UPCOMING",
    customer: {
      businessClientId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      contact: {
        firstName: "Jane",
        lastName: "Doe",
        normalizedEmail: "jane@example.com",
        phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
      },
    },
    createdBy: { actorRole: "CUSTOMER", actorUserId: new Types.ObjectId() },
    fulfilment: { mode: "AT_BUSINESS_LOCATION" },
    serviceLines: [
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
        staffSnapshot: { firstName: "George", lastName: "Staff" },
        responsibleStaffMembershipId: staffMembershipId,
        addons: [],
        pricingInput: {},
        amountCents: 5000,
        reservationId: new Types.ObjectId(),
      },
    ],
    financials: {
      currency: "EUR",
      servicesSubtotalCents: 5000,
      addonsSubtotalCents: 0,
      serviceDiscountCents: 0,
      travelFeeCents: 0,
      eligiblePlatformFeeBasisCents: 5000,
      platformFeeCents: 1000,
      depositCents: 1000,
      balanceDueCents: 4000,
      totalCents: 5000,
    },
    schedule: {
      timezone: "Europe/Nicosia",
      startAt: now,
      endAt: new Date(now.getTime() + 30 * 60_000),
    },
    customerRescheduleCount: 0,
    rescheduleHistory: [],
    eventHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as BookingDocument;
};

const requireFirstLine = (booking: BookingDocument): BookingDocument["serviceLines"][number] => {
  const line = booking.serviceLines[0];
  if (!line) throw new Error("Test fixture requires one service line");
  return line;
};

const packageLine = (
  sessionIndex: number,
  sessionsInPackage = 3,
  packageProgressId = new Types.ObjectId(),
): BookingDocument["serviceLines"][number] => ({
  ...requireFirstLine(buildBooking()),
  serviceId: new Types.ObjectId(),
  serviceSnapshot: { name: "Treatment package", pricingMode: "PACKAGE", durationMin: 30 },
  pricingInput: { packageProgressId, sessionIndex, sessionsInPackage },
});

describe("booking.dto mappers (Batch 6 frontend-facing fields)", () => {
  it("toBookingListItemDto exposes businessClientId, staffNames, platformFeeCents, depositCents", () => {
    const booking = buildBooking();
    const dto = toBookingListItemDto(booking);

    expect(dto.businessClientId).toBe(String(booking.customer.businessClientId));
    expect(dto.staffNames).toEqual(["George Staff"]);
    expect(dto.platformFeeCents).toBe(1000);
    expect(dto.depositCents).toBe(1000);
    expect(dto.totalCents).toBe(5000);
    expect(dto.packageSessions).toEqual([]);
  });

  it("maps compact package identity from every valid package-linked line without using the first line", () => {
    const normalLine = requireFirstLine(buildBooking());
    const linkedLine = packageLine(2);
    const booking = buildBooking({
      status: "CANCELLED_BY_CUSTOMER",
      serviceLines: [normalLine, linkedLine],
    });

    expect(toBookingListItemDto(booking).packageSessions).toEqual([
      {
        packageProgressId: String(linkedLine.pricingInput.packageProgressId),
        sessionIndex: 2,
        sessionsInPackage: 3,
      },
    ]);
    expect(toBookingCalendarEntryDto(booking).packageSessions).toEqual(
      toBookingListItemDto(booking).packageSessions,
    );
  });

  it("retains origin, later, completed, and reused session identity per Booking", () => {
    const packageProgressId = new Types.ObjectId();
    const bookings = [
      buildBooking({ serviceLines: [packageLine(1, 3, packageProgressId)] }),
      buildBooking({ serviceLines: [packageLine(2, 3, packageProgressId)] }),
      buildBooking({ status: "COMPLETED", serviceLines: [packageLine(2, 3, packageProgressId)] }),
    ];

    expect(bookings.map((booking) => toBookingListItemDto(booking).packageSessions[0])).toEqual([
      { packageProgressId: String(packageProgressId), sessionIndex: 1, sessionsInPackage: 3 },
      { packageProgressId: String(packageProgressId), sessionIndex: 2, sessionsInPackage: 3 },
      { packageProgressId: String(packageProgressId), sessionIndex: 2, sessionsInPackage: 3 },
    ]);
    expect(String(bookings[1]?._id)).not.toBe(String(bookings[2]?._id));
  });

  it("does not invent modern identity for a legacy package line without complete linkage", () => {
    const legacyLine = packageLine(1);
    legacyLine.pricingInput = { sessionsInPackage: 3 };
    const booking = buildBooking({ serviceLines: [legacyLine] });

    expect(toBookingListItemDto(booking).packageSessions).toEqual([]);
    expect(toBookingCalendarEntryDto(booking).packageSessions).toEqual([]);
  });

  it("toBookingListItemDto dedupes staff names across multiple lines with the same staff", () => {
    const booking = buildBooking();
    const secondLine = { ...booking.serviceLines[0], serviceId: new Types.ObjectId() };
    const dto = toBookingListItemDto({
      ...booking,
      serviceLines: [booking.serviceLines[0], secondLine],
    } as BookingDocument);

    expect(dto.staffNames).toEqual(["George Staff"]);
  });

  it("toBookingCalendarEntryDto exposes source, staffNames, totalCents, currency", () => {
    const booking = buildBooking({ source: "MANUAL" });
    const dto = toBookingCalendarEntryDto(booking);

    expect(dto.source).toBe("MANUAL");
    expect(dto.staffNames).toEqual(["George Staff"]);
    expect(dto.totalCents).toBe(5000);
    expect(dto.currency).toBe("EUR");
  });

  it("toBookingDetailDto exposes noShowStartedAt/noShowDeadlineAt only when both are set", () => {
    const withoutNoShow = toBookingDetailDto(buildBooking());
    expect(withoutNoShow.noShowStartedAt).toBeUndefined();
    expect(withoutNoShow.noShowDeadlineAt).toBeUndefined();

    const startedAt = new Date("2026-08-25T11:00:00.000Z");
    const deadlineAt = new Date("2026-08-25T12:30:00.000Z");
    const withNoShow = toBookingDetailDto(
      buildBooking({ status: "PENDING", noShowStartedAt: startedAt, noShowDeadlineAt: deadlineAt }),
    );
    expect(withNoShow.noShowStartedAt).toBe(startedAt.toISOString());
    expect(withNoShow.noShowDeadlineAt).toBe(deadlineAt.toISOString());
  });

  it("toBookingDetailDto exposes completionPayment exactly as persisted", () => {
    const recordedAt = new Date("2026-08-25T13:00:00.000Z");
    const dto = toBookingDetailDto(
      buildBooking({
        status: "COMPLETED",
        completionPayment: {
          paid: true,
          amountCents: 4000,
          recordedAt,
          recordedBy: new Types.ObjectId(),
        },
      }),
    );

    expect(dto.completionPayment).toEqual({
      paid: true,
      amountCents: 4000,
      recordedAt: recordedAt.toISOString(),
    });
  });

  it("derives actual online payment from the real promo charge, including a full discount", () => {
    expect(toBookingDetailDto(buildBooking()).paymentSummary.actualOnlinePaidCents).toBe(1000);
    expect(
      toBookingDetailDto(buildBooking({ source: "MANUAL" })).paymentSummary.actualOnlinePaidCents,
    ).toBe(0);

    const partialPromo = toBookingDetailDto(
      buildBooking({
        promo: {
          promoId: new Types.ObjectId(),
          code: "SAVE5",
          type: "FIXED",
          value: 500,
          discountCents: 500,
          chargeCents: 500,
          fundingOwner: "BOOKLY",
          appliedAt: new Date("2026-08-20T10:00:00.000Z"),
        },
      }),
    );
    expect(partialPromo.financials.depositCents).toBe(1000);
    expect(partialPromo.paymentSummary.actualOnlinePaidCents).toBe(500);

    const fullPromo = toBookingDetailDto(
      buildBooking({
        promo: {
          promoId: new Types.ObjectId(),
          code: "FREE",
          type: "PERCENTAGE",
          value: 100,
          discountCents: 1000,
          chargeCents: 0,
          fundingOwner: "BOOKLY",
          appliedAt: new Date("2026-08-20T10:00:00.000Z"),
        },
      }),
    );
    expect(fullPromo.paymentSummary.actualOnlinePaidCents).toBe(0);
  });

  it("derives every venue settlement state without mutating the original balance", () => {
    expect(toBookingDetailDto(buildBooking()).paymentSummary).toMatchObject({
      originalVenueBalanceCents: 4000,
      venuePaidCents: 0,
      outstandingVenueBalanceCents: 4000,
      venueSettlementStatus: "NOT_RECORDED",
    });

    const recordedAt = new Date("2026-08-25T13:00:00.000Z");
    const recordedBy = new Types.ObjectId();
    const notPaid = toBookingDetailDto(
      buildBooking({ completionPayment: { paid: false, recordedAt, recordedBy } }),
    );
    expect(notPaid.paymentSummary.venueSettlementStatus).toBe("NOT_PAID");
    expect(notPaid.paymentSummary.outstandingVenueBalanceCents).toBe(4000);

    const partial = toBookingDetailDto(
      buildBooking({
        completionPayment: { paid: true, amountCents: 1500, recordedAt, recordedBy },
      }),
    );
    expect(partial.paymentSummary.venueSettlementStatus).toBe("PARTIALLY_PAID");
    expect(partial.paymentSummary.outstandingVenueBalanceCents).toBe(2500);

    const full = toBookingDetailDto(
      buildBooking({
        completionPayment: { paid: true, amountCents: 4000, recordedAt, recordedBy },
      }),
    );
    expect(full.paymentSummary.venueSettlementStatus).toBe("PAID_IN_FULL");
    expect(full.paymentSummary.outstandingVenueBalanceCents).toBe(0);
  });

  it("returns no package summary for a normal booking", () => {
    expect(toBookingDetailDto(buildBooking()).packageSessions).toEqual([]);
  });

  it("maps authoritative origin identity, counters, balance gate, and later-session identity", () => {
    const packageProgressId = new Types.ObjectId();
    const origin = buildBooking();
    const originLine = requireFirstLine(origin);
    originLine.serviceSnapshot.pricingMode = "PACKAGE";
    originLine.pricingInput = {
      packageProgressId,
      sessionIndex: 1,
      sessionsInPackage: 3,
    };
    const progress = {
      _id: packageProgressId,
      businessId: origin.businessId,
      customerUserId: origin.customer.customerUserId,
      businessClientId: origin.customer.businessClientId,
      serviceId: originLine.serviceId,
      totalSessions: 3,
      remainingSessions: 2,
      completedSessions: 0,
      sessions: [{ sessionIndex: 1, bookingId: origin._id, status: "SCHEDULED" }],
      originBookingId: origin._id,
      purchaseSnapshot: {
        name: "Three-session package",
        bundlePriceCents: 5000,
        durationMin: 30,
        sessionsInPackage: 3,
      },
      createdAt: origin.createdAt,
      updatedAt: origin.updatedAt,
    } as PackageProgressDocument;

    const awaiting = toBookingDetailDto(origin, [{ progress, originBooking: origin }]);
    expect(awaiting.packageSessions[0]).toMatchObject({
      isOriginSession: true,
      sessionIndex: 1,
      sessionsInPackage: 3,
      packageStatus: "AWAITING_BALANCE",
      remainingSessions: 2,
      completedSessions: 0,
      balanceSettled: false,
      outstandingBalanceCents: 4000,
      schedulingUnlocked: false,
    });

    const settledOrigin = buildBooking({
      _id: origin._id,
      completionPayment: {
        paid: true,
        amountCents: 4000,
        recordedAt: new Date("2026-08-25T13:00:00.000Z"),
        recordedBy: new Types.ObjectId(),
      },
    });
    const later = buildBooking({ businessId: origin.businessId, customer: origin.customer });
    const laterLine = requireFirstLine(later);
    laterLine.serviceId = originLine.serviceId;
    laterLine.serviceSnapshot.pricingMode = "PACKAGE";
    laterLine.pricingInput = {
      packageProgressId,
      sessionIndex: 2,
      sessionsInPackage: 3,
    };
    progress.sessions.push({ sessionIndex: 2, bookingId: later._id, status: "SCHEDULED" });
    const laterDto = toBookingDetailDto(later, [{ progress, originBooking: settledOrigin }]);
    expect(laterDto.packageSessions[0]).toMatchObject({
      isOriginSession: false,
      sessionIndex: 2,
      packageStatus: "ACTIVE",
      balanceSettled: true,
      schedulingUnlocked: true,
    });
    expect(settledOrigin.status).toBe("UPCOMING");

    const partialOrigin = buildBooking({
      _id: origin._id,
      status: "COMPLETED",
      completionPayment: {
        paid: true,
        amountCents: 1000,
        recordedAt: new Date("2026-08-25T13:00:00.000Z"),
        recordedBy: new Types.ObjectId(),
      },
    });
    expect(
      toBookingDetailDto(origin, [{ progress, originBooking: partialOrigin }]).packageSessions[0],
    ).toMatchObject({
      packageStatus: "AWAITING_BALANCE",
      balanceSettled: false,
      outstandingBalanceCents: 3000,
      schedulingUnlocked: false,
    });

    progress.remainingSessions = 0;
    expect(
      toBookingDetailDto(origin, [{ progress, originBooking: settledOrigin }]).packageSessions[0],
    ).toMatchObject({ packageStatus: "DEPLETED", schedulingUnlocked: false });

    progress.voidedAt = new Date("2026-08-26T10:00:00.000Z");
    expect(
      toBookingDetailDto(origin, [{ progress, originBooking: settledOrigin }]).packageSessions[0],
    ).toMatchObject({ packageStatus: "VOIDED", schedulingUnlocked: false });
  });

  it("degrades safely when a package link cannot be resolved in the scoped aggregate read", () => {
    const booking = buildBooking();
    requireFirstLine(booking).pricingInput = {
      packageProgressId: new Types.ObjectId(),
      sessionIndex: 1,
      sessionsInPackage: 3,
    };
    const dto = toBookingDetailDto(booking, []);
    expect(dto.serviceLines[0]?.packageProgressId).toBeDefined();
    expect(dto.packageSessions).toEqual([]);
  });

  it("rejects a same-customer aggregate that does not contain this Booking relationship", () => {
    const packageProgressId = new Types.ObjectId();
    const booking = buildBooking();
    const bookingLine = requireFirstLine(booking);
    bookingLine.pricingInput = {
      packageProgressId,
      sessionIndex: 2,
      sessionsInPackage: 3,
    };
    const unrelatedProgress = {
      _id: packageProgressId,
      businessId: booking.businessId,
      customerUserId: booking.customer.customerUserId,
      businessClientId: booking.customer.businessClientId,
      serviceId: bookingLine.serviceId,
      totalSessions: 3,
      remainingSessions: 1,
      completedSessions: 1,
      sessions: [{ sessionIndex: 2, bookingId: new Types.ObjectId(), status: "SCHEDULED" }],
      originBookingId: new Types.ObjectId(),
      purchaseSnapshot: {
        name: "Other package",
        bundlePriceCents: 5000,
        durationMin: 30,
        sessionsInPackage: 3,
      },
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    } as PackageProgressDocument;

    expect(
      toBookingDetailDto(booking, [{ progress: unrelatedProgress, originBooking: buildBooking() }])
        .packageSessions,
    ).toEqual([]);
  });
});
