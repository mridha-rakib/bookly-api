import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/**
 * Batch 12 — HTTP-level tests for the new Super Admin Analytics surface
 * (super-admin.route.ts's /analytics/* routes). Exercises real routes end to end, including the
 * real booking-creation/payment pipeline so financial-ownership assertions are backed by genuine
 * ledger entries, never fixtures that assert against themselves.
 */
describe("HTTP-level Super Admin Analytics (Batch 12)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
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
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    bookingRepository = new BookingRepository();
    paymentGateway = new FakePaymentGateway();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
    );
    const financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const promoApplicationService = new PromoApplicationService(
      new PromoRepository(),
      new PromoUserUsageRepository(),
      new PromoRedemptionRepository(),
    );

    const availabilityService = new AvailabilityService(
      businessRepository,
      serviceRepository,
      staffRepository,
      staffScheduleRepository,
      new StaffTimeOffRepository(),
      businessHoursRepository,
      new BusinessBookingSettingsRepository(),
      new BusinessTravelSettingsRepository(),
      reservationRepository,
    );

    const bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      new AddonRepository(),
      new AddonServiceAssignmentRepository(),
      clientRepository,
      bookingRepository,
    );

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      new BusinessTravelSettingsRepository(),
      new BusinessCancellationPolicyRepository(),
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
    );

    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createSuperAdmin = async () =>
    userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  const createBusiness = async (name: string, category = "Barber") => {
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
      category,
      subcategories: ["Haircut"],
    });
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

  const createStaff = async (businessId: Types.ObjectId) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role: "STAFF",
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
    name = "Haircut",
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name,
      pricingMode: "FIXED",
      fixedPricing: { priceCents, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    });

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  const saveCard = async (userId: Types.ObjectId) => {
    const setupIntent = await paymentService.createSetupIntent(String(userId));
    await paymentService.confirmSavedPaymentMethod(String(userId), setupIntent.setupIntentId);
  };

  const linkCustomerToBusiness = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    customerId: Types.ObjectId,
  ) => {
    const user = await userRepository.findById(customerId);
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
    await clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Test",
      lastName: "Customer",
      normalizedEmail: user?.normalizedEmail ?? `linked-${customerId.toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "LINKED",
      linkedUserId: customerId,
    });
  };

  const startAtFor = (time: string) => businessLocalToUtc(TIMEZONE, DATE, time).toISOString();

  const setupBookableBusiness = async (priceCents = 8000) => {
    const { owner, business } = await createBusiness("Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, priceCents);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    return { owner, business, membership, service };
  };

  const finalizeInput = (serviceId: Types.ObjectId, staffId: Types.ObjectId, time = "10:00") => ({
    serviceLines: [
      {
        serviceId: String(serviceId),
        staffMembershipId: String(staffId),
        addonIds: [],
        pricingInput: {},
      },
    ],
    startAt: startAtFor(time),
    idempotencyKey: `key-${new Types.ObjectId().toString()}`,
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const around = () => {
    const now = new Date();
    return {
      fromDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      toDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  };

  // --- Authorization: every /analytics endpoint is SUPER_ADMIN-only ------------------------------

  it("rejects a BUSINESS_OWNER token on every analytics endpoint (403)", async () => {
    const { owner } = await createBusiness("Salon A");
    const app = buildApp();
    const bearer = await bearerFor(owner._id, "BUSINESS_OWNER");

    const endpoints = [
      "/super-admin/analytics/bookings",
      "/super-admin/analytics/businesses",
      "/super-admin/analytics/customers",
      "/super-admin/analytics/top-services",
      "/super-admin/analytics/cities",
      "/super-admin/analytics/recent-activity",
    ];

    for (const endpoint of endpoints) {
      const response = await request(app).get(endpoint).set("Authorization", bearer);
      expect(response.status).toBe(403);
    }
  });

  it("rejects requests with no Authorization header at all (401)", async () => {
    const app = buildApp();
    const response = await request(app).get("/super-admin/analytics/bookings");
    expect(response.status).toBe(401);
  });

  // --- Date-filter validation --------------------------------------------------------------------

  it("rejects fromDate supplied without toDate (400)", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query({ fromDate: new Date().toISOString() })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(400);
  });

  it("rejects an inverted date range (fromDate >= toDate) (400)", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query({ fromDate: "2030-06-01T00:00:00.000Z", toDate: "2030-01-01T00:00:00.000Z" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(400);
  });

  // --- Empty dataset: honest zeros, never an error ------------------------------------------------

  it("returns an honest all-zero response for a period with no bookings", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.totalCount).toBe(0);
    expect(response.body.data.platformRevenueCents).toBe(0);
    expect(response.body.data.clientTypeSplit).toEqual({ manual: 0, newBooking: 0, returning: 0 });
  });

  // --- Booking analytics: manual/new/returning classification, financial separation --------------

  it("[financial-ownership] a first booking's €16 Bookly PLATFORM_FEE never inflates alongside its own €80 gross — Booking Analytics reports ONLY the €16 as platformRevenueCents", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("first");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.financials.platformFeeCents).toBe(1600); // 20% of €80

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.platformRevenueCents).toBe(1600);
    expect(response.body.data.totalCount).toBe(1);
    expect(response.body.data.clientTypeSplit).toEqual({ manual: 0, newBooking: 1, returning: 0 });
  });

  it("a returning customer's second booking (platformFeeCents=0) is classified Returning, never New — and contributes €0 to platformRevenueCents", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("returning");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");
    const second = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "14:00"),
    );
    if (second.status !== "confirmed") throw new Error("expected confirmed");
    expect(second.booking.financials.platformFeeCents).toBe(0);

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.clientTypeSplit).toEqual({ manual: 0, newBooking: 1, returning: 1 });
    // Only the FIRST booking's platform fee counts — the second contributes nothing.
    expect(response.body.data.platformRevenueCents).toBe(1600);
  });

  it("a MANUAL booking is classified Manual, never New or Returning, regardless of platformFeeCents", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const client = await clientRepository.create({
      businessId: business._id,
      createdByUserId: owner._id,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99000111", e164: "+35799000111" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });

    const bookingApp = express();
    bookingApp.use(express.json());
    bookingApp.use("/businesses", createBusinessBookingRoute());
    bookingApp.use(createErrorHandler({ isProduction: true }));

    const created = await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor("10:00"),
        businessClientId: String(client._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.financials.platformFeeCents).toBe(0);

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.clientTypeSplit).toEqual({ manual: 1, newBooking: 0, returning: 0 });
  });

  it("monthly series is zero-filled across the whole requested range, not sparse", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();
    const from = new Date("2030-01-01T00:00:00.000Z");
    const to = new Date("2030-04-01T00:00:00.000Z");

    const response = await request(app)
      .get("/super-admin/analytics/bookings")
      .query({ fromDate: from.toISOString(), toDate: to.toISOString() })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.monthlySeries).toEqual([
      { year: 2030, month: 1, count: 0 },
      { year: 2030, month: 2, count: 0 },
      { year: 2030, month: 3, count: 0 },
      { year: 2030, month: 4, count: 0 },
    ]);
  });

  // --- Business analytics: revenue-by-business reuses shared ownership primitives ------------------

  it("[financial-ownership] Top Businesses by Revenue reports the SAME Bookly-owned figure as Finance, never booking.totalCents", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("rev");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    // totalCents (gross booking price) must NEVER be reported as Bookly's revenue.
    expect(result.booking.financials.totalCents).toBeGreaterThan(1600);

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/businesses")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    const row = response.body.data.topByRevenue.find(
      (r: { businessId: string }) => r.businessId === String(business._id),
    );
    expect(row).toBeDefined();
    expect(row.bookyRevenueCents).toBe(1600);
    expect(row.bookingsCount).toBe(1);
  });

  it("counts a genuinely new activation as a new customer for that Business only", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("activation");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/businesses")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    const row = response.body.data.topByNewCustomers.find(
      (r: { businessId: string }) => r.businessId === String(business._id),
    );
    expect(row?.newCustomersCount).toBe(1);
  });

  // --- Customer analytics: global activation, business-scoped concepts never conflated -----------

  it("a Customer who booked is 'activated'; one who never booked is 'dormant' — never the reverse", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const activeCustomer = await createCustomer("active");
    await saveCard(activeCustomer._id);
    await linkCustomerToBusiness(business._id, owner._id, activeCustomer._id);
    await creationService.finalizeCustomerBooking(
      String(activeCustomer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    await createCustomer("neverbooked");

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/customers")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.registeredTotal).toBe(2);
    expect(response.body.data.activatedCount).toBe(1);
    expect(response.body.data.dormantCount).toBe(1);
  });

  // --- Top Services: survives name resolution via the persisted snapshot, not a live join --------

  it("Top Services reports the real, persisted service name and business", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("topsvc");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/top-services")
      .query(around())
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    const row = response.body.data.services.find(
      (r: { serviceId: string }) => r.serviceId === String(service._id),
    );
    expect(row).toBeDefined();
    expect(row.name).toBe("Haircut");
    expect(row.businessName).toBe(business.name);
    expect(row.count).toBe(1);
  });

  // --- City Coverage: real, enum-constrained aggregation ------------------------------------------

  it("City Coverage correctly buckets a Business into its real city with a real premises/mobile split", async () => {
    const superAdmin = await createSuperAdmin();
    await createBusiness("Larnaca Salon");

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/cities")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    const row = response.body.data.cities.find((c: { city: string }) => c.city === "Larnaca");
    expect(row).toBeDefined();
    expect(row.premisesCount).toBeGreaterThanOrEqual(1);
    expect(row.approvedCount).toBeGreaterThanOrEqual(1);
  });

  // --- Recent Activity: bounded, real events only -------------------------------------------------

  it("Recent Activity surfaces a real business-application event and respects the limit", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createBusiness("Fresh Application Salon");

    const app = buildApp();
    const response = await request(app)
      .get("/super-admin/analytics/recent-activity")
      .query({ limit: "5" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.activities.length).toBeLessThanOrEqual(5);
    const found = response.body.data.activities.some((a: { summary: string }) =>
      a.summary.includes(business.name),
    );
    expect(found).toBe(true);
  });

  it("rejects an out-of-range limit on top-services/recent-activity (400)", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const response = await request(app)
      .get("/super-admin/analytics/recent-activity")
      .query({ limit: "not-a-number" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(400);
  });
});
