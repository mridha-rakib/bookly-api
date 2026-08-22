import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asyncHandler } from "../../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../../src/common/middleware/validate-request.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { AvailabilityController } from "../../../src/modules/availability/availability.controller.js";
import {
  availabilityParamsSchema,
  getAvailabilityQuerySchema,
} from "../../../src/modules/availability/availability.schema.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

describe("database-backed Availability integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let staffTimeOffRepository: StaffTimeOffRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let reservationRepository: BookingSlotReservationRepository;
  let reservationService: BookingSlotReservationService;
  let availabilityService: AvailabilityService;
  let bookingService: BookingService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    staffTimeOffRepository = new StaffTimeOffRepository();
    businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    reservationRepository = new BookingSlotReservationRepository();
    reservationService = new BookingSlotReservationService(reservationRepository);
    availabilityService = new AvailabilityService(
      businessRepository,
      serviceRepository,
      staffRepository,
      staffScheduleRepository,
      staffTimeOffRepository,
      businessHoursRepository,
      new BusinessBookingSettingsRepository(),
      new BusinessTravelSettingsRepository(),
      reservationRepository,
    );
    bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      new AddonRepository(),
      new AddonServiceAssignmentRepository(),
      new ClientRepository(),
      new BookingRepository(),
    );
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusiness = async (email: string, name: string) => {
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name,
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createStaff = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  const openMondayToFriday = async (businessId: Types.ObjectId, ownerId: Types.ObjectId) => {
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(ownerId), String(businessId), [
      ...days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
      { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);
  };

  const staffWorksMondayToFriday = async (
    membershipId: Types.ObjectId,
    businessId: Types.ObjectId,
  ) => {
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await staffScheduleRepository.replace(
      membershipId,
      businessId,
      days.map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "18:00" })),
    );
  };

  const createFixedService = async (
    businessId: Types.ObjectId,
    staffId: Types.ObjectId,
    overrides: Record<string, unknown> = {},
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
      ...overrides,
    });

  const buildApp = () => {
    const controller = new AvailabilityController(availabilityService, bookingService);
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    );
    app.get(
      "/businesses/:businessId/services/:serviceId/availability",
      validateRequest({ params: availabilityParamsSchema, query: getAvailabilityQuerySchema }),
      asyncHandler(controller.get),
    );
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // A Tuesday.
  const DATE = "2026-08-25";

  it("returns bookable slots for a fully-configured business/service/staff", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    const result = await availabilityService.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    });

    expect(result.days[0]!.isOpen).toBe(true);
    expect(result.days[0]!.slots.length).toBeGreaterThan(0);
    expect(result.days[0]!.slots[0]!.eligibleStaffMembershipIds).toEqual([String(membership._id)]);
  });

  it("excludes a slot after a real reservation is made through BookingSlotReservationService", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    const before = await availabilityService.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    });
    const firstSlot = before.days[0]!.slots[0]!;
    expect(firstSlot).toBeDefined();

    await reservationService.reserveOrJoin({
      businessId: business._id,
      staffMembershipId: membership._id,
      serviceId: service._id,
      timezone: TIMEZONE,
      startAt: new Date(firstSlot.startAt),
      endAt: new Date(firstSlot.endAt),
      capacityMax: 1,
      partySize: 1,
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    const after = await availabilityService.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    });

    expect(after.days[0]!.slots.map((s) => s.startAt)).not.toContain(firstSlot.startAt);
  });

  it("isolates availability by business — the same staff/service ids in a different business never leak in", async () => {
    const { owner: ownerA, business: businessA } = await createBusiness(
      "owner-a@example.com",
      "Salon A",
    );
    const { membership: staffA } = await createStaff(businessA._id);
    const serviceA = await createFixedService(businessA._id, staffA._id);
    await openMondayToFriday(businessA._id, ownerA._id);
    await staffWorksMondayToFriday(staffA._id, businessA._id);

    const { business: businessB } = await createBusiness("owner-b@example.com", "Salon B");

    await expect(
      availabilityService.getAvailability({
        businessId: String(businessB._id),
        serviceId: String(serviceA._id),
        fromDate: DATE,
        toDate: DATE,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("excludes an archived service and an unassigned/inactive staff member", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership: assignedStaff } = await createStaff(business._id);
    const { membership: unassignedStaff } = await createStaff(business._id);
    const service = await createFixedService(business._id, assignedStaff._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(assignedStaff._id, business._id);
    await staffWorksMondayToFriday(unassignedStaff._id, business._id);

    // Unassigned staff explicitly requested — must be rejected as not eligible.
    await expect(
      availabilityService.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        staffMembershipId: String(unassignedStaff._id),
        fromDate: DATE,
        toDate: DATE,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Archiving the service must make it unavailable.
    await serviceRepository.archiveById(business._id, service._id);
    await expect(
      availabilityService.getAvailability({
        businessId: String(business._id),
        serviceId: String(service._id),
        fromDate: DATE,
        toDate: DATE,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("excludes a staff member soft-removed after being assigned", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    await staffRepository.softRemoveById(business._id, membership._id);

    const result = await availabilityService.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    });

    expect(result.days[0]).toEqual({ date: DATE, isOpen: false, slots: [] });
  });

  // --- HTTP boundary ---------------------------------------------------------------------------

  it("a Business Owner and an active Supervisor can both read availability through the real HTTP route", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const { user: supervisorUser } = await createStaff(business._id, "SUPERVISOR");

    const app = buildApp();

    const ownerResponse = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body.data.days[0].isOpen).toBe(true);

    const supervisorResponse = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", await bearerFor(supervisorUser._id, "SUPERVISOR"));
    expect(supervisorResponse.status).toBe(200);
  });

  it("rejects an unrelated Business Owner (anti-enumeration: same shape as a nonexistent business)", async () => {
    const { business } = await createBusiness("owner-a@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    const { owner: ownerB } = await createBusiness("owner-b@example.com", "Salon B");

    const app = buildApp();
    const token = await bearerFor(ownerB._id, "BUSINESS_OWNER");

    const unrelated = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", token);
    expect(unrelated.status).toBe(404);

    const nonexistent = await request(app)
      .get(`/businesses/000000000000000000000000/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", token);
    expect(nonexistent.status).toBe(404);
    expect(nonexistent.body).toEqual(unrelated.body);
  });

  it("rejects an unauthenticated request and a STAFF-role request at the route's role gate", async () => {
    const { business } = await createBusiness("owner@example.com", "Salon A");
    const { membership: staffMembership, user: staffUser } = await createStaff(business._id);
    const service = await createFixedService(business._id, staffMembership._id);
    const app = buildApp();

    const noAuth = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE });
    expect(noAuth.status).toBe(401);

    const staffToken = await bearerFor(staffUser._id, "STAFF");
    const staffResponse = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", staffToken);
    expect(staffResponse.status).toBe(403);
  });

  it("rejects a malformed query at the Zod boundary", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const badDate = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: "25-08-2026", toDate: DATE })
      .set("Authorization", token);
    expect(badDate.status).toBe(400);

    const invertedRange = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: "2026-08-26", toDate: "2026-08-25" })
      .set("Authorization", token);
    expect(invertedRange.status).toBe(400);

    const tooWide = await request(app)
      .get(`/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: "2026-01-01", toDate: "2026-12-31" })
      .set("Authorization", token);
    expect(tooWide.status).toBe(400);
  });

  // --- Staff time off ---------------------------------------------------------------------------

  it("excludes a staff member on time off through the real repository (not a mock)", async () => {
    const { owner, business } = await createBusiness("owner@example.com", "Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    await staffTimeOffRepository.create({
      membershipId: membership._id,
      businessId: business._id,
      type: "ANNUAL_HOLIDAY",
      startDate: DATE,
      endDate: DATE,
      createdByUserId: owner._id,
    });

    const result = await availabilityService.getAvailability({
      businessId: String(business._id),
      serviceId: String(service._id),
      fromDate: DATE,
      toDate: DATE,
    });

    expect(result.days[0]!.slots).toEqual([]);
  });
});
