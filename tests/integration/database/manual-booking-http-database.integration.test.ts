import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { createAvailabilityRoute } from "../../../src/modules/availability/availability.route.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import {
  createBusinessBookingRoute,
  createCustomerBookingRoute,
} from "../../../src/modules/booking/booking.route.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { createClientRoute } from "../../../src/modules/client/client.route.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { CustomerPaymentProfileModel } from "../../../src/modules/payment/customer-payment-profile.model.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { StripePaymentGateway } from "../../../src/modules/payment/stripe-payment-gateway.js";
import { PlatformSettingsRepository } from "../../../src/modules/platform-settings/platform-settings.repository.js";
import { createPlatformConfigRoute } from "../../../src/modules/platform-settings/platform-settings.route.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { createStaffScheduleRoute } from "../../../src/modules/staff/staff.route.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  buildManualBookingBrowser,
  manualBookingBrowserHtml,
} from "../../helpers/manual-booking-browser.js";
import { hasLocalBrowser, startTestBrowser } from "./browser-cdp-helper.js";
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
    await businessRepository.casUpdateStatus(pending._id, ["PENDING"], "APPROVED", {
      fromStatus: "PENDING",
      actorUserId: pending.ownerUserId,
      changedAt: new Date(),
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
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
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
    app.use("/businesses", createClientRoute());
    app.use("/businesses", createStaffScheduleRoute());
    app.use("/businesses", createAvailabilityRoute());
    app.use("/businesses", createBusinessBookingRoute());
    app.use("/me", createCustomerBookingRoute());
    // Same public mount as api-router: the real booking form reads the server-authoritative
    // max-services limit here before a service can be selected.
    app.use("/platform", createPlatformConfigRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await issueTestAccessToken(tokenService, { userId, role })}`;

  // --- Tests -----------------------------------------------------------------------------------

  it("7C scopes legacy package reads to active supervisors and hides settlement", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const foreign = await createBusiness("Foreign 7C");
    const outsider = await createStaff(foreign.business._id, "SUPERVISOR");
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const created = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const bookingId = new Types.ObjectId(created.body.data.id);
    const customerId = new Types.ObjectId();
    const packageId = new Types.ObjectId();
    await BookingModel.updateOne(
      { _id: bookingId },
      {
        $set: {
          "customer.customerUserId": customerId,
          "serviceLines.0.pricingInput.packageProgressId": packageId,
          "serviceLines.0.pricingInput.sessionIndex": 1,
          "serviceLines.0.pricingInput.sessionsInPackage": 2,
        },
      },
    );
    await PackageProgressModel.create({
      _id: packageId,
      businessId: t.business._id,
      customerUserId: customerId,
      businessClientId: t.client._id,
      serviceId: t.service._id,
      totalSessions: 2,
      remainingSessions: 1,
      completedSessions: 0,
      originBookingId: bookingId,
      sessions: [{ sessionIndex: 1, bookingId, status: "SCHEDULED" }],
      purchaseSnapshot: {
        name: "Synthetic package",
        bundlePriceCents: 8000,
        durationMin: 60,
        sessionsInPackage: 2,
      },
      voidRefundSettlement: {
        status: "SUCCEEDED",
        amountCents: 1000,
        providerRefundId: "synthetic",
      },
    });
    const path = `${base}/packages/${packageId}`;
    const response = await request(app).get(path).set("Authorization", auth).expect(200);
    expect(response.body.data).toMatchObject({
      id: String(packageId),
      businessId: String(t.business._id),
      originBookingId: String(bookingId),
      sessions: [
        {
          bookingId: String(bookingId),
          booking: { professional: { membershipId: String(t.membership._id) } },
        },
      ],
    });
    expect(response.body.data.status).toBeDefined();
    expect(response.body.data).not.toHaveProperty("outstandingBalanceCents");
    expect(response.body.data).not.toHaveProperty("voidRefundSettlement");
    expect(response.body.data.purchaseSnapshot).not.toHaveProperty("bundlePriceCents");
    const detail = await request(app)
      .get(`${base}/${bookingId}`)
      .set("Authorization", auth)
      .expect(200);
    expect(detail.body.data.packageSessions).toHaveLength(1);
    expect(detail.body.data.packageSessions[0]).not.toHaveProperty("outstandingBalanceCents");
    const otherCustomer = await userRepository.create({
      normalizedEmail: `other-${new Types.ObjectId()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await request(app)
      .get(`/me/packages/${packageId}`)
      .set("Authorization", await bearerFor(otherCustomer._id, "CUSTOMER"))
      .expect(404);
    await request(app).get(`/me/packages/${packageId}`).set("Authorization", auth).expect(403);
    await request(app)
      .get(path)
      .set("Authorization", await bearerFor(outsider.user._id, "SUPERVISOR"))
      .expect(404);
    await request(app)
      .get(`/businesses/${foreign.business._id}/bookings/packages/${packageId}`)
      .set("Authorization", auth)
      .expect(404);
    await request(app).post(`${path}/terminate`).set("Authorization", auth).send({}).expect(403);
    await request(app).post(`${path}/sessions`).set("Authorization", auth).send({}).expect(403);
    await StaffMembershipModel.updateOne(
      { _id: supervisor.membership._id },
      { $set: { employmentActive: false } },
    );
    await request(app).get(path).set("Authorization", auth).expect(404);
    expect(
      (await PackageProgressModel.findById(packageId).orFail()).sessions[0]?.bookingId.toString(),
    ).toBe(String(bookingId));
  });

  it("creates two parallel services after composite availability and rejects a conflicting assignment", async () => {
    const t = await setupBookableBusiness();
    const second = await createStaff(t.business._id);
    await staffWorksMondayToFriday(second.membership._id, t.business._id);
    const secondService = await createFixedService(t.business._id, second.membership._id, 5000);
    const app = buildApp();
    const bearer = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const lines = [
      { serviceId: String(t.service._id), staffMembershipId: String(t.membership._id) },
      { serviceId: String(secondService._id), staffMembershipId: String(second.membership._id) },
    ];
    const query = { fromDate: DATE, toDate: DATE, lines };
    const available = await request(app)
      .post(`/businesses/${t.business._id}/bookings/composite-availability`)
      .set("Authorization", bearer)
      .send(query)
      .expect(200);
    expect(
      available.body.data.days[0].slots.some(
        (slot: { startAt: string }) => slot.startAt === startAtFor("10:00"),
      ),
    ).toBe(true);
    await request(app)
      .post(`/businesses/${t.business._id}/bookings/composite-availability`)
      .set("Authorization", bearer)
      .send({
        ...query,
        lines: [lines[0], { ...lines[1], staffMembershipId: String(t.membership._id) }],
      })
      .expect(409);
    const body = {
      ...validBody(t.service._id, t.membership._id, t.client._id),
      serviceLines: lines.map((line) => ({ ...line, addonIds: [], pricingInput: {} })),
    };
    const created = await request(app)
      .post(`/businesses/${t.business._id}/bookings`)
      .set("Authorization", bearer)
      .send(body)
      .expect(201);
    const booking = await BookingModel.findById(created.body.data.id).orFail();
    expect(booking.serviceLines).toHaveLength(2);
    expect(booking.serviceLines.map((line) => String(line.responsibleStaffMembershipId))).toEqual(
      lines.map((line) => line.staffMembershipId),
    );
    expect(booking.schedule.startAt.toISOString()).toBe(startAtFor("10:00"));
    expect(booking.financials.servicesSubtotalCents).toBe(13000);
    expect(booking.serviceLines.map((line) => line.amountCents)).toEqual([8000, 5000]);
    expect(booking.serviceLines.map((line) => String(line.serviceId))).toEqual(
      lines.map((line) => line.serviceId),
    );
    expect(
      booking.serviceLines.every(
        (line) => Boolean(line.serviceSnapshot.name) && Boolean(line.staffSnapshot?.firstName),
      ),
    ).toBe(true);
    const reserved = await BookingSlotReservationModel.find({ businessId: t.business._id }).lean();
    expect(reserved).toHaveLength(2);
    for (const line of booking.serviceLines) {
      const day = reserved.find(
        (item) => String(item.staffMembershipId) === String(line.responsibleStaffMembershipId),
      );
      expect(
        day?.intervals.some(
          (interval) =>
            String(interval.reservationId) === String(line.reservationId) &&
            interval.startAt.toISOString() === startAtFor("10:00"),
        ),
      ).toBe(true);
    }
    const replay = await request(app)
      .post(`/businesses/${t.business._id}/bookings`)
      .set("Authorization", bearer)
      .send(body)
      .expect(201);
    expect(replay.body.data.id).toBe(created.body.data.id);
    expect(await BookingModel.countDocuments()).toBe(1);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(2);
    const conflicting = { ...body, idempotencyKey: `conflict-${new Types.ObjectId()}` };
    const rejected = await request(app)
      .post(`/businesses/${t.business._id}/bookings`)
      .set("Authorization", bearer)
      .send(conflicting);
    expect(rejected.status).toBe(409);
    expect(await BookingModel.countDocuments()).toBe(1);
    const afterConflict = await BookingSlotReservationModel.find({
      businessId: t.business._id,
    }).lean();
    expect(afterConflict.map((doc) => doc.intervals.length)).toEqual([1, 1]);
    const after = await request(app)
      .post(`/businesses/${t.business._id}/bookings/composite-availability`)
      .set("Authorization", bearer)
      .send(query)
      .expect(200);
    expect(
      after.body.data.days[0].slots.some(
        (slot: { startAt: string }) => slot.startAt === startAtFor("10:00"),
      ),
    ).toBe(false);
  });

  it("rolls back both parallel reservations if the second reservation fails", async () => {
    const t = await setupBookableBusiness();
    const second = await createStaff(t.business._id);
    await staffWorksMondayToFriday(second.membership._id, t.business._id);
    const other = await createFixedService(t.business._id, second.membership._id);
    const app = buildApp();
    const bearer = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const body = {
      ...validBody(t.service._id, t.membership._id, t.client._id),
      serviceLines: [
        {
          serviceId: String(t.service._id),
          staffMembershipId: String(t.membership._id),
          addonIds: [],
          pricingInput: {},
        },
        {
          serviceId: String(other._id),
          staffMembershipId: String(second.membership._id),
          addonIds: [],
          pricingInput: {},
        },
      ],
    };
    const original = BookingSlotReservationService.prototype.reserveOrJoin;
    let calls = 0;
    const spy = vi
      .spyOn(BookingSlotReservationService.prototype, "reserveOrJoin")
      .mockImplementation(async function (this: BookingSlotReservationService, ...args) {
        calls += 1;
        if (calls === 2) throw new Error("synthetic second reservation failure");
        return original.apply(this, args);
      });
    try {
      const result = await request(app)
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", bearer)
        .send(body);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(2);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects invalid parallel selections before creating booking or reservation state", async () => {
    const t = await setupBookableBusiness();
    const second = await createStaff(t.business._id);
    await staffWorksMondayToFriday(second.membership._id, t.business._id);
    const secondService = await createFixedService(t.business._id, second.membership._id, 5000);
    const app = buildApp();
    const bearer = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const lines = [
      { serviceId: String(t.service._id), staffMembershipId: String(t.membership._id) },
      { serviceId: String(secondService._id), staffMembershipId: String(second.membership._id) },
    ];
    const body = {
      ...validBody(t.service._id, t.membership._id, t.client._id),
      serviceLines: lines.map((line) => ({ ...line, addonIds: [], pricingInput: {} })),
    };
    const query = { fromDate: DATE, toDate: DATE, lines };
    const path = `/businesses/${t.business._id}/bookings`;
    const invalid = await request(app)
      .post(path)
      .set("Authorization", bearer)
      .send({
        ...body,
        serviceLines: [
          body.serviceLines[0],
          { ...body.serviceLines[1], staffMembershipId: String(t.membership._id) },
        ],
      });
    expect(invalid.status).toBe(409);
    await StaffMembershipModel.updateOne(
      { _id: second.membership._id },
      { $set: { employmentActive: false } },
    );
    const unavailable = await request(app)
      .post(`${path}/composite-availability`)
      .set("Authorization", bearer)
      .send(query);
    expect(unavailable.status).toBeGreaterThanOrEqual(400);
    expect(unavailable.status).toBeLessThan(500);
    const unavailableBooking = await request(app)
      .post(path)
      .set("Authorization", bearer)
      .send(body);
    expect(unavailableBooking.status).toBeGreaterThanOrEqual(400);
    expect(unavailableBooking.status).toBeLessThan(500);
    await StaffMembershipModel.updateOne(
      { _id: second.membership._id },
      { $set: { employmentActive: true } },
    );
    await ServiceModel.updateOne({ _id: secondService._id }, { $set: { status: "INACTIVE" } });
    const inactiveAvailability = await request(app)
      .post(`${path}/composite-availability`)
      .set("Authorization", bearer)
      .send(query);
    expect(inactiveAvailability.status).toBeGreaterThanOrEqual(400);
    expect(inactiveAvailability.status).toBeLessThan(500);
    const inactiveBooking = await request(app).post(path).set("Authorization", bearer).send(body);
    expect(inactiveBooking.status).toBeGreaterThanOrEqual(400);
    expect(inactiveBooking.status).toBeLessThan(500);
    await ServiceModel.updateOne({ _id: secondService._id }, { $set: { status: "ACTIVE" } });
    await new PlatformSettingsRepository().update({ maxServicesPerBooking: 1 });
    await request(app)
      .post(`${path}/composite-availability`)
      .set("Authorization", bearer)
      .send(query)
      .expect(400);
    await request(app).post(path).set("Authorization", bearer).send(body).expect(400);
    await new PlatformSettingsRepository().update({ maxServicesPerBooking: 5 });
    await ServiceModel.updateOne({ _id: secondService._id }, { $set: { isPackageDeal: true } });
    await request(app)
      .post(`${path}/composite-availability`)
      .set("Authorization", bearer)
      .send(query)
      .expect(400);
    const packageResult = await request(app).post(path).set("Authorization", bearer).send(body);
    expect(packageResult.status).toBeGreaterThanOrEqual(400);
    expect(packageResult.status).toBeLessThan(500);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
  });

  it.skipIf(!hasLocalBrowser).each(["FIXED", "HOURLY", "PER_PERSON", "NEW_CLIENT", "TRAVEL"])(
    "BC-F02 browser %s uses real form, API persistence and list/calendar reads",
    async (mode) => {
      const t = await setupBookableBusiness();
      if (mode === "FIXED") {
        await BusinessClientModel.updateOne({ _id: t.client._id }, { $unset: { address: 1 } });
      }
      if (mode === "TRAVEL") {
        await BusinessModel.updateOne(
          { _id: t.business._id },
          { $set: { visitType: "TRAVEL_TO_CUSTOMER" } },
        );
        await ServiceModel.updateOne(
          { _id: t.service._id },
          { $set: { servedCities: ["Larnaca"] } },
        );
        await new BusinessTravelSettingsRepository().upsertByBusinessId(t.business._id, [
          { city: "Larnaca", active: true, feeCents: 1500 },
        ]);
      }
      if (mode === "HOURLY" || mode === "PER_PERSON") {
        await ServiceModel.updateOne(
          { _id: t.service._id },
          {
            $set: {
              pricingMode: mode,
              ...(mode === "HOURLY"
                ? {
                    hourlyPricing: {
                      ratePerHourCents: 1000,
                      minHours: 2,
                      maxHours: 4,
                      bufferAfterMin: 0,
                    },
                  }
                : {
                    perPersonPricing: {
                      ratePerPersonCents: 1000,
                      minPersons: 2,
                      maxPersons: 4,
                      durationMin: 60,
                    },
                  }),
            },
            $unset: { fixedPricing: 1 },
          },
        );
      }
      const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
      const bundle = await buildManualBookingBrowser();
      const host = express();
      host.get("/manual-fixture.js", (_req, res) => res.type("js").send(bundle));
      host.get("/browser-fixture", (_req, res) =>
        res
          .type("html")
          .send(manualBookingBrowserHtml(String(t.business._id), auth.slice(7), mode === "TRAVEL")),
      );
      host.use("/api", buildApp());
      const server = host.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing test loopback listener");
      const browser = await startTestBrowser();
      try {
        const page = await browser.page(`http://127.0.0.1:${address.port}/browser-fixture`);
        const wait = async (expression: string) => {
          for (let count = 0; count < 160; count++) {
            if (await page.evaluate(`Boolean(${expression})`)) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw Error(
            `Browser did not settle: ${expression}; ${await page.evaluate("document.body.innerText.slice(0,3000)")}`,
          );
        };
        const click = async (text: string) => {
          const match = `Array.from(document.querySelectorAll('#form button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
          await wait(`${match} && !${match}.disabled`);
          await page.evaluate(`${match}.click()`);
        };
        const fill = (placeholder: string, value: string) =>
          page.evaluate(
            `(()=>{const el=document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
          );
        await wait("document.querySelector('input[placeholder^=\"Type a client\"]')");
        if (mode === "NEW_CLIENT") {
          await click("+ Add new client");
          for (const [placeholder, value] of [
            ["John", "Browser"],
            ["Doe", "Client"],
            ["example@email.com", "browser@example.com"],
            ["99111111", "99123456"],
            ["e.g. Mackenzie, finikoudes", "Centre"],
            ["e.g. Emrou", "Main"],
            ["e.g. 14", "1"],
          ] as const)
            await fill(placeholder, value);
          for (const value of ["Larnaca", "House"])
            await page.evaluate(
              `(()=>{const el=Array.from(document.querySelectorAll('#form select')).find(s=>Array.from(s.options).some(o=>o.value===${JSON.stringify(value)}));el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
            );
        } else {
          await fill("Type a client name or mobile number or email...", "Walk");
          await wait(
            "document.querySelector('#form button') && Array.from(document.querySelectorAll('#form button')).some(b=>b.textContent.includes('@example.com'))",
          );
          await page.evaluate(
            "Array.from(document.querySelectorAll('#form button')).find(b=>b.textContent.includes('@example.com')).click()",
          );
        }
        await wait(`document.querySelector('option[value="${t.service._id}"]')`);
        await page.evaluate(
          `(()=>{const el=Array.from(document.querySelectorAll('#form select')).find(s=>Array.from(s.options).some(o=>o.value==='${t.service._id}'));el.value='${t.service._id}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await wait(
          "Array.from(document.querySelectorAll('#form button')).some(b=>b.textContent.includes('Test Staff'))",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('#form button')).find(b=>b.textContent.includes('Test Staff')).click()",
        );
        await wait(
          "Array.from(document.querySelectorAll('#form button')).some(b=>b.querySelector('span')?.textContent==='20' && !b.disabled)",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('#form button')).find(b=>b.querySelector('span')?.textContent==='20' && !b.disabled).click()",
        );
        await wait(
          "Array.from(document.querySelectorAll('#form button[aria-pressed]')).some(b=>/AM|PM/.test(b.textContent))",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('#form button[aria-pressed]')).find(b=>/AM|PM/.test(b.textContent)).click()",
        );
        await click("Create booking");
        await wait("document.querySelector('#created').textContent.length===24");
        const id = String(await page.evaluate("document.querySelector('#created').textContent"));
        const booking = await BookingModel.findById(id).orFail();
        expect(booking.source).toBe("MANUAL");
        expect(booking.financials.depositCents).toBe(0);
        if (mode === "TRAVEL") {
          expect(booking.fulfilment.mode).toBe("TRAVEL_TO_CUSTOMER");
          expect(booking.fulfilment.travelAddress?.city).toBe("Larnaca");
          expect(booking.financials.travelFeeCents).toBe(1500);
          expect(booking.financials.totalCents).toBe(9500);
        }
        await wait(
          `document.querySelector('#list').innerText.includes(${JSON.stringify(booking.reference)})`,
        );
        await wait("document.querySelector('#calendar').innerText.includes('Haircut')");
        await page.evaluate("location.reload(); true");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await wait(
          `document.querySelector('#list')?.innerText.includes(${JSON.stringify(booking.reference)})`,
        );
        await wait("document.querySelector('#calendar')?.innerText.includes('Haircut')");
        expect(await BookingModel.countDocuments()).toBe(1);
        const denied = await page.evaluate(
          `fetch('/api/businesses/${t.business._id}/bookings',{method:'POST',headers:{'Content-Type':'application/json','Authorization':${JSON.stringify(await bearerFor(t.membership.userId, "STAFF"))}},body:JSON.stringify(${JSON.stringify(validBody(t.service._id, t.membership._id, t.client._id))})}).then(r=>r.status)`,
        );
        expect(denied).toBe(403);
      } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    45_000,
  );

  it.each([
    { mode: "HOURLY", pricingInput: { hours: 3 }, minutes: 180, capacity: 1 },
    { mode: "PER_PERSON", pricingInput: { personCount: 3 }, minutes: 60, capacity: 3 },
  ])(
    "BC-F02 $mode persists authoritative quantity, price and reservation",
    async ({ mode, pricingInput, minutes, capacity }) => {
      const t = await setupBookableBusiness();
      await ServiceModel.updateOne(
        { _id: t.service._id },
        {
          $set: {
            pricingMode: mode,
            ...(mode === "HOURLY"
              ? {
                  hourlyPricing: {
                    ratePerHourCents: 1000,
                    minHours: 2,
                    maxHours: 4,
                    bufferAfterMin: 0,
                  },
                }
              : {
                  perPersonPricing: {
                    ratePerPersonCents: 1000,
                    minPersons: 1,
                    maxPersons: 4,
                    durationMin: 60,
                  },
                }),
          },
          $unset: { fixedPricing: 1 },
        },
        { runValidators: true },
      );
      const input = validBody(t.service._id, t.membership._id, t.client._id);
      const body = {
        ...input,
        serviceLines: input.serviceLines.map((line) => ({ ...line, pricingInput })),
      };
      const app = buildApp();
      const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
      const response = await request(app)
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", auth)
        .send(body)
        .expect(201);
      const retry = await request(app)
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", auth)
        .send(body)
        .expect(201);
      expect(retry.body.data.id).toBe(response.body.data.id);
      const booking = await BookingModel.findById(response.body.data.id).orFail();
      expect(booking.serviceLines[0]?.pricingInput).toMatchObject(pricingInput);
      expect(booking.financials).toMatchObject({
        totalCents: 3000,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: 3000,
      });
      expect(booking.financialContract).toBeUndefined();
      expect(booking.schedule.endAt.getTime() - booking.schedule.startAt.getTime()).toBe(
        minutes * 60_000,
      );
      const day = await BookingSlotReservationModel.findOne({
        businessId: t.business._id,
      }).orFail();
      expect(day.intervals).toHaveLength(1);
      expect(day.intervals[0]?.capacityUsed).toBe(capacity);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      const client = await BusinessClientModel.findById(t.client._id).orFail();
      expect(client.activatedAt).toBeUndefined();
    },
  );

  it("BC-F02 new client HTTP creation feeds the exact booking and preserves the client on booking failure", async () => {
    const t = await setupBookableBusiness();
    const app = buildApp();
    const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const base = `/businesses/${t.business._id}`;
    const clientInput = {
      firstName: "New",
      lastName: "Client",
      email: "new-manual@example.com",
      phone: { countryCode: "+357", nationalNumber: "99123456" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Centre",
        streetName: "Main",
        streetNumber: "1",
      },
    };
    await request(app)
      .post(`${base}/clients`)
      .set("Authorization", auth)
      .send({ ...clientInput, email: "invalid" })
      .expect(400);
    expect(await BookingModel.countDocuments()).toBe(0);
    const created = await request(app)
      .post(`${base}/clients`)
      .set("Authorization", auth)
      .send(clientInput)
      .expect(201);
    await request(app)
      .post(`${base}/clients`)
      .set("Authorization", auth)
      .send(clientInput)
      .expect(409);
    const input = validBody(
      t.service._id,
      t.membership._id,
      new Types.ObjectId(created.body.data.id),
    );
    const fail = vi
      .spyOn(BookingRepository.prototype, "create")
      .mockRejectedValueOnce(Error("injected persistence failure"));
    try {
      await request(app)
        .post(`${base}/bookings`)
        .set("Authorization", auth)
        .send(input)
        .expect(500);
    } finally {
      fail.mockRestore();
    }
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    expect(
      await EmailOutboxModel.countDocuments({ templateKey: "BOOKING_FOR_CLIENT_CONFIRMED" }),
    ).toBe(0);
    expect(await BusinessClientModel.findById(created.body.data.id)).not.toBeNull();
    const booked = await request(app)
      .post(`${base}/bookings`)
      .set("Authorization", auth)
      .send(input)
      .expect(201);
    expect(booked.body.data.customer.businessClientId).toBe(created.body.data.id);
    expect(await BookingModel.countDocuments()).toBe(1);
    expect(
      await EmailOutboxModel.countDocuments({ templateKey: "BOOKING_FOR_CLIENT_CONFIRMED" }),
    ).toBe(1);
  });

  it.each(["inactive", "removed"])(
    "BC-F02 %s Supervisor cannot create a booking",
    async (state) => {
      const t = await setupBookableBusiness();
      const supervisor = await createStaff(t.business._id, "SUPERVISOR");
      await StaffMembershipModel.updateOne(
        { _id: supervisor.membership._id },
        {
          $set: {
            employmentActive: false,
            ...(state === "removed" ? { removedAt: new Date() } : {}),
          },
        },
      );
      await request(buildApp())
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", await bearerFor(supervisor.user._id, "SUPERVISOR"))
        .send(validBody(t.service._id, t.membership._id, t.client._id))
        .expect(404);
      expect(await BookingModel.countDocuments()).toBe(0);
    },
  );

  it("BC-F02 a suspended Supervisor account cannot submit with its old session", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    await UserModel.updateOne({ _id: supervisor.user._id }, { $set: { status: "SUSPENDED" } });
    await request(buildApp())
      .post(`/businesses/${t.business._id}/bookings`)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(403);
    expect(await BookingModel.countDocuments()).toBe(0);
  });

  it("BC-F02 committed booking is visible in list, detail, calendar and assigned Staff read", async () => {
    const t = await setupBookableBusiness();
    const app = buildApp();
    const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const base = `/businesses/${t.business._id}`;
    const created = await request(app)
      .post(`${base}/bookings`)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const id = created.body.data.id;
    const detail = await request(app)
      .get(`${base}/bookings/${id}`)
      .set("Authorization", auth)
      .expect(200);
    expect(detail.body.data).toEqual(created.body.data);
    const list = await request(app).get(`${base}/bookings`).set("Authorization", auth).expect(200);
    expect(list.body.data.bookings.map((booking: { id: string }) => booking.id)).toContain(id);
    const calendar = await request(app)
      .get(`${base}/bookings/calendar`)
      .query({ fromDate: startAtFor("09:00"), toDate: startAtFor("18:00") })
      .set("Authorization", auth)
      .expect(200);
    expect(calendar.body.data.bookings.map((booking: { id: string }) => booking.id)).toContain(id);
    const staffAuth = await bearerFor(t.membership.userId, "STAFF");
    const staff = await request(app)
      .get(`${base}/staff/me/appointments/${id}`)
      .set("Authorization", staffAuth)
      .expect(200);
    expect(staff.body.data.id).toBe(id);
    expect(staff.body.data).not.toHaveProperty("financials");
    const foreign = await createBusiness("Foreign");
    const foreignAuth = await bearerFor(foreign.owner._id, "BUSINESS_OWNER");
    await request(app).get(`${base}/bookings/${id}`).set("Authorization", foreignAuth).expect(404);
  });

  it("BC-F02 concurrent group HTTP creation admits only capacity-fitting requests", async () => {
    const t = await setupBookableBusiness();
    await ServiceModel.updateOne(
      { _id: t.service._id },
      {
        $set: {
          pricingMode: "PER_PERSON",
          perPersonPricing: {
            ratePerPersonCents: 1000,
            minPersons: 1,
            maxPersons: 4,
            durationMin: 60,
          },
        },
        $unset: { fixedPricing: 1 },
      },
    );
    const app = buildApp();
    const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const responses = await Promise.all(
      [1, 2].map(() => {
        const input = validBody(t.service._id, t.membership._id, t.client._id);
        return request(app)
          .post(`/businesses/${t.business._id}/bookings`)
          .set("Authorization", auth)
          .send({
            ...input,
            serviceLines: input.serviceLines.map((line) => ({
              ...line,
              pricingInput: { personCount: 3 },
            })),
          });
      }),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(1);
    const day = await BookingSlotReservationModel.findOne({ businessId: t.business._id }).orFail();
    expect(day.intervals[0]?.capacityUsed).toBe(3);
  });

  it.each(["retired-service", "removed-staff", "invalid-hours"])(
    "BC-F02 rejects %s without reservation state",
    async (kind) => {
      const t = await setupBookableBusiness();
      const body = validBody(t.service._id, t.membership._id, t.client._id);
      if (kind === "retired-service")
        await ServiceModel.updateOne({ _id: t.service._id }, { $set: { status: "ARCHIVED" } });
      if (kind === "removed-staff")
        await StaffMembershipModel.updateOne(
          { _id: t.membership._id },
          { $set: { employmentActive: false, removedAt: new Date() } },
        );
      if (kind === "invalid-hours") {
        await ServiceModel.updateOne(
          { _id: t.service._id },
          {
            $set: {
              pricingMode: "HOURLY",
              hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 4 },
            },
            $unset: { fixedPricing: 1 },
          },
        );
      }
      const response = await request(buildApp())
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", await bearerFor(t.owner._id, "BUSINESS_OWNER"))
        .send(
          kind === "invalid-hours"
            ? {
                ...body,
                serviceLines: body.serviceLines.map((line) => ({
                  ...line,
                  pricingInput: { hours: 5 },
                })),
              }
            : body,
        );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
    },
  );

  it("BC-F02 manual and zero-upfront returning Customer contend for the same group capacity", async () => {
    const t = await setupBookableBusiness();
    await ServiceModel.updateOne(
      { _id: t.service._id },
      {
        $set: {
          pricingMode: "PER_PERSON",
          perPersonPricing: {
            ratePerPersonCents: 1000,
            minPersons: 1,
            maxPersons: 4,
            durationMin: 60,
          },
        },
        $unset: { fixedPricing: 1 },
      },
    );
    const customer = await userRepository.create({
      normalizedEmail: "returning-racer@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await BusinessClientModel.updateOne(
      { _id: t.client._id },
      {
        $set: {
          linkState: "LINKED",
          linkedUserId: customer._id,
          activatedAt: new Date(),
          activatedByBookingId: new Types.ObjectId(),
        },
      },
    );
    await CustomerPaymentProfileModel.create({
      userId: customer._id,
      stripeCustomerId: "cus_local_fake",
      defaultPaymentMethodId: "pm_local_fake",
    });
    const app = buildApp();
    const original = validBody(t.service._id, t.membership._id, t.client._id);
    const { businessClientId: _clientId, ...normal } = original;
    const lines = original.serviceLines.map((line) => ({
      ...line,
      pricingInput: { personCount: 3 },
    }));
    const dispatch = vi
      .spyOn(StripePaymentGateway.prototype, "createAndConfirmPaymentIntent")
      .mockRejectedValue(Error("Forbidden real provider dispatch"));
    try {
      const customerBody = {
        ...normal,
        idempotencyKey: `customer-${new Types.ObjectId()}`,
        serviceLines: lines,
      };
      const customerAuth = await bearerFor(customer._id, "CUSTOMER");
      const preview = await request(app)
        .post(`/businesses/${t.business._id}/bookings/preview`)
        .set("Authorization", customerAuth)
        .send(customerBody);
      expect(preview.status).toBe(200);
      const responses = await Promise.all([
        request(app)
          .post(`/businesses/${t.business._id}/bookings`)
          .set("Authorization", await bearerFor(t.owner._id, "BUSINESS_OWNER"))
          .send({ ...original, serviceLines: lines }),
        request(app)
          .post(`/businesses/${t.business._id}/bookings/finalize`)
          .set("Authorization", customerAuth)
          .send({ ...customerBody, acceptedQuoteDigest: preview.body.data.quoteDigest }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await BookingModel.countDocuments()).toBe(1);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      const day = await BookingSlotReservationModel.findOne({
        businessId: t.business._id,
      }).orFail();
      expect(day.intervals[0]?.capacityUsed).toBe(3);
    } finally {
      dispatch.mockRestore();
    }
  });

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

  it("rejects cross-business lifecycle mutations without changing the booking or reservation", async () => {
    const t = await setupBookableBusiness();
    const foreign = await createBusiness("Foreign Salon");
    const app = buildApp();
    const created = await request(app)
      .post(`/businesses/${t.business._id}/bookings`)
      .set("Authorization", await bearerFor(t.owner._id, "BUSINESS_OWNER"))
      .send(validBody(t.service._id, t.membership._id, t.client._id));
    expect(created.status).toBe(201);
    const bookingId = created.body.data.id as string;
    const auth = await bearerFor(foreign.owner._id, "BUSINESS_OWNER");
    for (const [action, body] of [
      ["cancel", { reason: "Test" }],
      ["complete", {}],
      ["no-show", {}],
      ["reschedule", { startAt: startAtFor("11:00") }],
    ] as const) {
      const response = await request(app)
        .post(`/businesses/${t.business._id}/bookings/${bookingId}/${action}`)
        .set("Authorization", auth)
        .send(body);
      expect(response.status).toBe(404);
    }
    const booking = await BookingModel.findById(bookingId).orFail();
    expect(booking.status).toBe("UPCOMING");
    const reservation = await BookingSlotReservationModel.findOne({
      businessId: t.business._id,
    }).orFail();
    expect(reservation.intervals).toHaveLength(1);
  });

  it.each(["DRAFT", "INACTIVE", "ARCHIVED"] as const)(
    "rejects a %s add-on before booking or reserving a slot",
    async (status) => {
      const t = await setupBookableBusiness();
      const addon = await addonRepository.create({
        businessId: t.business._id,
        status,
        name: "Unavailable extra",
        priceCents: 1000,
      });
      await addonServiceAssignmentRepository.insertMany([
        { businessId: t.business._id, addonId: addon._id, serviceId: t.service._id },
      ]);
      const response = await request(buildApp())
        .post(`/businesses/${t.business._id}/bookings`)
        .set("Authorization", await bearerFor(t.owner._id, "BUSINESS_OWNER"))
        .send(
          validBody(t.service._id, t.membership._id, t.client._id, "10:00", [String(addon._id)]),
        );
      expect(response.status).toBe(404);
      expect(await BookingModel.countDocuments({ businessId: t.business._id })).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments({ businessId: t.business._id })).toBe(
        0,
      );
    },
  );

  it("BC-F02 accepted add-on snapshots survive later price changes and a taken slot rejects fresh submission", async () => {
    const t = await setupBookableBusiness();
    const addon = await addonRepository.create({
      businessId: t.business._id,
      status: "ACTIVE",
      name: "Accepted extra",
      priceCents: 1000,
    });
    await addonServiceAssignmentRepository.insertMany([
      { businessId: t.business._id, addonId: addon._id, serviceId: t.service._id },
    ]);
    const app = buildApp();
    const auth = await bearerFor(t.owner._id, "BUSINESS_OWNER");
    const base = `/businesses/${t.business._id}/bookings`;
    const body = validBody(t.service._id, t.membership._id, t.client._id, "10:00", [
      String(addon._id),
    ]);
    const accepted = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(body)
      .expect(201);
    expect(accepted.body.data.financials.totalCents).toBe(9000);
    expect(accepted.body.data.serviceLines[0].addons[0]).toMatchObject({
      name: "Accepted extra",
      priceCents: 1000,
    });
    await addonRepository.replaceById(t.business._id, addon._id, {
      name: addon.name,
      status: "ACTIVE",
      priceCents: 2500,
    });
    const detail = await request(app)
      .get(`${base}/${accepted.body.data.id}`)
      .set("Authorization", auth)
      .expect(200);
    expect(detail.body.data.serviceLines[0].addons[0].priceCents).toBe(1000);
    await request(app)
      .post(base)
      .set("Authorization", auth)
      .send({ ...body, idempotencyKey: `conflict-${new Types.ObjectId()}` })
      .expect(409);
    expect(await BookingModel.countDocuments()).toBe(1);
    const day = await BookingSlotReservationModel.findOne({ businessId: t.business._id }).orFail();
    expect(day.intervals).toHaveLength(1);
    expect(day.intervals[0]?.capacityUsed).toBe(1);
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

  it("7B Supervisor reads, reschedules and cancels an owned booking while a foreign Supervisor is denied", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const foreign = await createBusiness("Other 7B");
    const outsider = await createStaff(foreign.business._id, "SUPERVISOR");
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const foreignAuth = await bearerFor(outsider.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const created = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const id = created.body.data.id as string;
    await request(app).get(`${base}/${id}`).set("Authorization", auth).expect(200);
    await request(app).get(`${base}/${id}`).set("Authorization", foreignAuth).expect(404);
    await request(app)
      .post(`${base}/${id}/cancel`)
      .set("Authorization", foreignAuth)
      .send({ reason: "test" })
      .expect(404);
    await request(app)
      .post(`${base}/${id}/reschedule`)
      .set("Authorization", auth)
      .send({ startAt: startAtFor("11:00") })
      .expect(200);
    expect((await BookingModel.findById(id).orFail()).schedule.startAt.toISOString()).toBe(
      startAtFor("11:00"),
    );
    await request(app)
      .post(`${base}/${id}/cancel`)
      .set("Authorization", auth)
      .send({ reason: "test" })
      .expect(200);
    expect((await BookingModel.findById(id).orFail()).status).toBe("CANCELLED_BY_BUSINESS");
    const reservation = await BookingSlotReservationModel.findOne({
      businessId: t.business._id,
    }).orFail();
    expect(reservation.intervals).toHaveLength(0);
  });

  it("7B Supervisor completes an eligible manual booking through the real route", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const created = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const id = created.body.data.id as string;
    await request(app)
      .post(`${base}/${id}/complete`)
      .set("Authorization", auth)
      .send({})
      .expect(200);
    expect((await BookingModel.findById(id).orFail()).status).toBe("COMPLETED");
  });

  it("7B Supervisor marks and reverses a no-show through the real routes", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const created = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const id = created.body.data.id as string;
    const booking = await BookingModel.findById(id).orFail();
    const start = booking.schedule.startAt.getTime();
    const openMinutes = booking.noShowEligibilitySnapshot?.opensAfterMinutes ?? 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(start + openMinutes * 60_000));
    try {
      const activeAuth = await bearerFor(supervisor.user._id, "SUPERVISOR");
      await request(app)
        .post(`${base}/${id}/no-show`)
        .set("Authorization", activeAuth)
        .send({})
        .expect(200);
      expect((await BookingModel.findById(id).orFail()).status).toBe("PENDING");
      await request(app)
        .post(`${base}/${id}/no-show/cancel`)
        .set("Authorization", activeAuth)
        .send({})
        .expect(200);
      expect((await BookingModel.findById(id).orFail()).status).toBe("NO_SHOW_CANCELLED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("7B Supervisor can waive a pending no-show charge through the real route", async () => {
    const t = await setupBookableBusiness();
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const created = await request(app)
      .post(base)
      .set("Authorization", auth)
      .send(validBody(t.service._id, t.membership._id, t.client._id))
      .expect(201);
    const id = created.body.data.id as string;
    const booking = await BookingModel.findById(id).orFail();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(
      new Date(
        booking.schedule.startAt.getTime() +
          (booking.noShowEligibilitySnapshot?.opensAfterMinutes ?? 0) * 60_000,
      ),
    );
    try {
      const activeAuth = await bearerFor(supervisor.user._id, "SUPERVISOR");
      await request(app)
        .post(`${base}/${id}/no-show`)
        .set("Authorization", activeAuth)
        .send({})
        .expect(200);
      await request(app)
        .post(`${base}/${id}/waive-fee`)
        .set("Authorization", activeAuth)
        .send({ reason: "Customer emergency" })
        .expect(200);
      expect((await BookingModel.findById(id).orFail()).status).toBe("NO_SHOW_WAIVED");
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("7B Supervisor creates a parallel booking with two distinct assigned professionals", async () => {
    const t = await setupBookableBusiness();
    const second = await createStaff(t.business._id);
    const supervisor = await createStaff(t.business._id, "SUPERVISOR");
    await staffWorksMondayToFriday(second.membership._id, t.business._id);
    const secondService = await createFixedService(t.business._id, second.membership._id, 5000);
    const app = buildApp();
    const auth = await bearerFor(supervisor.user._id, "SUPERVISOR");
    const base = `/businesses/${t.business._id}/bookings`;
    const lines = [
      { serviceId: String(t.service._id), staffMembershipId: String(t.membership._id) },
      { serviceId: String(secondService._id), staffMembershipId: String(second.membership._id) },
    ];
    const available = await request(app)
      .post(`${base}/composite-availability`)
      .set("Authorization", auth)
      .send({ fromDate: DATE, toDate: DATE, lines })
      .expect(200);
    expect(
      available.body.data.days[0].slots.some(
        (slot: { startAt: string }) => slot.startAt === startAtFor("10:00"),
      ),
    ).toBe(true);
    const body = {
      ...validBody(t.service._id, t.membership._id, t.client._id),
      serviceLines: lines.map((line) => ({ ...line, addonIds: [], pricingInput: {} })),
    };
    const result = await request(app).post(base).set("Authorization", auth).send(body).expect(201);
    const booking = await BookingModel.findById(result.body.data.id).orFail();
    expect(
      booking.serviceLines.map((line) => String(line.responsibleStaffMembershipId)).sort(),
    ).toEqual([String(t.membership._id), String(second.membership._id)].sort());
    expect(await BookingSlotReservationModel.countDocuments({ businessId: t.business._id })).toBe(
      2,
    );
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

  // --- Fix #2: ownership is decided before any private Business status is disclosed ----------

  describe("Fix #2 — authorization precedes Business approval status", () => {
    type TargetState = "APPROVED" | "WARNING" | "PENDING" | "SUSPENDED";
    const STATES: TargetState[] = ["APPROVED", "WARNING", "PENDING", "SUSPENDED"];

    const setState = async (businessId: Types.ObjectId, state: TargetState) => {
      if (state === "APPROVED") return;
      await BusinessModel.updateOne({ _id: businessId }, { $set: { status: state } }).exec();
    };

    /** A Business in `state` with a fully bookable fixture (so an authorized request would
     * otherwise succeed), plus the exact manual-booking body for it. */
    const targetIn = async (state: TargetState) => {
      const fixture = await setupBookableBusiness();
      await setState(fixture.business._id, state);
      return {
        ...fixture,
        path: `/businesses/${fixture.business._id}/bookings`,
        body: validBody(fixture.service._id, fixture.membership._id, fixture.client._id),
      };
    };

    const observe = (response: request.Response) => ({
      status: response.status,
      message: response.body?.message,
      errors: response.body?.errors,
      data: response.body?.data,
    });

    const nothingCreated = async () => {
      expect(await BookingModel.countDocuments({}).exec()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments({}).exec()).toBe(0);
    };

    it("an unrelated Owner sees the same 404 for approved, warning, pending, suspended and nonexistent Businesses", async () => {
      const app = buildApp();
      const outsider = await createBusiness("Outsider Owner");
      const auth = await bearerFor(outsider.owner._id, "BUSINESS_OWNER");
      const seen = [];
      for (const state of STATES) {
        const target = await targetIn(state);
        seen.push(
          observe(
            await request(app).post(target.path).set("Authorization", auth).send(target.body),
          ),
        );
      }
      const ghost = await targetIn("APPROVED");
      seen.push(
        observe(
          await request(app)
            .post(`/businesses/${new Types.ObjectId()}/bookings`)
            .set("Authorization", auth)
            .send(ghost.body),
        ),
      );
      expect(seen[0]?.status).toBe(404);
      expect(seen[0]?.message).toBe("Business not found");
      for (const observed of seen) expect(observed).toEqual(seen[0]);
      expect(JSON.stringify(seen)).not.toMatch(/PENDING|SUSPENDED|APPROVAL|WARNING/);
      await nothingCreated();
    });

    it("an unrelated, inactive or removed Supervisor cannot distinguish the Business state", async () => {
      const app = buildApp();
      const elsewhere = await createBusiness("Elsewhere");
      const foreignSupervisor = await createStaff(elsewhere.business._id, "SUPERVISOR");
      const foreignAuth = await bearerFor(foreignSupervisor.user._id, "SUPERVISOR");
      const seen = [];
      for (const state of STATES) {
        const target = await targetIn(state);
        const inactive = await createStaff(target.business._id, "SUPERVISOR");
        await StaffMembershipModel.updateOne(
          { _id: inactive.membership._id },
          { $set: { employmentActive: false } },
        ).exec();
        const removed = await createStaff(target.business._id, "SUPERVISOR");
        await StaffMembershipModel.updateOne(
          { _id: removed.membership._id },
          { $set: { removedAt: new Date() } },
        ).exec();
        for (const auth of [
          foreignAuth,
          await bearerFor(inactive.user._id, "SUPERVISOR"),
          await bearerFor(removed.user._id, "SUPERVISOR"),
        ]) {
          seen.push(
            observe(
              await request(app).post(target.path).set("Authorization", auth).send(target.body),
            ),
          );
        }
      }
      seen.push(
        observe(
          await request(app)
            .post(`/businesses/${new Types.ObjectId()}/bookings`)
            .set("Authorization", foreignAuth)
            .send((await targetIn("APPROVED")).body),
        ),
      );
      expect(seen[0]?.status).toBe(404);
      for (const observed of seen) expect(observed).toEqual(seen[0]);
      expect(JSON.stringify(seen)).not.toMatch(/PENDING|SUSPENDED|APPROVAL|WARNING/);
      await nothingCreated();
    });

    it("Staff and Customer stay at the role boundary, identically for every Business state", async () => {
      const app = buildApp();
      const customer = await userRepository.create({
        normalizedEmail: `customer-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      const customerAuth = await bearerFor(customer._id, "CUSTOMER");
      const staffSeen = [];
      const customerSeen = [];
      for (const state of STATES) {
        const target = await targetIn(state);
        const staffAuth = await bearerFor(target.membership.userId, "STAFF");
        staffSeen.push(
          observe(
            await request(app).post(target.path).set("Authorization", staffAuth).send(target.body),
          ),
        );
        customerSeen.push(
          observe(
            await request(app)
              .post(target.path)
              .set("Authorization", customerAuth)
              .send(target.body),
          ),
        );
      }
      expect(staffSeen[0]?.status).toBe(403);
      for (const observed of [...staffSeen, ...customerSeen])
        expect(observed).toEqual(staffSeen[0]);
      expect(JSON.stringify(staffSeen)).not.toMatch(/PENDING|SUSPENDED|APPROVAL|WARNING/);
      await nothingCreated();
    });

    it("the authorized Owner and active Supervisor still create on APPROVED/WARNING and learn PENDING/SUSPENDED", async () => {
      const app = buildApp();
      const expected: Record<TargetState, { status: number; code?: string }> = {
        APPROVED: { status: 201 },
        WARNING: { status: 201 },
        PENDING: { status: 403, code: "BUSINESS_PENDING_APPROVAL" },
        SUSPENDED: { status: 403, code: "BUSINESS_SUSPENDED" },
      };
      for (const state of STATES) {
        const target = await targetIn(state);
        const supervisor = await createStaff(target.business._id, "SUPERVISOR");
        const actors = [
          await bearerFor(target.owner._id, "BUSINESS_OWNER"),
          await bearerFor(supervisor.user._id, "SUPERVISOR"),
        ];
        for (const [index, auth] of actors.entries()) {
          const body = validBody(
            target.service._id,
            target.membership._id,
            target.client._id,
            index === 0 ? "10:00" : "12:00",
          );
          const response = await request(app)
            .post(target.path)
            .set("Authorization", auth)
            .send(body);
          expect({ state, index, status: response.status }).toEqual({
            state,
            index,
            status: expected[state].status,
          });
          if (expected[state].code) {
            expect(JSON.stringify(response.body)).toContain(expected[state].code);
          }
        }
        const created = await BookingModel.countDocuments({
          businessId: target.business._id,
        }).exec();
        expect(created).toBe(expected[state].status === 201 ? 2 : 0);
      }
    });

    it("an authorized Owner's malformed request is still validated before the status gate", async () => {
      const app = buildApp();
      const target = await targetIn("PENDING");
      const response = await request(app)
        .post(target.path)
        .set("Authorization", await bearerFor(target.owner._id, "BUSINESS_OWNER"))
        .send({ ...target.body, unexpected: true });
      expect(response.status).toBe(400);
      await nothingCreated();
    });

    it("existing-booking lifecycle reads stay owner-scoped and ungated on a SUSPENDED Business", async () => {
      const app = buildApp();
      const target = await targetIn("APPROVED");
      const ownerAuth = await bearerFor(target.owner._id, "BUSINESS_OWNER");
      const created = await request(app)
        .post(target.path)
        .set("Authorization", ownerAuth)
        .send(target.body)
        .expect(201);
      await setState(target.business._id, "SUSPENDED");
      const id = created.body.data.id;
      await request(app).get(`${target.path}/${id}`).set("Authorization", ownerAuth).expect(200);
      const outsider = await createBusiness("Outsider Reader");
      const outsiderAuth = await bearerFor(outsider.owner._id, "BUSINESS_OWNER");
      await request(app).get(`${target.path}/${id}`).set("Authorization", outsiderAuth).expect(404);
    });
  });
});
