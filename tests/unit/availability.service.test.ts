import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { businessLocalToUtc } from "../../src/common/time/business-clock.js";
import { getAvailabilityQuerySchema } from "../../src/modules/availability/availability.schema.js";
import { AvailabilityService } from "../../src/modules/availability/availability.service.js";
import type { BookingSlotReservationDocument } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessOpeningHoursDocument } from "../../src/modules/business-hours/business-hours.model.js";
import { catalogAvailabilityQuerySchema } from "../../src/modules/catalog/catalog.schema.js";
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
    expect(result.days[0]!.blockedSlots).toBeUndefined();
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
    expect(result.days[0]!.blockedSlots).toBeUndefined();
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
    expect(result.days[0]!.blockedSlots).toEqual([
      {
        startAt: "2026-08-25T06:00:00.000Z",
        endAt: "2026-08-25T07:00:00.000Z",
        status: "BOOKED",
        source: "AUTO",
      },
    ]);
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

// BOOKING-F1B: exercise the existing public engine, not an alternate duration calculator.
describe("AvailabilityService — requested hourly duration (F1B)", () => {
  const DATE = "2030-08-20"; // Tuesday, Nicosia UTC+3
  function fixture() {
    const h = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const other = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id, other._id], {
      pricingMode: "HOURLY",
      fixedPricing: undefined,
      hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 4, bufferAfterMin: 15 },
    });
    h.businessRepository.findById.mockResolvedValue(business);
    h.serviceRepository.findById.mockResolvedValue(service);
    h.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff, other]);
    h.staffRepository.findActiveById.mockResolvedValue(staff);
    wireStandardOpenSchedule(h, business, staff);
    const shifts = (end = "17:00", split = false) => [
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: end }] },
      ]),
      buildSchedule(other._id, business._id, [
        {
          dayOfWeek: "TUESDAY",
          intervals: split
            ? [
                { startTime: "09:00", endTime: "12:00" },
                { startTime: "13:00", endTime: "17:00" },
              ]
            : [{ startTime: "09:00", endTime: "17:00" }],
        },
      ]),
    ];
    h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue(shifts());
    h.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    );
    const input = {
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    };
    const get = (hours?: number) => h.service.getAvailability({ ...input, hours });
    return { h, business, staff, other, service, input, shifts, get };
  }
  it("omitted hours equals explicit minimum; four hours keeps the two-hour grid and includes buffer", async () => {
    const f = fixture();
    expect(await f.get()).toEqual(await f.get(2));
    const result = await f.get(4);
    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
      `${DATE}T06:00:00.000Z`,
      `${DATE}T08:00:00.000Z`,
    ]);
    expect(
      result.days[0]!.slots.every(
        (s) => Date.parse(s.endAt) - Date.parse(s.startAt) === 255 * 60_000,
      ),
    ).toBe(true);
    // 13:00 + 4h fits opening hours, but the required 15-minute buffer does not.
    expect(result.days[0]!.slots.some((s) => s.startAt === `${DATE}T10:00:00.000Z`)).toBe(false);
    f.service.hourlyPricing!.bufferAfterMin = 0;
    expect((await f.get(4)).days[0]!.slots.some((s) => s.startAt === `${DATE}T10:00:00.000Z`)).toBe(
      true,
    );
  });
  it("accepts fractional hours with the same occupied interval as booking", async () => {
    const result = await fixture().get(2.5);
    expect(result.days[0]!.slots.length).toBeGreaterThan(0);
    expect(
      result.days[0]!.slots.every(
        (s) => Date.parse(s.endAt) - Date.parse(s.startAt) === 165 * 60_000,
      ),
    ).toBe(true);
  });
  it.each([0, -1, 1.5, 4.5, 25, NaN, Infinity, -Infinity])(
    "rejects invalid/out-of-range engine hours %s",
    async (hours) => {
      await expect(fixture().get(hours)).rejects.toMatchObject({
        statusCode: 400,
        message: "Duration is invalid for this service",
      });
    },
  );
  it.each(["FIXED", "PER_PERSON", "PACKAGE"])(
    "rejects explicit hours for %s; omission preserves that mode",
    async (mode) => {
      const f = fixture();
      f.service.isPackageDeal = mode === "PACKAGE";
      f.service.pricingMode = mode === "PACKAGE" ? undefined : (mode as "FIXED" | "PER_PERSON");
      f.service.fixedPricing = { priceCents: 1000, durationMin: 60 };
      f.service.perPersonPricing = {
        ratePerPersonCents: 1000,
        minPersons: 1,
        maxPersons: 4,
        durationMin: 60,
      };
      f.service.packagePricing = { bundlePriceCents: 5000, sessionsInPackage: 5, durationMin: 60 };
      await expect(f.get(2)).rejects.toMatchObject({ statusCode: 400 });
      expect((await f.get()).days[0]!.slots.length).toBeGreaterThan(0);
      if (mode === "PER_PERSON") {
        expect((await f.h.service.getAvailability({ ...f.input, partySize: 4 })).capacityMax).toBe(
          4,
        );
        await expect(
          f.h.service.getAvailability({ ...f.input, partySize: 5 }),
        ).rejects.toMatchObject({ statusCode: 400 });
      }
    },
  );
  it("excludes staff whose break or shift boundary interrupts the full duration", async () => {
    const f = fixture();
    f.h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue(f.shifts("14:00", true));
    const short = (await f.get(2)).days[0]!.slots;
    expect(short[0]!.eligibleStaffMembershipIds).toEqual([
      String(f.staff._id),
      String(f.other._id),
    ]);
    const long = (await f.get(4)).days[0]!.slots;
    expect(long).toHaveLength(1);
    expect(long[0]!.eligibleStaffMembershipIds).toEqual([String(f.staff._id)]);
    // The same start is not offered for explicitly selected split-shift staff either.
    f.h.staffRepository.findActiveById.mockResolvedValue(f.other);
    expect(
      (
        await f.h.service.getAvailability({
          ...f.input,
          hours: 4,
          staffMembershipId: String(f.other._id),
        })
      ).days[0]!.slots,
    ).toEqual([]);
  });
  it("two hours fits before an existing reservation, four hours overlaps and excludes that staff", async () => {
    const f = fixture();
    f.h.reservationRepository.findManyForStaffInDateRange.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        businessId: f.business._id,
        staffMembershipId: f.staff._id,
        occupancyDate: DATE,
        timezone: TIMEZONE,
        intervals: [
          {
            reservationId: new Types.ObjectId(),
            serviceId: new Types.ObjectId(),
            startAt: new Date(`${DATE}T09:00:00Z`),
            endAt: new Date(`${DATE}T10:00:00Z`),
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
    expect((await f.get(2)).days[0]!.slots[0]!.eligibleStaffMembershipIds).toContain(
      String(f.staff._id),
    );
    expect((await f.get(4)).days[0]!.slots[0]!.eligibleStaffMembershipIds).toEqual([
      String(f.other._id),
    ]);
    f.h.staffRepository.findManyByIdsForBusiness.mockResolvedValue([f.staff]);
    expect((await f.get(4)).days[0]!.slots).toEqual([]);
  });
  it("time off removes staff for the requested duration", async () => {
    const f = fixture();
    f.h.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange.mockResolvedValue([
      { membershipId: f.staff._id, startDate: DATE, endDate: DATE },
    ]);
    expect((await f.get(4)).days[0]!.slots[0]!.eligibleStaffMembershipIds).toEqual([
      String(f.other._id),
    ]);
  });
  it.each([2, 2.5, 4])(
    "every returned %s-hour slot passes the unchanged final schedule guard",
    async (hours) => {
      const f = fixture();
      for (const slot of (await f.get(hours)).days[0]!.slots) {
        await expect(
          f.h.service.assertSlotIsBookable({
            business: f.business,
            service: f.service,
            staffMembership: f.staff,
            startAt: new Date(slot.startAt),
            endAt: new Date(slot.endAt),
            partySize: 1,
          }),
        ).resolves.toEqual({ capacityMax: 1 });
      }
      await expect(
        f.h.service.assertSlotIsBookable({
          business: f.business,
          service: f.service,
          staffMembership: f.staff,
          startAt: businessLocalToUtc(TIMEZONE, DATE, "15:00"),
          endAt: businessLocalToUtc(TIMEZONE, DATE, "19:15"),
          partySize: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );
  it.each(["2030-03-31", "2030-10-27"])(
    "daytime DST %s preserves duration, grid and final scheduling parity",
    async (date) => {
      const f = fixture();
      f.h.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(f.business._id, [
          { dayOfWeek: "SUNDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      );
      f.h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(f.staff._id, f.business._id, [
          { dayOfWeek: "SUNDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
        ]),
      ]);
      for (const hours of [2, 4]) {
        const result = await f.h.service.getAvailability({
          ...f.input,
          fromDate: date,
          toDate: date,
          hours,
        });
        expect(result.days[0]!.slots[0]!.startAt).toBe(
          businessLocalToUtc(TIMEZONE, date, "09:00").toISOString(),
        );
        for (const slot of result.days[0]!.slots) {
          expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(
            (hours * 60 + 15) * 60_000,
          );
          await expect(
            f.h.service.assertSlotIsBookable({
              business: f.business,
              service: f.service,
              staffMembership: f.staff,
              startAt: new Date(slot.startAt),
              endAt: new Date(slot.endAt),
              partySize: 1,
            }),
          ).resolves.toEqual({ capacityMax: 1 });
        }
      }
    },
  );
  it.each(["2030-03-31", "2030-10-27"])(
    "characterizes the existing local-minute grid across DST night %s",
    async (date) => {
      const f = fixture();
      f.h.businessHoursRepository.findByBusinessId.mockResolvedValue(
        buildOpeningHours(f.business._id, [
          { dayOfWeek: "SUNDAY", isOpen: true, slots: [{ startTime: "00:00", endTime: "06:00" }] },
        ]),
      );
      f.h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
        buildSchedule(f.staff._id, f.business._id, [
          { dayOfWeek: "SUNDAY", intervals: [{ startTime: "00:00", endTime: "10:00" }] },
        ]),
      ]);
      const input = { ...f.input, fromDate: date, toDate: date };
      expect(await f.h.service.getAvailability(input)).toEqual(
        await f.h.service.getAvailability({ ...input, hours: 2 }),
      );
      for (const hours of [2, 4]) {
        const result = await f.h.service.getAvailability({ ...input, hours });
        expect(result.days[0]!.slots.length).toBeGreaterThan(0);
        for (const slot of result.days[0]!.slots) {
          const endAt = new Date(slot.endAt);
          const insideOpening = endAt <= businessLocalToUtc(TIMEZONE, date, "06:00");
          const check = f.h.service.assertSlotIsBookable({
            business: f.business,
            service: f.service,
            staffMembership: f.staff,
            startAt: new Date(slot.startAt),
            endAt,
            partySize: 1,
          });
          if (insideOpening) await expect(check).resolves.toEqual({ capacityMax: 1 });
          else await expect(check).rejects.toMatchObject({ statusCode: 409 });
        }
      }
      // Existing AUTO candidate fit uses wall-clock minutes. On fall-back night, 02:00 +
      // 4h15m ends at 05:15 in absolute time and passes final validation, but local-minute
      // generation omits it (02:00 + 255 > 06:00). Record this conservative omission;
      // changing the DST/grid policy is outside F1B.
      if (date === "2030-10-27") {
        const startAt = businessLocalToUtc(TIMEZONE, date, "02:00");
        const endAt = new Date(startAt.getTime() + 255 * 60_000);
        expect(
          (await f.h.service.getAvailability({ ...input, hours: 4 })).days[0]!.slots.some(
            (slot) => slot.startAt === startAt.toISOString(),
          ),
        ).toBe(false);
        await expect(
          f.h.service.assertSlotIsBookable({
            business: f.business,
            service: f.service,
            staffMembership: f.staff,
            startAt,
            endAt,
            partySize: 1,
          }),
        ).resolves.toEqual({ capacityMax: 1 });
      }
    },
  );
});

describe.each([getAvailabilityQuerySchema, catalogAvailabilityQuerySchema])(
  "F1B availability query contract",
  (schema) => {
    const dates = { fromDate: "2030-08-20", toDate: "2030-08-20" };
    it("accepts omission and fractional hours, keeps strict fields", () => {
      expect(schema.parse(dates).hours).toBeUndefined();
      expect(schema.parse({ ...dates, hours: "2.5" }).hours).toBe(2.5);
      expect(schema.safeParse({ ...dates, unknown: 1 }).success).toBe(false);
    });
    it.each(["abc", "NaN", "Infinity", "-Infinity", "", "0", "-1", "25"])(
      "rejects malformed/domain hours %s",
      (hours) => {
        expect(schema.safeParse({ ...dates, hours }).success).toBe(false);
      },
    );
  },
);

describe("F1C-A booking-owned engine adapter", () => {
  const DATE = "2030-08-20";
  function fixture(occupiedMinutes = 255) {
    const h = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      pricingMode: "HOURLY",
      hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 3, bufferAfterMin: 0 },
    });
    h.businessRepository.findById.mockResolvedValue(business);
    h.serviceRepository.findById.mockResolvedValue(service);
    h.staffRepository.findManyByIdsForBusiness.mockResolvedValue([staff]);
    wireStandardOpenSchedule(h, business, staff);
    h.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    );
    const line = {
      service,
      staffMembership: staff,
      occupiedMilliseconds: occupiedMinutes * 60_000,
      partySize: 1,
      capacityMax: 1,
    };
    const validateCandidate = vi.fn().mockResolvedValue(true);
    const input = {
      business,
      lines: [line],
      fromDate: DATE,
      toDate: DATE,
      session: { inTransaction: () => true } as never,
      validateCandidate,
    };
    const read = () => h.service.getBookingAvailability(input);
    const reserve = (startTime: string, endTime: string, capacityMax = 1, capacityUsed = 1) => {
      h.reservationRepository.findManyForStaffInDateRange.mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          businessId: business._id,
          staffMembershipId: staff._id,
          occupancyDate: DATE,
          timezone: TIMEZONE,
          createdAt: new Date(),
          updatedAt: new Date(),
          intervals: [
            {
              reservationId: new Types.ObjectId(),
              serviceId: service._id,
              startAt: businessLocalToUtc(TIMEZONE, DATE, startTime),
              endAt: businessLocalToUtc(TIMEZONE, DATE, endTime),
              capacityMax,
              capacityUsed,
              status: "CONFIRMED",
              createdAt: new Date(),
            },
          ],
        },
      ]);
    };
    return { h, business, staff, service, line, input, read, reserve, validateCandidate };
  }
  it("preserves original four hours + 15 minutes after live buffer/bounds edits; generic F1B stays strict", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result.days[0]!.slots.map((s) => s.startAt)).toEqual([
      `${DATE}T06:00:00.000Z`,
      `${DATE}T08:00:00.000Z`,
    ]);
    expect(
      result.days[0]!.slots.every(
        (s) => Date.parse(s.endAt) - Date.parse(s.startAt) === 255 * 60_000,
      ),
    ).toBe(true);
    await expect(
      f.h.service.getAvailability({
        businessId: String(f.business._id),
        serviceId: String(f.service._id),
        fromDate: DATE,
        toDate: DATE,
        hours: 4,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it.each([150, 165, 60])(
    "preserves an original %s-minute interval without adding live timing again",
    async (minutes) => {
      const f = fixture(minutes);
      f.service.hourlyPricing!.bufferAfterMin = 60;
      const result = await f.read();
      expect(result.days[0]!.slots.length).toBeGreaterThan(0);
      expect(
        result.days[0]!.slots.every(
          (s) => Date.parse(s.endAt) - Date.parse(s.startAt) === minutes * 60_000,
        ),
      ).toBe(true);
    },
  );
  it("keeps partial and exclusive exact self-overlap blocked, including original buffer", async () => {
    const f = fixture(135);
    f.reserve("09:00", "11:15");
    const slots = (await f.read()).days[0]!.slots;
    expect(slots.map((s) => s.startAt)).toEqual([`${DATE}T10:00:00.000Z`]); // 13:00 only
    expect(slots[0]!.eligibleStaffMembershipIds).toEqual([String(f.staff._id)]);
  });
  it("uses full original group size and characterizes exact same-slot spare-capacity semantics", async () => {
    const f = fixture(60);
    f.service.pricingMode = "PER_PERSON";
    f.service.perPersonPricing = {
      ratePerPersonCents: 1000,
      minPersons: 1,
      maxPersons: 6,
      durationMin: 60,
    };
    f.line.partySize = 4;
    f.line.capacityMax = 6;
    f.reserve("09:00", "10:00", 6, 3);
    expect((await f.read()).days[0]!.slots.some((s) => s.startAt === `${DATE}T06:00:00.000Z`)).toBe(
      false,
    );
    f.line.partySize = 2;
    expect((await f.read()).days[0]!.slots.some((s) => s.startAt === `${DATE}T06:00:00.000Z`)).toBe(
      true,
    );
    f.reserve("09:00", "10:00", 6, 6);
    expect((await f.read()).days[0]!.slots.some((s) => s.startAt === `${DATE}T06:00:00.000Z`)).toBe(
      false,
    );
  });
  it("projects cumulative same-staff group joins across lines without mutating actual occupancy", async () => {
    const f = fixture(60);
    f.service.pricingMode = "PER_PERSON";
    f.service.perPersonPricing = {
      ratePerPersonCents: 1000,
      minPersons: 1,
      maxPersons: 5,
      durationMin: 60,
    };
    f.line.partySize = 2;
    f.line.capacityMax = 5;
    f.input.lines = [f.line, { ...f.line }];
    f.reserve("09:00", "10:00", 5, 2); // each party fits alone; both together do not.
    expect((await f.read()).days[0]!.slots.some((s) => s.startAt === `${DATE}T06:00:00.000Z`)).toBe(
      false,
    );
    const actual = await f.h.reservationRepository.findManyForStaffInDateRange();
    expect(actual[0].intervals[0].capacityUsed).toBe(2);
  });
  it("all secondary lines must pass their own final validator, end and staff constraints", async () => {
    const f = fixture(60);
    const other = buildStaff(f.business._id);
    const otherService = buildFixedService(f.business._id, [other._id]);
    f.input.lines = [
      f.line,
      {
        ...f.line,
        service: otherService,
        staffMembership: other,
        occupiedMilliseconds: 180 * 60_000,
      },
    ];
    wireStandardOpenSchedule(f.h, f.business, other);
    const schedules = await f.h.staffScheduleRepository.findManyByMembershipIds();
    f.h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(f.staff._id, f.business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
      ...schedules,
    ]);
    f.validateCandidate.mockImplementation(
      async (index: number, startAt: Date) => index === 0 || startAt.getUTCHours() === 6,
    );
    const slots = (await f.read()).days[0]!.slots;
    expect(slots).toHaveLength(1);
    expect(Date.parse(slots[0]!.endAt) - Date.parse(slots[0]!.startAt)).toBe(180 * 60_000);
  });
  it("full interval cannot cross split-shift break or a staff day off", async () => {
    const f = fixture();
    f.h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(f.staff._id, f.business._id, [
        {
          dayOfWeek: "TUESDAY",
          intervals: [
            { startTime: "09:00", endTime: "12:00" },
            { startTime: "13:00", endTime: "17:00" },
          ],
        },
      ]),
    ]);
    expect((await f.read()).days[0]!.slots).toEqual([]);
    wireStandardOpenSchedule(f.h, f.business, f.staff);
    f.h.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange.mockResolvedValue([
      { membershipId: f.staff._id, startDate: DATE, endDate: DATE },
    ]);
    expect((await f.read()).days[0]!.slots).toEqual([]);
  });
  it("MANUAL candidate rules and validation remain in the existing paths", async () => {
    const f = fixture(150);
    f.service.scheduleMode = "MANUAL";
    f.service.manualSchedule = [{ dayOfWeek: "TUESDAY", isOpen: true, times: ["10:30"] }];
    const slots = (await f.read()).days[0]!.slots;
    expect(slots.map((s) => s.startAt)).toEqual([`${DATE}T07:30:00.000Z`]);
    expect(slots[0]!.source).toBe("MANUAL");
    f.validateCandidate.mockResolvedValue(false);
    expect((await f.read()).days[0]!.slots).toEqual([]);
  });
  it("rejects invalid ranges and missing transaction context", async () => {
    const f = fixture();
    await expect(
      f.h.service.getBookingAvailability({ ...f.input, fromDate: "2030-08-21" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.h.service.getBookingAvailability({
        ...f.input,
        session: { inTransaction: () => false } as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

it.each(["2030-03-31", "2030-10-27"])(
  "F1C-A booked daytime DST %s keeps original milliseconds and unchanged final schedule checks",
  async (date) => {
    const h = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id]);
    h.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "SUNDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    );
    h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "SUNDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    ]);
    const result = await h.service.getBookingAvailability({
      business,
      lines: [
        {
          service,
          staffMembership: staff,
          occupiedMilliseconds: 255 * 60_000,
          partySize: 1,
          capacityMax: 1,
        },
      ],
      fromDate: date,
      toDate: date,
      session: { inTransaction: () => true } as never,
      validateCandidate: async (_, startAt, endAt) => {
        await h.service.assertSlotIsBookable({
          business,
          service,
          staffMembership: staff,
          startAt,
          endAt,
          partySize: 1,
        });
        return true;
      },
    });
    expect(result.days[0]!.slots.length).toBeGreaterThan(0);
    expect(result.days[0]!.slots[0]!.startAt).toBe(
      businessLocalToUtc(TIMEZONE, date, "09:00").toISOString(),
    );
    expect(
      result.days[0]!.slots.every(
        (slot) => Date.parse(slot.endAt) - Date.parse(slot.startAt) === 255 * 60_000,
      ),
    ).toBe(true);
  },
);

it.each(["2030-03-31", "2030-10-27"])(
  "F1C-A transition-night %s uses existing DST candidates and final UTC containment",
  async (date) => {
    const h = buildHarness();
    const business = buildBusiness();
    const staff = buildStaff(business._id);
    const service = buildFixedService(business._id, [staff._id], {
      pricingMode: "HOURLY",
      hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 4 },
    });
    h.businessHoursRepository.findByBusinessId.mockResolvedValue(
      buildOpeningHours(business._id, [
        { dayOfWeek: "SUNDAY", isOpen: true, slots: [{ startTime: "00:00", endTime: "06:00" }] },
      ]),
    );
    h.staffScheduleRepository.findManyByMembershipIds.mockResolvedValue([
      buildSchedule(staff._id, business._id, [
        { dayOfWeek: "SUNDAY", intervals: [{ startTime: "00:00", endTime: "10:00" }] },
      ]),
    ]);
    for (const minutes of [135, 255]) {
      const result = await h.service.getBookingAvailability({
        business,
        lines: [
          {
            service,
            staffMembership: staff,
            occupiedMilliseconds: minutes * 60_000,
            partySize: 1,
            capacityMax: 1,
          },
        ],
        fromDate: date,
        toDate: date,
        session: { inTransaction: () => true } as never,
        validateCandidate: async (_, startAt, endAt) => {
          try {
            await h.service.assertSlotIsBookable({
              business,
              service,
              staffMembership: staff,
              startAt,
              endAt,
              partySize: 1,
            });
            return true;
          } catch (error) {
            expect(error).toMatchObject({ statusCode: 409 });
            return false;
          }
        },
      });
      expect(result.days[0]!.slots.length).toBeGreaterThan(0);
      for (const slot of result.days[0]!.slots) {
        expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(minutes * 60_000);
        expect(Date.parse(slot.endAt)).toBeLessThanOrEqual(
          businessLocalToUtc(TIMEZONE, date, "06:00").getTime(),
        );
      }
    }
  },
);
