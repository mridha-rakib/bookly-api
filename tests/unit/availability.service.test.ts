import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { AvailabilityService } from "../../src/modules/availability/availability.service.js";
import type { BookingSlotReservationDocument } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessOpeningHoursDocument } from "../../src/modules/business-hours/business-hours.model.js";
import type { ServiceDocument } from "../../src/modules/services/service.model.js";
import type { StaffMembershipDocument } from "../../src/modules/staff/staff.model.js";
import type { StaffScheduleDocument } from "../../src/modules/staff/staff-schedule.model.js";
import type { StaffTimeOffDocument } from "../../src/modules/staff/staff-time-off.model.js";

const TIMEZONE = "Europe/Nicosia";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Ledra Barbers",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "APPROVED",
    visitType: "AT_BUSINESS_LOCATION",
    timezone: TIMEZONE,
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great business",
    category: "Barber",
    subcategories: ["Haircut"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as BusinessDocument;

const buildFixedService = (
  businessId: Types.ObjectId,
  staffIds: Types.ObjectId[],
  overrides: Partial<ServiceDocument> = {},
): ServiceDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId,
    status: "ACTIVE",
    isFeatured: false,
    isPackageDeal: false,
    category: "Barber",
    name: "Haircut",
    pricingMode: "FIXED",
    fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 30 },
    sessionExpiryAlert: { enabled: false },
    scheduleMode: "AUTO",
    manualSchedule: [],
    servedCities: [],
    assignedStaffMembershipIds: staffIds,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ServiceDocument;

const buildStaff = (
  businessId: Types.ObjectId,
  overrides: Partial<StaffMembershipDocument> = {},
): StaffMembershipDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    businessId,
    role: "STAFF",
    employmentActive: true,
    createdByUserId: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as StaffMembershipDocument;

const buildSchedule = (
  membershipId: Types.ObjectId,
  businessId: Types.ObjectId,
  days: StaffScheduleDocument["days"],
): StaffScheduleDocument =>
  ({
    _id: new Types.ObjectId(),
    membershipId,
    businessId,
    days,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as StaffScheduleDocument;

const buildOpeningHours = (
  businessId: Types.ObjectId,
  days: BusinessOpeningHoursDocument["days"],
): BusinessOpeningHoursDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId,
    days,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as BusinessOpeningHoursDocument;

type Harness = ReturnType<typeof buildHarness>;

function buildHarness() {
  const businessRepository = { findById: vi.fn() };
  const serviceRepository = { findById: vi.fn() };
  const staffRepository = { findActiveById: vi.fn(), findManyByIdsForBusiness: vi.fn() };
  const staffScheduleRepository = { findManyByMembershipIds: vi.fn().mockResolvedValue([]) };
  const staffTimeOffRepository = {
    findManyByMembershipIdsOverlappingRange: vi.fn().mockResolvedValue([]),
  };
  const businessHoursRepository = { findByBusinessId: vi.fn().mockResolvedValue(null) };
  const businessBookingSettingsRepository = { findByBusinessId: vi.fn().mockResolvedValue(null) };
  const businessTravelSettingsRepository = { findByBusinessId: vi.fn().mockResolvedValue(null) };
  const reservationRepository = { findManyForStaffInDateRange: vi.fn().mockResolvedValue([]) };

  const service = new AvailabilityService(
    businessRepository as never,
    serviceRepository as never,
    staffRepository as never,
    staffScheduleRepository as never,
    staffTimeOffRepository as never,
    businessHoursRepository as never,
    businessBookingSettingsRepository as never,
    businessTravelSettingsRepository as never,
    reservationRepository as never,
  );

  return {
    service,
    businessRepository,
    serviceRepository,
    staffRepository,
    staffScheduleRepository,
    staffTimeOffRepository,
    businessHoursRepository,
    businessBookingSettingsRepository,
    businessTravelSettingsRepository,
    reservationRepository,
  };
}

/** Wires a fully-open Mon-Sun 09:00-18:00 schedule for the given staff, and a matching
 * Business opening-hours document — the common baseline most tests start from. */
function wireStandardOpenSchedule(
  harness: Harness,
  business: BusinessDocument,
  staff: StaffMembershipDocument,
) {
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ] as const;

  harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
    buildOpeningHours(
      business._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    ),
  );
  harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
    buildSchedule(
      staff._id,
      business._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    ),
  ]);
}

