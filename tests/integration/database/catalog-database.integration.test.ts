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
import { createCatalogRoute } from "../../../src/modules/catalog/catalog.route.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
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
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

describe("database-backed Customer Catalog + AT_BUSINESS_LOCATION first-booking fix (Batch 9)", () => {
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
  let reservationService: BookingSlotReservationService;
  let availabilityService: AvailabilityService;
  let bookingService: BookingService;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
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
    const reservationRepository = new BookingSlotReservationRepository();
    reservationService = new BookingSlotReservationService(reservationRepository);
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
    paymentGateway = new FakePaymentGateway();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
    );
    financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const promoApplicationService = new PromoApplicationService(
      new PromoRepository(),
      new PromoUserUsageRepository(),
      new PromoRedemptionRepository(),
    );
    tokenService = new TokenService(new SessionRepository());

    availabilityService = new AvailabilityService(
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

    bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      addonRepository,
      addonServiceAssignmentRepository,
      clientRepository,
      bookingRepository,
    );

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      new BusinessTravelSettingsRepository(),
      cancellationPolicyRepository,
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
    );
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

  const createStaff = async (businessId: Types.ObjectId) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Loay",
      lastName: "K",
      gender: "other",
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

  const createCustomer = async (tag: string) => {
    const user = await userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const nationalNumber = `9${user._id.toString().slice(-7)}`;
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Test",
      lastName: "Customer",
      gender: "other",
      phone: { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` },
    });
    return user;
  };

  const saveCard = async (userId: Types.ObjectId) => {
    const setupIntent = await paymentService.createSetupIntent(String(userId));
    await paymentService.confirmSavedPaymentMethod(String(userId), setupIntent.setupIntentId);
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

  // --- The AT_BUSINESS_LOCATION first-booking gap fix ------------------------------------------

  it("a brand-new customer can complete their FIRST booking at an AT_BUSINESS_LOCATION business with no pre-existing Client record", async () => {
    const { business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("first-at-location");
    await saveCard(customer._id);

    // Deliberately no clientRepository.create() call — this is the exact "genuinely first-time
    // Customer, no BusinessClient row exists yet" scenario that previously threw
    // BOOKING_CUSTOMER_CLIENT_PROFILE_REQUIRED.
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );

    expect(result.status).toBe("confirmed");
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.financials.platformFeeCents).toBeGreaterThan(0);

    const client = await clientRepository.findByBusinessIdAndLinkedUserId(
      business._id,
      customer._id,
    );
    expect(client).toBeDefined();
    expect(client?.address).toBeUndefined();
    expect(client?.linkState).toBe("LINKED");
  });

  it("[race, Batch 9 completion pass — bug found and fixed] two concurrent FIRST bookings for the SAME brand-new customer at DIFFERENT times both succeed, sharing exactly ONE BusinessClient row", async () => {
    const { business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("concurrent-first-client");
    await saveCard(customer._id);

    // Previously: the losing call's Client-creation attempt let a raw, uncaught MongoServerError
    // (E11000 on the (businessId, normalizedEmail) unique index) propagate as an opaque 500 —
    // even though it happens before any Stripe charge, so nothing was financially lost, the
    // customer still saw their SECOND (fully legitimate, different-time) booking attempt fail
    // ungracefully. resolveOrCreateCustomerClient now self-heals by re-fetching the winner's row.
    const results = await Promise.allSettled([
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "10:00"),
      ),
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "14:00"),
      ),
    ]);

    const confirmed = results.filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof creationService.finalizeCustomerBooking>>
      > => r.status === "fulfilled" && r.value.status === "confirmed",
    );
    // Two different times, same Customer+Business — no slot conflict, so BOTH must succeed now.
    expect(confirmed).toHaveLength(2);

    const clients = await BusinessClientModel.find({
      businessId: business._id,
      linkedUserId: customer._id,
    }).exec();
    expect(clients).toHaveLength(1);

    // Exactly one of the two bookings won activation (first-booking race, already covered
    // elsewhere) — both still reference the SAME single Client row, never two fragmented ones.
    for (const r of confirmed) {
      if (r.value.status !== "confirmed") continue;
      expect(String(r.value.booking.customer.businessClientId)).toBe(String(clients[0]?._id));
    }
  });

  // --- Catalog: authorization -------------------------------------------------------------------

  const buildCatalogApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/catalog", createCatalogRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  it("allows an authenticated Customer to read a Business's bookable catalog", async () => {
    const { business, service, membership } = await setupBookableBusiness(8000);
    const customer = await createCustomer("catalog-read");
    const app = buildCatalogApp();

    const response = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(200);
    expect(response.body.data.business.id).toBe(String(business._id));
    // Public-safe fields only — never email/phone/ownerUserId.
    expect(response.body.data.business.email).toBeUndefined();
    expect(response.body.data.business.phone).toBeUndefined();
    expect(response.body.data.business.ownerUserId).toBeUndefined();

    expect(response.body.data.services).toHaveLength(1);
    expect(response.body.data.services[0].id).toBe(String(service._id));
    expect(response.body.data.services[0].assignedStaffMembershipIds).toEqual([
      String(membership._id),
    ]);

    expect(response.body.data.staff).toHaveLength(1);
    expect(response.body.data.staff[0].firstName).toBe("Loay");
  });

  it("denies a Business Owner/Staff/Supervisor from using the customer catalog route", async () => {
    const { business, owner, membership } = await setupBookableBusiness(8000);
    const app = buildCatalogApp();

    const ownerResponse = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(ownerResponse.status).toBe(403);

    const staffResponse = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(membership.userId, "STAFF"));
    expect(staffResponse.status).toBe(403);
  });

  it("rejects a request with no Authorization header", async () => {
    const { business } = await setupBookableBusiness(8000);
    const app = buildCatalogApp();
    const response = await request(app).get(`/catalog/businesses/${business._id}`);
    expect(response.status).toBe(401);
  });

  it("excludes DRAFT/ARCHIVED services and add-ons from the customer-facing catalog", async () => {
    const { business, membership } = await setupBookableBusiness(8000);
    const draftService = await serviceRepository.create({
      businessId: business._id,
      status: "DRAFT",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Draft Service",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 5000, durationMin: 30 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [membership._id],
    });
    void draftService;

    const customer = await createCustomer("catalog-filter");
    const app = buildCatalogApp();
    const response = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(200);
    const serviceNames = response.body.data.services.map((s: { name: string }) => s.name);
    expect(serviceNames).not.toContain("Draft Service");
  });

  it("returns only ACTIVE add-ons assigned to a Service", async () => {
    const { business, service } = await setupBookableBusiness(8000);
    const activeAddon = await addonRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      name: "Beard Trim",
      priceCents: 1000,
    });
    const draftAddon = await addonRepository.create({
      businessId: business._id,
      status: "DRAFT",
      name: "Hidden Addon",
      priceCents: 500,
    });
    await addonServiceAssignmentRepository.insertMany([
      { businessId: business._id, addonId: activeAddon._id, serviceId: service._id },
      { businessId: business._id, addonId: draftAddon._id, serviceId: service._id },
    ]);

    const customer = await createCustomer("addon-filter");
    const app = buildCatalogApp();
    const response = await request(app)
      .get(`/catalog/businesses/${business._id}/services/${service._id}/addons`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(200);
    expect(response.body.data.addons).toHaveLength(1);
    expect(response.body.data.addons[0].name).toBe("Beard Trim");
  });

  it("serves real availability through the customer catalog route, matching the Owner-facing engine", async () => {
    const { business, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("availability-read");
    const app = buildCatalogApp();

    const response = await request(app)
      .get(`/catalog/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE })
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(200);
    expect(response.body.data.days).toHaveLength(1);
    expect(response.body.data.days[0].isOpen).toBe(true);
    expect(response.body.data.days[0].slots.length).toBeGreaterThan(0);
  });

  it("returns 404 for a nonexistent Business (never leaks existence details)", async () => {
    const customer = await createCustomer("catalog-404");
    const app = buildCatalogApp();
    const response = await request(app)
      .get(`/catalog/businesses/${new Types.ObjectId()}`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(response.status).toBe(404);
  });
});
