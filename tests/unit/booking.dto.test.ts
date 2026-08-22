import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  toBookingCalendarEntryDto,
  toBookingDetailDto,
  toBookingListItemDto,
} from "../../src/modules/booking/booking.dto.js";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";

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

describe("booking.dto mappers (Batch 6 frontend-facing fields)", () => {
  it("toBookingListItemDto exposes businessClientId, staffNames, platformFeeCents, depositCents", () => {
    const booking = buildBooking();
    const dto = toBookingListItemDto(booking);

    expect(dto.businessClientId).toBe(String(booking.customer.businessClientId));
    expect(dto.staffNames).toEqual(["George Staff"]);
    expect(dto.platformFeeCents).toBe(1000);
    expect(dto.depositCents).toBe(1000);
    expect(dto.totalCents).toBe(5000);
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
});