describe("AvailabilityService — slot generation (AUTO)", () => {
  it("generates candidate starts spaced by bookingIntervalMin, never past the boundary", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 30 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    // Narrow the business open window to prove the boundary is respected exactly.
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "11:00" }] },
      ]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25", // a Tuesday
      toDate: "2026-08-25",
    });

    // 60-minute service, 30-minute interval, 09:00-11:00 window: 09:00, 09:30, 10:00 fit
    // (10:00+60=11:00, exactly the boundary); 10:30 would end at 11:30, past the boundary.
    const day = result.days[0]!;
    expect(day.isOpen).toBe(true);
    expect(day.slots.map((s) => s.startAt)).toEqual([
      "2026-08-25T06:00:00.000Z",
      "2026-08-25T06:30:00.000Z",
      "2026-08-25T07:00:00.000Z",
    ]);
    expect(day.slots.every((s) => s.source === "AUTO")).toBe(true);
  });

  it("supports multiple opening intervals per day and never bridges the closed gap", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        {
          dayOfWeek: "TUESDAY",
          isOpen: true,
          slots: [
            { startTime: "09:00", endTime: "13:00" },
            { startTime: "16:00", endTime: "20:00" },
          ],
        },
      ]),
    );
    // Staff shift matches the full business window (09:00-20:00) — this test isolates
    // multi-interval business-hours behavior, not staff-schedule interaction (covered
    // separately below).
    harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "20:00" }] },
      ]),
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    const starts = result.days[0]!.slots.map((s) => s.startAt);
    // No candidate starting in [13:00,16:00) — the closed gap must never be bridged.
    expect(starts).toEqual([
      "2026-08-25T06:00:00.000Z", // 09:00
      "2026-08-25T07:00:00.000Z", // 10:00
      "2026-08-25T08:00:00.000Z", // 11:00
      "2026-08-25T09:00:00.000Z", // 12:00
      "2026-08-25T13:00:00.000Z", // 16:00
      "2026-08-25T14:00:00.000Z", // 17:00
      "2026-08-25T15:00:00.000Z", // 18:00
      "2026-08-25T16:00:00.000Z", // 19:00
    ]);
  });

  it("occupies duration + buffer + processing time when fitting candidates, not duration alone", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: {
        priceCents: 2000,
        durationMin: 30,
        bufferAfterMin: 15,
        processingTimeMin: 15,
        bookingIntervalMin: 30,
      },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:30" }] },
      ]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    // occupiedMin = 30+15+15 = 60. Window is 90 minutes: only 09:00 fits (09:00-10:00);
    // 09:30 would occupy until 10:30, which is exactly the boundary — 09:30+60<=90 so it
    // should ALSO fit (10:30 <= 10:30). Confirm both candidates and no third.
    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
      "2026-08-25T06:00:00.000Z",
      "2026-08-25T06:30:00.000Z",
    ]);
  });

  it("falls back to duration-spaced (back-to-back) candidates when bookingIntervalMin is not configured", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 45 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:30" }] },
      ]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
      "2026-08-25T06:00:00.000Z", // 09:00
      "2026-08-25T06:45:00.000Z", // 09:45 (back-to-back, not overlapping)
    ]);
  });

  it("reports isOpen: false (not an empty-but-open day) when the business has no matching opening-hours day", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [{ dayOfWeek: "TUESDAY", isOpen: false, slots: [] }]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]).toEqual({ date: "2026-08-25", isOpen: false, slots: [] });
  });

  it("never fabricates availability for a Business with no BusinessOpeningHours document at all", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(null); // not configured

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]).toEqual({ date: "2026-08-25", isOpen: false, slots: [] });
  });
});

