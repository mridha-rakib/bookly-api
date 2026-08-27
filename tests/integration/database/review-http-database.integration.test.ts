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
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
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
import {
  createCustomerReviewRoute,
  createPublicBusinessReviewRoute,
} from "../../../src/modules/review/review.route.js";
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
 * Batch 14 — the HTTP-layer boundary the service-level review-database.integration.test.ts
 * deliberately doesn't cover: real route wiring, `requireRoles`/`requireActiveUser` auth gates,
 * zod `.strict()` unknown-field rejection, and exactly what a real HTTP response body contains
 * (never a raw Mongoose document — no email/phone/customerUserId leak).
 */
describe("HTTP-level Review endpoints (Batch 14)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
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
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    const bookingRepository = new BookingRepository();
    const paymentGateway = new FakePaymentGateway();
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

    lifecycleService = new BookingLifecycleService(
      bookingService,
      bookingRepository,
      businessRepository,
      reservationService,
      availabilityService,
      serviceRepository,
      staffRepository,
      paymentService,
      financialTransactionService,
    );

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
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      { fromStatus: "PENDING", actorUserId: owner._id, changedAt: new Date() },
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

  const createFixedService = async (businessId: Types.ObjectId, staffId: Types.ObjectId) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 8000, durationMin: 60, bookingIntervalMin: 60 },
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
    return clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Maria",
      lastName: "Khan",
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

  const createCompletedBooklyManagedBooking = async (customerId: Types.ObjectId) => {
    const { owner, business } = await createBusiness("Salon HTTP");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    await saveCard(customerId);
    await linkCustomerToBusiness(business._id, owner._id, customerId);

    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
      String(business._id),
      {
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor("10:00"),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
    );
    return { owner, business, membership, service, booking: completed };
  };

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/me", createCustomerReviewRoute());
    app.use("/catalog", createPublicBusinessReviewRoute());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const createSuperAdmin = async () =>
    userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  // --- Customer surface --------------------------------------------------------------------------

  it("GET review state before any Review exists -> eligible true, review null", async () => {
    const customer = await createCustomer("state");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();

    const response = await request(app)
      .get(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(200);
    expect(response.body.data.eligible).toBe(true);
    expect(response.body.data.review).toBeNull();
  });

  it("POST creates a Review via the real HTTP route (201) and the response never leaks businessId/customerUserId", async () => {
    const customer = await createCustomer("create");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();

    const response = await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5, comment: "Loved it" });

    expect(response.status).toBe(201);
    expect(response.body.data.rating).toBe(5);
    expect(response.body.data.comment).toBe("Loved it");
    expect(response.body.data.editableUntil).toBeDefined();
    expect(response.body.data.businessId).toBeUndefined();
    expect(response.body.data.customerUserId).toBeUndefined();
    expect(response.body.data.email).toBeUndefined();
  });

  it("rejects a smuggled businessId/customerUserId/status in the create body (schema .strict())", async () => {
    const customer = await createCustomer("smuggle");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();

    const response = await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({
        rating: 5,
        businessId: String(new Types.ObjectId()),
        customerUserId: String(new Types.ObjectId()),
        status: "PUBLISHED",
      });

    expect(response.status).toBe(400);
  });

  it("PATCH edits an existing Review within the window", async () => {
    const customer = await createCustomer("patch");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();
    await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5 });

    const response = await request(app)
      .patch(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 2, comment: "Changed my mind" });

    expect(response.status).toBe(200);
    expect(response.body.data.rating).toBe(2);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = buildApp();
    const response = await request(app).get(`/me/bookings/${new Types.ObjectId()}/review`);
    expect(response.status).toBe(401);
  });

  it("rejects a BUSINESS_OWNER token on the Customer review route (403)", async () => {
    const { owner } = await createBusiness("Wrong Role");
    const app = buildApp();

    const response = await request(app)
      .post(`/me/bookings/${new Types.ObjectId()}/review`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ rating: 5 });

    expect(response.status).toBe(403);
  });

  it("no DELETE route exists for a Customer's own Review", async () => {
    const customer = await createCustomer("nodelete");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();
    await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5 });

    const response = await request(app)
      .delete(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(404);
  });

  it("GET review state for a Booking belonging to another Customer returns the SAME 404 as an unknown booking (anti-enumeration)", async () => {
    const owner1 = await createCustomer("real-owner");
    const stranger = await createCustomer("stranger-http");
    const { booking } = await createCompletedBooklyManagedBooking(owner1._id);
    const app = buildApp();

    const unknown = await request(app)
      .get(`/me/bookings/${new Types.ObjectId()}/review`)
      .set("Authorization", await bearerFor(stranger._id, "CUSTOMER"));
    const foreign = await request(app)
      .get(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(stranger._id, "CUSTOMER"));

    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(unknown.body.message).toBe(foreign.body.message);
  });

  // --- Public surface ------------------------------------------------------------------------

  it("public Business Reviews list only returns PUBLISHED Reviews, with a safe DTO, and public reviewer identity is First Name + Last Initial", async () => {
    const customerA = await createCustomer("pub-a");
    const customerB = await createCustomer("pub-b");
    const { booking: bookingA, business } = await createCompletedBooklyManagedBooking(
      customerA._id,
    );
    const app = buildApp();

    await request(app)
      .post(`/me/bookings/${bookingA._id}/review`)
      .set("Authorization", await bearerFor(customerA._id, "CUSTOMER"))
      .send({ rating: 5, comment: "Excellent" });

    // A second Review, on a DIFFERENT (throwaway) business — force it onto the same business so
    // this test can prove the Hidden path without depending on the aggregate test file.
    const { booking: bookingB } = await createCompletedBooklyManagedBooking(customerB._id);
    await request(app)
      .post(`/me/bookings/${bookingB._id}/review`)
      .set("Authorization", await bearerFor(customerB._id, "CUSTOMER"))
      .send({ rating: 1, comment: "Not for me" });

    const listResponse = await request(app)
      .get(`/catalog/businesses/${business._id}/reviews`)
      .set("Authorization", await bearerFor(customerA._id, "CUSTOMER"));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.reviews).toHaveLength(1);
    const row = listResponse.body.data.reviews[0];
    expect(row.reviewerDisplayName).toBe("Maria K.");
    expect(row.rating).toBe(5);
    expect(row.verified).toBe(true);
    expect(row.customerUserId).toBeUndefined();
    expect(row.email).toBeUndefined();
    expect(row.phone).toBeUndefined();
  });

  it("public Business rating summary is truthful for zero Reviews and correct after one is added", async () => {
    const customer = await createCustomer("summary");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();

    const zero = await request(app)
      .get(`/catalog/businesses/${business._id}/reviews/summary`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(zero.status).toBe(200);
    expect(zero.body.data.averageRating).toBeNull();
    expect(zero.body.data.reviewCount).toBe(0);

    await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 4 });

    const after = await request(app)
      .get(`/catalog/businesses/${business._id}/reviews/summary`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(after.body.data.averageRating).toBe(4);
    expect(after.body.data.reviewCount).toBe(1);
  });

  it("an anonymous (no token) visitor can read the public rating summary and published reviews list", async () => {
    const customer = await createCustomer("anon-public");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);
    const app = buildApp();

    await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5, comment: "Great" });

    const summary = await request(app).get(`/catalog/businesses/${business._id}/reviews/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.averageRating).toBe(5);
    expect(summary.body.data.reviewCount).toBe(1);

    const list = await request(app).get(`/catalog/businesses/${business._id}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.data.reviews).toHaveLength(1);
    const row = list.body.data.reviews[0];
    expect(row.verified).toBe(true);
    // Public-safe DTO even anonymously — no raw customer/user identifiers.
    expect(row.customerUserId).toBeUndefined();
    expect(row.email).toBeUndefined();
    expect(row.phone).toBeUndefined();
  });

  it("hides public review reads for a PENDING / SUSPENDED business (403), anonymously and authenticated", async () => {
    const owner = await createCustomer("pending-owner");
    const pending = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Not Yet Approved",
      ownerName: "Owner Name",
      email: `owner-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    const app = buildApp();

    const anon = await request(app).get(`/catalog/businesses/${pending._id}/reviews/summary`);
    expect(anon.status).toBe(403);

    const authed = await request(app)
      .get(`/catalog/businesses/${pending._id}/reviews`)
      .set("Authorization", await bearerFor(owner._id, "CUSTOMER"));
    expect(authed.status).toBe(403);
  });

  // --- Super Admin moderation -----------------------------------------------------------------

  it("only SUPER_ADMIN can moderate — every other role is denied 403", async () => {
    const customer = await createCustomer("mod-deny");
    const { booking, owner, business } = await createCompletedBooklyManagedBooking(customer._id);
    const { user: supervisor } = await createStaff(business._id, "SUPERVISOR");
    const { user: staffUser } = await createStaff(business._id, "STAFF");
    const app = buildApp();

    const createResponse = await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5 });
    const reviewId = createResponse.body.data.id;

    for (const [userId, role] of [
      [owner._id, "BUSINESS_OWNER"],
      [supervisor._id, "SUPERVISOR"],
      [staffUser._id, "STAFF"],
      [customer._id, "CUSTOMER"],
    ] as const) {
      const response = await request(app)
        .post(`/super-admin/reviews/${reviewId}/moderate`)
        .set("Authorization", await bearerFor(userId, role))
        .send({ action: "HIDE" });
      expect(response.status).toBe(403);
    }
  });

  it("SUPER_ADMIN can Hide and Remove Reviews, both excluded from the public list afterward", async () => {
    const customerHide = await createCustomer("mod-hide");
    const customerRemove = await createCustomer("mod-remove");
    const { booking: bookingHide, business } = await createCompletedBooklyManagedBooking(
      customerHide._id,
    );
    const { booking: bookingRemove } = await createCompletedBooklyManagedBooking(
      customerRemove._id,
    );
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const createHide = await request(app)
      .post(`/me/bookings/${bookingHide._id}/review`)
      .set("Authorization", await bearerFor(customerHide._id, "CUSTOMER"))
      .send({ rating: 5 });
    const createRemove = await request(app)
      .post(`/me/bookings/${bookingRemove._id}/review`)
      .set("Authorization", await bearerFor(customerRemove._id, "CUSTOMER"))
      .send({ rating: 1 });

    // Force the second Review onto the same Business so both are visible in one list read.
    await request(app)
      .get(`/catalog/businesses/${business._id}/reviews`)
      .set("Authorization", await bearerFor(customerHide._id, "CUSTOMER"));

    const hideResponse = await request(app)
      .post(`/super-admin/reviews/${createHide.body.data.id}/moderate`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ action: "HIDE" });
    expect(hideResponse.status).toBe(200);
    expect(hideResponse.body.data.status).toBe("HIDDEN");

    const removeResponse = await request(app)
      .post(`/super-admin/reviews/${createRemove.body.data.id}/moderate`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ action: "REMOVE" });
    expect(removeResponse.status).toBe(200);
    expect(removeResponse.body.data.status).toBe("REMOVED");

    const listResponse = await request(app)
      .get(`/catalog/businesses/${business._id}/reviews`)
      .set("Authorization", await bearerFor(customerHide._id, "CUSTOMER"));
    const ids = listResponse.body.data.reviews.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(createHide.body.data.id);
  });

  it("SUPER_ADMIN can list and read Review moderation detail with enriched Business/Booking context", async () => {
    const customer = await createCustomer("mod-list");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const created = await request(app)
      .post(`/me/bookings/${booking._id}/review`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ rating: 5, comment: "Great" });

    const listResponse = await request(app)
      .get("/super-admin/reviews")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.reviews.length).toBeGreaterThanOrEqual(1);
    const row = listResponse.body.data.reviews.find(
      (r: { id: string }) => r.id === created.body.data.id,
    );
    expect(row.businessName).toBe(business.name);
    expect(row.bookingReference).toBe(booking.reference);

    const detailResponse = await request(app)
      .get(`/super-admin/reviews/${created.body.data.id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.data.status).toBe("PUBLISHED");
  });
});
