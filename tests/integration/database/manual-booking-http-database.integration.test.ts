import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/**
 * Batch 10 completion pass — the manual-booking-creation gap the investigation flagged: every
 * existing test for `createManualBooking` calls the service directly, so the HTTP-layer
 * authorization boundary (`requireRoles`, `requireBookingManagementAccess`,
 * `createManualBookingBodySchema`'s `.strict()` unknown-field rejection) had never actually been
 * exercised end-to-end through the real route. This file closes that gap only — it does not
 * re-test anything the service-layer suites already cover (pricing modes, availability,
 * idempotency, concurrency — see booking-lifecycle-database.integration.test.ts and
 * booking-payment-database.integration.test.ts).
 */
describe("HTTP-level manual booking creation (Batch 10)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
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
    businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async (name: string) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
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
    // Batch 11 — manual booking creation is now gated on Business approval status; every
    // fixture business in this file needs to be in good standing unless a test specifically
    // means to exercise the PENDING-block itself (see the dedicated test for that below).
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      },
    );
    return { owner, business: business ?? pending };
  };

  const createStaff = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: role === "SUPERVISOR" ? "SUPERVISOR" : "STAFF",
      status: "ACTIVE",
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Test",
      lastName: "Staff",
      gender: "other",
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
    priceCents = 8000,
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    });

  const createClientFor = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    tag: string,
  ) =>
    clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${tag}-${new Types.ObjectId().toString()}@example.com`,
      phone: {
        countryCode: "+357",
        nationalNumber: `9${tag}0000${Math.floor(Math.random() * 100)}`.slice(0, 8),
        e164: `+3579${tag}0000${Math.floor(Math.random() * 100)}`.slice(0, 12),
      },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });

  const startAtFor = (time: string) => businessLocalToUtc(TIMEZONE, DATE, time).toISOString();

  const setupBookableBusiness = async (priceCents = 8000) => {
    const { owner, business } = await createBusiness("Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, priceCents);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id, "a");
    return { owner, business, membership, service, client };
  };

  const validBody = (
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
    clientId: Types.ObjectId,
    time = "10:00",
    addonIds: string[] = [],
  ) => ({
    serviceLines: [
      {
        serviceId: String(serviceId),
        staffMembershipId: String(staffId),
        addonIds,
        pricingInput: {},
      },
    ],
    startAt: startAtFor(time),
    businessClientId: String(clientId),
    idempotencyKey: `key-${new Types.ObjectId().toString()}`,
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/businesses", createBusinessBookingRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- Tests -----------------------------------------------------------------------------------

  it("an Owner can create a real manual booking via the real HTTP route", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(201);
    expect(response.body.data.source).toBe("MANUAL");
    expect(response.body.data.status).toBe("UPCOMING");
    expect(response.body.data.financials.platformFeeCents).toBe(0);
    expect(response.body.data.financials.depositCents).toBe(0);

    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(1);
  });

  it("an active Supervisor scoped to the same Business can create a real manual booking", async () => {
    const { business, membership, service, client } = await setupBookableBusiness();
    const { user: supervisor } = await createStaff(business._id, "SUPERVISOR");
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(supervisor._id, "SUPERVISOR"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(201);
  });

  it("rejects a STAFF token outright (403) — Staff has no booking-management permission", async () => {
    const { business, membership, service, client } = await setupBookableBusiness();
    const { user: staffUser } = await createStaff(business._id, "STAFF");
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(403);
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("rejects a CUSTOMER token outright (403)", async () => {
    const { business, membership, service, client } = await setupBookableBusiness();
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(403);
  });

  it("rejects with no Authorization header at all", async () => {
    const { business, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(401);
  });

  it("an Owner of Business A cannot create a booking for Business B by editing the URL businessId (anti-enumeration 404, never a leaking 403)", async () => {
    const { owner: ownerA } = await createBusiness("Salon A");
    const { business: businessB, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${businessB._id}/bookings`)
      .set("Authorization", await bearerFor(ownerA._id, "BUSINESS_OWNER"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(404);
    const count = await BookingModel.countDocuments({ businessId: businessB._id }).exec();
    expect(count).toBe(0);
  });

  it("a Supervisor linked to Business A cannot create a booking for Business B", async () => {
    const { business: businessA } = await createBusiness("Salon A");
    const { user: supervisorA } = await createStaff(businessA._id, "SUPERVISOR");
    const { business: businessB, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${businessB._id}/bookings`)
      .set("Authorization", await bearerFor(supervisorA._id, "SUPERVISOR"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(404);
  });

  it("rejects a Staff/Service/Client id that belongs to a DIFFERENT business, even with a valid Owner token for the target business", async () => {
    const {
      business: businessA,
      membership: staffA,
      service: serviceA,
      client: clientA,
    } = await setupBookableBusiness();
    const { owner: ownerB, business: businessB } = await createBusiness("Salon B");
    const app = buildApp();

    // Staff from Business A used against Business B's own booking route.
    const withForeignStaff = await request(app)
      .post(`/businesses/${businessB._id}/bookings`)
      .set("Authorization", await bearerFor(ownerB._id, "BUSINESS_OWNER"))
      .send(validBody(serviceA._id, staffA._id, clientA._id));
    expect(withForeignStaff.status).toBeGreaterThanOrEqual(400);
    expect(withForeignStaff.status).toBeLessThan(500);

    const count = await BookingModel.countDocuments({ businessId: businessB._id }).exec();
    expect(count).toBe(0);
    void businessA;
  });

  it("rejects a request missing required fields (schema validation, never reaches the service layer)", async () => {
    const { owner, business } = await setupBookableBusiness();
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ serviceLines: [], startAt: startAtFor("10:00") }); // no businessClientId, no idempotencyKey

    expect(response.status).toBe(400);
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("rejects (never silently ignores) an attempt to smuggle client-supplied financial/relationship fields — the .strict() schema has no such fields to accept in the first place", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const tamperedBody = {
      ...validBody(service._id, membership._id, client._id),
      // None of these exist anywhere in CreateManualBookingInput — proving there is no field a
      // malicious client could ever populate to influence price, fee ownership, or relationship
      // classification, not merely that the UI happens not to expose one.
      depositCents: 5000,
      platformFeeCents: 5000,
      isFirstBooking: true,
      amountCents: 1,
      financials: { totalCents: 1 },
    };

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(tamperedBody);

    expect(response.status).toBe(400);
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("rejects an add-on id that belongs to a DIFFERENT business (cannot bypass Business scope)", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const { business: otherBusiness } = await createBusiness("Salon B");
    const foreignAddon = await addonRepository.create({
      businessId: otherBusiness._id,
      status: "ACTIVE",
      name: "Foreign Add-on",
      priceCents: 1000,
    });
    await addonServiceAssignmentRepository.insertMany([
      { businessId: otherBusiness._id, addonId: foreignAddon._id, serviceId: service._id },
    ]);
    const app = buildApp();

    const body = validBody(service._id, membership._id, client._id, "10:00", [
      String(foreignAddon._id),
    ]);

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(body);

    expect(response.status).toBe(404);
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  // --- Batch 11: Business approval-status enforcement -----------------------------------------

  it("[Batch 11] a PENDING business cannot have a manual booking created for it (403 BUSINESS_PENDING_APPROVAL)", async () => {
    const { owner, business: approved } = await createBusiness("Pending Salon");
    // createBusiness auto-approves (every other test in this file needs a working business) —
    // revert to genuinely PENDING for this one test, which specifically means to exercise that.
    const business =
      (await businessRepository.casUpdateStatus(approved._id, ["APPROVED"], "PENDING", {
        fromStatus: "APPROVED",
        actorUserId: owner._id,
        changedAt: new Date(),
      })) ?? approved;
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id, "pending");
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(403);
    expect(response.body.errors?.[0]?.code ?? response.body.message).toContain(
      "BUSINESS_PENDING_APPROVAL",
    );
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("[Batch 11] a SUSPENDED business cannot have a manual booking created for it (403 BUSINESS_SUSPENDED)", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    await businessRepository.casUpdateStatus(business._id, ["APPROVED"], "SUSPENDED", {
      fromStatus: "APPROVED",
      actorUserId: new Types.ObjectId(),
      changedAt: new Date(),
    });
    const app = buildApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validBody(service._id, membership._id, client._id));

    expect(response.status).toBe(403);
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("[Batch 11] existing-booking lifecycle actions remain available on a SUSPENDED business (complete stays reachable)", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const app = buildApp();

    const created = await request(app)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validBody(service._id, membership._id, client._id));
    expect(created.status).toBe(201);

    await businessRepository.casUpdateStatus(business._id, ["APPROVED"], "SUSPENDED", {
      fromStatus: "APPROVED",
      actorUserId: new Types.ObjectId(),
      changedAt: new Date(),
    });

    // The complete/cancel/no-show/reschedule routes are NOT gated by requireApprovedBusiness —
    // confirm one representative existing-booking action still reaches its own handler (a real
    // business-rule rejection here, e.g. "too early to complete", is a PASS for this test: it
    // proves the request was NOT blocked at 403 by the approval gate).
    const completeResponse = await request(app)
      .post(`/businesses/${business._id}/bookings/${created.body.data.id}/complete`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({});

    expect(completeResponse.status).not.toBe(403);
  });
});
