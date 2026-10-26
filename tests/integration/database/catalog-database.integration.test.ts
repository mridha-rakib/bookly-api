import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { toBookingDetailDto } from "../../../src/modules/booking/booking.dto.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { createCustomerBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { CustomerFinancialOutcomeRead } from "../../../src/modules/booking/customer-financial-outcome.read.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
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
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { ensureRefundAccounting } from "../../../src/modules/payment/refund-accounting.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../../../src/modules/payment/stripe-payment-gateway.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ExternalRefundModel } from "../../../src/modules/provider-reversal/external-refund.model.js";
import { PaymentDisputeModel } from "../../../src/modules/provider-reversal/payment-dispute.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
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

  const createBusiness = async (
    name: string,
    status: "APPROVED" | "PENDING" | "SUSPENDED" = "APPROVED",
  ) => {
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
    // The public catalog read enforces `requireApprovedBusiness` (APPROVED/WARNING only), so the
    // default fixture is an APPROVED business — the same approach review-http-database's own
    // `createBusiness` helper already takes. Pass "PENDING"/"SUSPENDED" to test the hidden path.
    if (status === "PENDING") {
      return { owner, business: pending };
    }
    const business = await businessRepository.casUpdateStatus(pending._id, ["PENDING"], status, {
      fromStatus: "PENDING",
      actorUserId: owner._id,
      changedAt: new Date(),
    });
    return { owner, business: business ?? pending };
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

  it("[race, Batch 9 completion pass — bug found and fixed; P1 semantics] two concurrent FIRST bookings for the SAME brand-new customer share exactly ONE BusinessClient row and never fail with a raw error", async () => {
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
    // P1: the first/returning claim is atomic before any charge, so while one first booking is
    // unresolved the other may be refused with the retryable domain conflict
    // BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS (nothing charged) — or, if it only arrived after the
    // winner completed, succeed as RETURNING. What must never happen is the original bug: a raw
    // duplicate-key error from the concurrent Client creation.
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status !== "rejected") continue;
      expect(r.reason).toMatchObject({
        statusCode: 409,
        details: [{ code: "BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS" }],
      });
    }
    expect(
      confirmed.filter(
        (r) => r.value.status === "confirmed" && r.value.booking.financials.platformFeeCents > 0,
      ),
    ).toHaveLength(1);

    const clients = await BusinessClientModel.find({
      businessId: business._id,
      linkedUserId: customer._id,
    }).exec();
    expect(clients).toHaveLength(1);

    // Every confirmed booking references the SAME single Client row, never two fragmented ones.
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
  ) => `Bearer ${await issueTestAccessToken(tokenService, { userId, role })}`;

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

  it("allows an anonymous (no Authorization header) visitor to read the public venue catalog", async () => {
    const { business, service } = await setupBookableBusiness(8000);
    const app = buildCatalogApp();

    const response = await request(app).get(`/catalog/businesses/${business._id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.business.id).toBe(String(business._id));
    expect(response.body.data.services[0].id).toBe(String(service._id));
    // Public-safe fields only, even anonymously — never email/phone/ownerUserId.
    expect(response.body.data.business.email).toBeUndefined();
    expect(response.body.data.business.phone).toBeUndefined();
    expect(response.body.data.business.ownerUserId).toBeUndefined();
  });

  it("still serves the public venue catalog to a logged-in Business Owner / Staff (no role gate on the read)", async () => {
    const { business, owner, membership } = await setupBookableBusiness(8000);
    const app = buildCatalogApp();

    const ownerResponse = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(ownerResponse.status).toBe(200);

    const staffResponse = await request(app)
      .get(`/catalog/businesses/${business._id}`)
      .set("Authorization", await bearerFor(membership.userId, "STAFF"));
    expect(staffResponse.status).toBe(200);
  });

  it("hides a PENDING or SUSPENDED business from the public venue catalog (403)", async () => {
    const app = buildCatalogApp();

    const { business: pending } = await createBusiness("Pending Co", "PENDING");
    const pendingResponse = await request(app).get(`/catalog/businesses/${pending._id}`);
    expect(pendingResponse.status).toBe(403);

    const { business: suspended } = await createBusiness("Suspended Co", "SUSPENDED");
    const suspendedResponse = await request(app).get(`/catalog/businesses/${suspended._id}`);
    expect(suspendedResponse.status).toBe(403);
  });

  it("keeps the booking-wizard sub-routes (add-ons / availability) CUSTOMER-authenticated", async () => {
    const { business, service } = await setupBookableBusiness(8000);
    const app = buildCatalogApp();

    const anonAddons = await request(app).get(
      `/catalog/businesses/${business._id}/services/${service._id}/addons`,
    );
    expect(anonAddons.status).toBe(401);

    const anonAvailability = await request(app)
      .get(`/catalog/businesses/${business._id}/services/${service._id}/availability`)
      .query({ fromDate: DATE, toDate: DATE });
    expect(anonAvailability.status).toBe(401);

    const { owner } = await createBusiness("Owner On Wizard");
    const ownerAddons = await request(app)
      .get(`/catalog/businesses/${business._id}/services/${service._id}/addons`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(ownerAddons.status).toBe(403);
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

  it("F1B: Customer hourly HTTP contract, full-duration preview parity and authoritative concurrent finalize", async () => {
    const { owner, business } = await createBusiness("Hourly venue");
    const { membership } = await createStaff(business._id);
    const service = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Hourly",
      pricingMode: "HOURLY",
      hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 4, bufferAfterMin: 15 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [membership._id],
    });
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const customer = await createCustomer("hourly-contract");
    await saveCard(customer._id);
    const token = await bearerFor(customer._id, "CUSTOMER");
    const app = buildCatalogApp();
    const read = (hours?: number | string) =>
      request(app)
        .get(`/catalog/businesses/${business._id}/services/${service._id}/availability`)
        .query({ fromDate: DATE, toDate: DATE, ...(hours === undefined ? {} : { hours }) })
        .set("Authorization", token);
    const legacy = await read();
    expect(legacy.status).toBe(200);
    expect((await read(2)).body.data).toEqual(legacy.body.data);
    const fixed = await createFixedService(business._id, membership._id);
    const fixedUrl = `/catalog/businesses/${business._id}/services/${fixed._id}/availability`;
    expect(
      (
        await request(app)
          .get(fixedUrl)
          .query({ fromDate: DATE, toDate: DATE })
          .set("Authorization", token)
      ).status,
    ).toBe(200);
    const invalidFixed = await request(app)
      .get(fixedUrl)
      .query({ fromDate: DATE, toDate: DATE, hours: 2 })
      .set("Authorization", token);
    expect(invalidFixed.status).toBe(400);
    expect(JSON.stringify(invalidFixed.body)).toContain("AVAILABILITY_HOURS_INVALID");
    for (const hours of [1, 5, "NaN", "Infinity", "abc", 0, 25])
      expect((await read(hours)).status).toBe(400);
    const input = (hours: number, startAt: string) => ({
      ...finalizeInput(service._id, membership._id),
      startAt,
      serviceLines: [
        {
          serviceId: String(service._id),
          staffMembershipId: String(membership._id),
          addonIds: [],
          pricingInput: { hours },
        },
      ],
    });
    for (const hours of [2.5, 4]) {
      const response = await read(hours);
      expect(response.status).toBe(200);
      const slots = response.body.data.days[0].slots as Array<{ startAt: string; endAt: string }>;
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe((hours * 60 + 15) * 60_000);
        await expect(
          creationService.previewCustomerBooking(
            String(customer._id),
            String(business._id),
            input(hours, slot.startAt),
          ),
        ).resolves.toBeDefined();
      }
    }
    // The short 15:00 slot must never be offered or admitted for four hours.
    expect(
      legacy.body.data.days[0].slots.some(
        (s: { startAt: string }) => s.startAt === startAtFor("15:00"),
      ),
    ).toBe(true);
    expect(
      (await read(4)).body.data.days[0].slots.some(
        (s: { startAt: string }) => s.startAt === startAtFor("15:00"),
      ),
    ).toBe(false);
    await expect(
      creationService.previewCustomerBooking(
        String(customer._id),
        String(business._id),
        input(4, startAtFor("15:00")),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Establish returning-client financial identity on a different day, so the
    // scheduling admission gate, rather than first-relationship admission, decides the loser.
    const established = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      input(2, businessLocalToUtc(TIMEZONE, "2030-08-19", "09:00").toISOString()),
    );
    expect(established.status).toBe("confirmed");
    const chargeCountBefore = paymentGateway.paymentIntentInputs.length;
    const result = await Promise.allSettled([
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        input(4, startAtFor("13:00")),
      ),
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        input(4, startAtFor("11:00")),
      ),
    ]);
    // Both starts were offered before this race; they overlap at four hours. Final writes
    // remain authoritative after the read, regardless of the previous availability response.
    expect(
      result.filter((r) => r.status === "fulfilled" && r.value.status === "confirmed"),
    ).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await BookingModel.countDocuments({ businessId: business._id })).toBe(2);
    const occupancy = await BookingSlotReservationModel.findOne({
      businessId: business._id,
      staffMembershipId: membership._id,
      occupancyDate: DATE,
    }).lean();
    expect(occupancy?.intervals.filter((interval) => interval.status === "CONFIRMED")).toHaveLength(
      1,
    );
    // Returning bookings collect zero online under the existing financial policy.
    expect(paymentGateway.paymentIntentInputs).toHaveLength(chargeCountBefore);
    expect((await read(4)).body.data.days[0].slots).toEqual([]);
  });

  it("F2D: real Customer detail is owned, bounded, private and performs no financial writes or provider calls", async () => {
    const { business, owner, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("f2d-owned");
    const foreign = await createCustomer("f2d-foreign");
    await saveCard(customer._id);
    const created = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (created.status !== "confirmed") throw new Error("Expected real persisted Booking");
    await Promise.all([
      PaymentAttemptModel.init(),
      RefundOperationModel.init(),
      ExternalRefundModel.init(),
      PaymentDisputeModel.init(),
    ]);
    const token = await bearerFor(customer._id, "CUSTOMER");
    const foreignToken = await bearerFor(foreign._id, "CUSTOMER");
    const ownerToken = await bearerFor(owner._id, "BUSINESS_OWNER");
    const app = express();
    app.use(express.json());
    app.use("/me", createCustomerBookingRoute());
    app.use(createErrorHandler());
    const url = `/me/bookings/${created.booking._id}`;
    const providerMethods = [
      "retrievePaymentIntent",
      "createAndConfirmPaymentIntent",
      "createRefund",
      "retrieveRefund",
      "listRefundsForPaymentIntent",
      "retrieveDispute",
    ] as const;
    const providerSpies = providerMethods.map((method) =>
      vi
        .spyOn(StripePaymentGateway.prototype, method)
        .mockRejectedValue(new Error("GET must not call provider")),
    );
    const snapshot = async () => {
      const db = mongoose.connection.db!;
      const names = [
        BookingModel.collection.name,
        PaymentAttemptModel.collection.name,
        RefundOperationModel.collection.name,
        ExternalRefundModel.collection.name,
        PaymentDisputeModel.collection.name,
        BookingFinancialTransactionModel.collection.name,
        BookingSlotReservationModel.collection.name,
      ];
      return Promise.all(
        names.map(async (name) => ({
          name,
          rows: await db.collection(name).find({}).sort({ _id: 1 }).toArray(),
        })),
      );
    };
    try {
      const before = JSON.stringify(await snapshot());
      const response = await request(app).get(url).set("Authorization", token);
      expect(response.status).toBe(200);
      expect(response.body.data.financialOutcome.payments.items[0]).toMatchObject({
        providerStatus: "SUCCEEDED",
        providerConfirmed: true,
        accountingConfirmed: true,
      });
      expect(response.body.data.financialOutcome.refunds).toEqual({ items: [], hasMore: false });
      expect(JSON.stringify(response.body.data.financialOutcome)).not.toMatch(
        /clientSecret|providerPaymentIntentId|providerRefundId|lastError|idempotency|payout/,
      );
      expect((await request(app).get(url).set("Authorization", foreignToken)).status).toBe(404);
      expect(
        (
          await request(app)
            .get(`/me/bookings/${new Types.ObjectId()}`)
            .set("Authorization", foreignToken)
        ).status,
      ).toBe(404);
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url).set("Authorization", ownerToken)).status).toBe(403);
      const list = await request(app).get("/me/bookings").set("Authorization", token);
      expect(list.status).toBe(200);
      expect(list.body.data.bookings[0]).not.toHaveProperty("financialOutcome");
      expect(toBookingDetailDto(created.booking)).not.toHaveProperty("financialOutcome");
      expect(JSON.stringify(await snapshot())).toBe(before);
      providerSpies.forEach((spy) => {
        expect(spy).not.toHaveBeenCalled();
      });
    } finally {
      providerSpies.forEach((spy) => {
        spy.mockRestore();
      });
    }
  });

  it("F2D: a real Bookly refund operation has distinct provider/accounting evidence and no owed-amount reconstruction", async () => {
    const { business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("f2d-refund");
    await saveCard(customer._id);
    const created = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (created.status !== "confirmed") throw new Error("Expected real Booking");
    await Promise.all([
      PaymentAttemptModel.init(),
      RefundOperationModel.init(),
      ExternalRefundModel.init(),
      PaymentDisputeModel.init(),
    ]);
    const source = await BookingFinancialTransactionModel.findOne({
      bookingId: created.booking._id,
      status: "SUCCEEDED",
      type: { $in: ["PLATFORM_FEE", "DEPOSIT"] },
    }).orFail();
    const refund = await paymentService.refund({
      paymentIntentId: source.providerReference!,
      amountCents: source.amountCents,
      currency: "EUR",
      idempotencyKey: `business-cancel-refund:${created.booking._id}`,
      domainReason: "BUSINESS_CANCELLATION",
      sourceFinancialTransactionId: source._id,
      bookingId: created.booking._id,
      businessId: business._id,
      customerUserId: customer._id,
      businessClientId: created.booking.customer.businessClientId,
    });
    const operation = await RefundOperationModel.findById(refund.refundOperationId).orFail();
    const read = new CustomerFinancialOutcomeRead();
    const observed = await read.forOwnedBooking(String(customer._id), created.booking);
    expect(observed.financialOutcome?.refunds.items[0]).toMatchObject({
      origin: "BOOKLY",
      status: "SUCCEEDED",
      providerConfirmed: true,
      accountingConfirmed: false,
    });
    await ensureRefundAccounting(
      operation,
      financialTransactionService,
      new RefundOperationRepository(),
    );
    const accounted = await read.forOwnedBooking(String(customer._id), created.booking);
    expect(accounted.financialOutcome?.refunds.items[0]).toMatchObject({
      providerConfirmed: true,
      accountingConfirmed: true,
      amountCents: source.amountCents,
    });
    expect(created.booking.cancellationOutcome).toBeUndefined(); // refund read did not manufacture cancellation/intent
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