describe("AvailabilityService — MANUAL schedule mode", () => {
  it("only offers explicitly-configured times, never generating additional times around them", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      scheduleMode: "MANUAL",
      manualSchedule: [{ dayOfWeek: "TUESDAY", isOpen: true, times: ["10:00", "14:30", "09:00"] }],
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 30 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    // Deliberately narrow business hours — MANUAL must override them, not be bound by them.
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "11:00", endTime: "12:00" }] },
      ]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    // Sorted, exactly the three configured times — 14:30 is outside the (irrelevant) business
    // opening window and still offered, proving MANUAL overrides business hours.
    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
      "2026-08-25T06:00:00.000Z", // 09:00
      "2026-08-25T07:00:00.000Z", // 10:00
      "2026-08-25T11:30:00.000Z", // 14:30
    ]);
    expect(result.days[0]!.slots.every((s) => s.source === "MANUAL")).toBe(true);
  });

  it("offers nothing on a day the manual schedule marks closed, even if business hours are open", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      scheduleMode: "MANUAL",
      manualSchedule: [{ dayOfWeek: "TUESDAY", isOpen: false, times: [] }],
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]).toEqual({ date: "2026-08-25", isOpen: false, slots: [] });
  });
});

describe("AvailabilityService — staff intersection", () => {
  it("excludes a staff member whose schedule does not cover the candidate interval", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "18:00" }] },
      ]),
    );
    // Staff only works 09:00-10:30 — narrower than the business's own hours, and not a whole
    // multiple of the 60-minute booking interval, so exactly one candidate (09:00-10:00)
    // fits; the next candidate (10:00-11:00) would need the shift to extend to 11:00.
    harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "10:30" }] },
      ]),
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    // Only the 09:00-10:00 slot fits fully inside the staff's 09:00-11:00 shift.
    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual(["2026-08-25T06:00:00.000Z"]);
  });

  it("excludes a staff member with no shift configured for that weekday at all", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "18:00" }] },
      ]),
    );
    harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "MONDAY", intervals: [{ startTime: "09:00", endTime: "18:00" }] },
      ]),
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots).toEqual([]);
  });

  it("excludes a staff member on time off that day, even with a matching schedule", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        membershipId: staff._id,
        businessId: business._id,
        type: "ANNUAL_HOLIDAY",
        startDate: "2026-08-24",
        endDate: "2026-08-26",
        createdByUserId: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies StaffTimeOffDocument,
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots).toEqual([]);
  });

  describe("split-shift Staff intervals (multiple working intervals per day)", () => {
    it("offers slots inside EACH interval of a split shift, but never bridges the break between them", async () => {
      const harness = buildHarness();
      const business = buildBusiness();
      const staff = buildStaff(business._id);
      const service = buildFixedService(business._id, [staff._id], {
        fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
      });

      harness.businessRepository.findById.mockResolvedValue(business);
      harness.serviceRepository.findById.mockResolvedValue(service);
      harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
      // Business is open the whole day; the staff member's OWN schedule is the split shift
      // under test: 09:00-13:00 and 14:00-17:00, with a 13:00-14:00 break between them.
      harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(business._id, [
          { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );
      harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(staff._id, business._id, [
          {
            dayOfWeek: "TUESDAY",
            intervals: [
              { startTime: "09:00", endTime: "13:00" },
              { startTime: "14:00", endTime: "17:00" },
            ],
          },
        ]),
      ]);

      const result = await harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      });

      // 12:00-13:00 fits fully inside the first interval; 13:00-14:00 would bridge the
      // break and must never appear; 14:00-15:00 and later fit the second interval.
      expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
        "2026-08-25T06:00:00.000Z", // 09:00
        "2026-08-25T07:00:00.000Z", // 10:00
        "2026-08-25T08:00:00.000Z", // 11:00
        "2026-08-25T09:00:00.000Z", // 12:00
        "2026-08-25T11:00:00.000Z", // 14:00
        "2026-08-25T12:00:00.000Z", // 15:00
        "2026-08-25T13:00:00.000Z", // 16:00
      ]);
    });

    it("rejects a candidate whose occupied window (duration+buffer+processing) crosses the gap between intervals", async () => {
      const harness = buildHarness();
      const business = buildBusiness();
      const staff = buildStaff(business._id);
      // 45-minute service with a 30-minute buffer: occupiedMin=75. A 12:30 start would need
      // to occupy until 13:45, which crosses straight through the 13:00-14:00 break.
      const service = buildFixedService(business._id, [staff._id], {
        fixedPricing: {
          priceCents: 2000,
          durationMin: 45,
          bufferAfterMin: 30,
          bookingIntervalMin: 30,
        },
      });

      harness.businessRepository.findById.mockResolvedValue(business);
      harness.serviceRepository.findById.mockResolvedValue(service);
      harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
      harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(business._id, [
          { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );
      harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(staff._id, business._id, [
          {
            dayOfWeek: "TUESDAY",
            intervals: [
              { startTime: "09:00", endTime: "13:00" },
              { startTime: "14:00", endTime: "17:00" },
            ],
          },
        ]),
      ]);

      const result = await harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      });

      const starts = result.days[0]!.slots.map((s) => s.startAt);
      // Candidates step every 30min from 09:00 local. 11:30 occupies 11:30-12:45 — fully
      // inside the first interval [09:00,13:00) — and must be offered.
      expect(starts).toContain("2026-08-25T08:30:00.000Z"); // 11:30 local
      // 12:00 would occupy 12:00-13:15, crossing straight through the 13:00-14:00 break —
      // must NEVER be offered even though 12:00 itself is still inside the first interval.
      expect(starts).not.toContain("2026-08-25T09:00:00.000Z"); // 12:00 local
      // 12:30 would occupy 12:30-13:45 — also crosses the break — must never be offered.
      expect(starts).not.toContain("2026-08-25T09:30:00.000Z"); // 12:30 local
      // 13:00/13:30 fall entirely inside the break itself (no interval covers them at all).
      expect(starts).not.toContain("2026-08-25T10:00:00.000Z"); // 13:00 local
      expect(starts).not.toContain("2026-08-25T10:30:00.000Z"); // 13:30 local
      // 14:00 is the first candidate that fits inside the second interval and must reappear.
      expect(starts).toContain("2026-08-25T11:00:00.000Z"); // 14:00 local
    });

    it("assertSlotIsBookable (the shared write-time gate) rejects a booking that bridges the gap between two intervals", async () => {
      const harness = buildHarness();
      const business = buildBusiness();
      const staff = buildStaff(business._id);
      const service = buildFixedService(business._id, [staff._id], {
        fixedPricing: { priceCents: 2000, durationMin: 60 },
      });

      harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(staff._id, business._id, [
          {
            dayOfWeek: "TUESDAY",
            intervals: [
              { startTime: "09:00", endTime: "13:00" },
              { startTime: "14:00", endTime: "17:00" },
            ],
          },
        ]),
      ]);
      harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(business._id, [
          { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );

      // 12:30-13:30 UTC-local (Europe/Nicosia is UTC+3 in August) bridges the 13:00-14:00 gap.
      const startAt = new Date("2026-08-25T09:30:00.000Z"); // 12:30 local
      const endAt = new Date("2026-08-25T10:30:00.000Z"); // 13:30 local

      await expect(
        harness.service.assertSlotIsBookable({
          business,
          service,
          staffMembership: staff,
          startAt,
          endAt,
          partySize: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("assertSlotIsBookable accepts a booking that fits entirely inside the second interval of a split shift", async () => {
      const harness = buildHarness();
      const business = buildBusiness();
      const staff = buildStaff(business._id);
      const service = buildFixedService(business._id, [staff._id], {
        fixedPricing: { priceCents: 2000, durationMin: 60 },
      });

      harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(staff._id, business._id, [
          {
            dayOfWeek: "TUESDAY",
            intervals: [
              { startTime: "09:00", endTime: "13:00" },
              { startTime: "14:00", endTime: "17:00" },
            ],
          },
        ]),
      ]);
      harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(business._id, [
          { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );

      const startAt = new Date("2026-08-25T11:00:00.000Z"); // 14:00 local
      const endAt = new Date("2026-08-25T12:00:00.000Z"); // 15:00 local

      const result = await harness.service.assertSlotIsBookable({
        business,
        service,
        staffMembership: staff,
        startAt,
        endAt,
        partySize: 1,
      });

      expect(result).toEqual({ capacityMax: 1 });
    });

    it("a staff member on full-day time off is excluded even when a split shift is configured", async () => {
      const harness = buildHarness();
      const business = buildBusiness();
      const staff = buildStaff(business._id);
      const service = buildFixedService(business._id, [staff._id], {
        fixedPricing: { priceCents: 2000, durationMin: 60 },
      });

      harness.businessRepository.findById.mockResolvedValue(business);
      harness.serviceRepository.findById.mockResolvedValue(service);
      harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
      harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(business._id, [
          { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );
      harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(staff._id, business._id, [
          {
            dayOfWeek: "TUESDAY",
            intervals: [
              { startTime: "09:00", endTime: "13:00" },
              { startTime: "14:00", endTime: "17:00" },
            ],
          },
        ]),
      ]);
      harness.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange.mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          membershipId: staff._id,
          businessId: business._id,
          type: "ANNUAL_HOLIDAY",
          startDate: "2026-08-25",
          endDate: "2026-08-25",
          createdByUserId: new Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies StaffTimeOffDocument,
      ]);

      const result = await harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      });

      expect(result.days[0]!.slots).toEqual([]);
    });
  });

  it("with two eligible staff, offers a slot with both listed if only one is busy elsewhere", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staffA = buildStaff(business._id);
    const staffB = buildStaff(business._id);
    const service = buildFixedService(business._id, [staffA._id, staffB._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staffA, staffB]);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );
    harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staffA._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
      buildSchedule(staffB._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots).toHaveLength(1);
    expect(new Set(result.days[0]!.slots[0]!.eligibleStaffMembershipIds)).toEqual(
      new Set([String(staffA._id), String(staffB._id)]),
    );
  });
});

describe("AvailabilityService — reservation conflicts", () => {
  it("excludes a slot already occupied by an existing exclusive reservation", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "11:00" }] },
      ]),
    );
    harness.reservationRepository.findManyForStaffInDateRange.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        businessId: business._id,
        staffMembershipId: staff._id,
        occupancyDate: "2026-08-25",
        timezone: TIMEZONE,
        intervals: [
          {
            reservationId: new Types.ObjectId(),
            serviceId: new Types.ObjectId(), // a different service, still blocks the timeline
            startAt: new Date("2026-08-25T06:00:00.000Z"),
            endAt: new Date("2026-08-25T07:00:00.000Z"),
            capacityMax: 1,
            capacityUsed: 1,
            status: "CONFIRMED",
            createdAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies BookingSlotReservationDocument,
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual(["2026-08-25T07:00:00.000Z"]);
  });
});

describe("AvailabilityService — capacity (PER_PERSON)", () => {
  const buildGroupService = (businessId: Types.ObjectId, staffId: Types.ObjectId) =>
    ({
      _id: new Types.ObjectId(),
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Fitness",
      name: "Group Class",
      pricingMode: "PER_PERSON",
      perPersonPricing: {
        ratePerPersonCents: 1000,
        minPersons: 1,
        maxPersons: 20,
        durationMin: 60,
        bookingIntervalMin: 60,
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as ServiceDocument;

  it("reports remainingCapacity = capacityMax when no reservation exists yet", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildGroupService(business._id, staff._id);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots[0]!.remainingCapacity).toBe(20);
  });

  it("reports the reduced remainingCapacity when an existing session already has claims", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildGroupService(business._id, staff._id);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );
    harness.reservationRepository.findManyForStaffInDateRange.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        businessId: business._id,
        staffMembershipId: staff._id,
        occupancyDate: "2026-08-25",
        timezone: TIMEZONE,
        intervals: [
          {
            reservationId: new Types.ObjectId(),
            serviceId: service._id,
            startAt: new Date("2026-08-25T06:00:00.000Z"),
            endAt: new Date("2026-08-25T07:00:00.000Z"),
            capacityMax: 20,
            capacityUsed: 18,
            status: "CONFIRMED",
            createdAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies BookingSlotReservationDocument,
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
      partySize: 2,
    });

    expect(result.days[0]!.slots).toHaveLength(1);
    expect(result.days[0]!.slots[0]!.remainingCapacity).toBe(2);
  });

  it("excludes the session once the requested party size exceeds remaining capacity", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildGroupService(business._id, staff._id);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );
    harness.reservationRepository.findManyForStaffInDateRange.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        businessId: business._id,
        staffMembershipId: staff._id,
        occupancyDate: "2026-08-25",
        timezone: TIMEZONE,
        intervals: [
          {
            reservationId: new Types.ObjectId(),
            serviceId: service._id,
            startAt: new Date("2026-08-25T06:00:00.000Z"),
            endAt: new Date("2026-08-25T07:00:00.000Z"),
            capacityMax: 20,
            capacityUsed: 19,
            status: "CONFIRMED",
            createdAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies BookingSlotReservationDocument,
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
      partySize: 2,
    });

    expect(result.days[0]!.slots).toEqual([]);
  });

  it("rejects a party size larger than the service's own capacityMax", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildGroupService(business._id, staff._id);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
        partySize: 21,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("AvailabilityService — travel eligibility", () => {
  const buildTravelBusiness = () => buildBusiness({ visitType: "TRAVEL_TO_CUSTOMER" });

  it("requires a customerCity for a travel-to-customer Business", async () => {
    const harness = buildHarness();
    const business = buildTravelBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      servedCities: ["Larnaca"],
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a city the Service does not serve", async () => {
    const harness = buildHarness();
    const business = buildTravelBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      servedCities: ["Larnaca"],
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
        customerCity: "Nicosia",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a city the Service serves but the Business travel settings mark inactive", async () => {
    const harness = buildHarness();
    const business = buildTravelBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      servedCities: ["Larnaca"],
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.businessTravelSettingsRepository.findByBusinessId.mockResolvedValue({
      _id: new Types.ObjectId(),
      businessId: business._id,
      cities: [{ city: "Larnaca", active: false, feeCents: 0 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
        customerCity: "Larnaca",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("succeeds for an active, served city", async () => {
    const harness = buildHarness();
    const business = buildTravelBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      servedCities: ["Larnaca"],
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(harness, business, staff);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );
    harness.businessTravelSettingsRepository.findByBusinessId.mockResolvedValue({
      _id: new Types.ObjectId(),
      businessId: business._id,
      cities: [{ city: "Larnaca", active: true, feeCents: 500 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
      customerCity: "Larnaca",
    });

    expect(result.days[0]!.slots).toHaveLength(1);
  });
});

describe("AvailabilityService — range validation", () => {
  it("rejects an inverted range", async () => {
    const harness = buildHarness();
    await expect(
      harness.service.getAvailability({
        businessId: String(new Types.ObjectId()),
        serviceId: String(new Types.ObjectId()),
        fromDate: "2026-08-26",
        toDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a range wider than the confirmed maximum", async () => {
    const harness = buildHarness();
    await expect(
      harness.service.getAvailability({
        businessId: String(new Types.ObjectId()),
        serviceId: String(new Types.ObjectId()),
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("AvailabilityService — business/service/staff resolution", () => {
  it("rejects an unknown business", async () => {
    const harness = buildHarness();
    harness.businessRepository.findById.mockResolvedValue(null);

    await expect(
      harness.service.getAvailability({
        businessId: String(new Types.ObjectId()),
        serviceId: String(new Types.ObjectId()),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an archived/inactive Service", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], { status: "ARCHIVED" });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a requested staff member not assigned to the Service", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const otherStaff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findActiveById.mockResolvedValue(otherStaff);

    await expect(
      harness.service.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        staffMembershipId: String(otherStaff._id),
        fromDate: "2026-08-25",
        toDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns an empty (never fabricated) result when a Service has zero assigned staff", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const service = buildFixedService(business._id, []);

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]).toEqual({ date: "2026-08-25", isOpen: false, slots: [] });
  });

  it("excludes an inactive (employmentActive: false) assigned staff member from 'any' resolution", async () => {
    const harness = buildHarness();
    const business = buildBusiness();
    const activeStaff = buildStaff(business._id);
    const inactiveStaff = buildStaff(business._id, { employmentActive: false });
    const service = buildFixedService(business._id, [activeStaff._id, inactiveStaff._id], {
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
    });

    harness.businessRepository.findById.mockResolvedValue(business);
    harness.serviceRepository.findById.mockResolvedValue(service);
    harness.staffRepository.findManyByIdsForBusiness.mockResolvedValue([
      activeStaff,
      inactiveStaff,
    ]);
    harness.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    );
    harness.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(activeStaff._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
      buildSchedule(inactiveStaff._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "10:00" }] },
      ]),
    ]);

    const result = await harness.service.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: "2026-08-25",
      toDate: "2026-08-25",
    });

    expect(result.days[0]!.slots[0]!.eligibleStaffMembershipIds).toEqual([String(activeStaff._id)]);
  });
});
