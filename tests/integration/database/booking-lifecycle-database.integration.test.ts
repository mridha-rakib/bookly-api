import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../../src/common/middleware/validate-request.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingController } from "../../../src/modules/booking/booking.controller.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import {
  bookingIdOnlyParamsSchema,
  bookingIdParamsSchema,
  rescheduleAvailabilityQuerySchema,
  rescheduleBookingBodySchema,
} from "../../../src/modules/booking/booking.schema.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import { BookingRescheduleAvailabilityService } from "../../../src/modules/booking/booking-reschedule-availability.service.js";
import {
  acquireSchedulingAdmission,
  validateSchedulingLine,
} from "../../../src/modules/booking/booking-scheduling-admission.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingRescheduledCustomerNotifier } from "../../../src/modules/notification/booking-rescheduled-customer.notifier.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { CyprusTaxService } from "../../../src/modules/payment/tax.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { FakeTaxGateway } from "../../helpers/fake-tax-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/**
 * Records every Google Calendar reschedule PATCH the lifecycle service issues. `throwOnUpdate`
 * proves the booking-side wrapper's try/catch keeps a misbehaving integration from affecting the
 * committed reschedule (stronger than the real IntegrationService, which swallows internally).
 */
class FakeIntegrationService {
  public patchCalls: Array<{
    eventId: string;
    startIso: string;
    endIso: string;
    timezone: string;
  }> = [];
  public deleteCalls: string[] = [];
  public appliedStartIso: string | null = null;
  public throwOnUpdate = false;
  public createCalled = false;

  public async updateEventScheduleForBooking(
    _businessId: unknown,
    eventId: string,
    schedule: { startAt: Date; endAt: Date; timezone: string },
  ): Promise<void> {
    this.patchCalls.push({
      eventId,
      startIso: schedule.startAt.toISOString(),
      endIso: schedule.endAt.toISOString(),
      timezone: schedule.timezone,
    });
    if (this.throwOnUpdate) {
      throw new Error("fake google update failure");
    }
    this.appliedStartIso = schedule.startAt.toISOString();
  }

  public async deleteEventForBooking(_businessId: unknown, eventId: string): Promise<void> {
    this.deleteCalls.push(eventId);
    this.appliedStartIso = null;
  }
}

describe("database-backed Booking creation + lifecycle integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let reservationRepository: BookingSlotReservationRepository;
  let reservationService: BookingSlotReservationService;
  let availabilityService: AvailabilityService;
  let bookingService: BookingService;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
  let fakeIntegration: FakeIntegrationService;
  let taxGateway: FakeTaxGateway;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    fakeIntegration = new FakeIntegrationService();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    reservationRepository = new BookingSlotReservationRepository();
    reservationService = new BookingSlotReservationService(reservationRepository);
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
    paymentGateway = new FakePaymentGateway();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
    );
    taxGateway = new FakeTaxGateway();
    financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const promoApplicationService = new PromoApplicationService(
      new PromoRepository(),
      new PromoUserUsageRepository(),
      new PromoRedemptionRepository(),
    );

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
      cancellationPolicyRepository,
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new CyprusTaxService(taxGateway),
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
      fakeIntegration, // integrationService (fake — records reschedule PATCHes)
      undefined, // bookingCompletedNotifier
      undefined, // bookingCancelledNotifier
      undefined, // noShowNotifier
      undefined, // staffBookingNotifier
      undefined, // appointmentReminderScheduler
      new BookingRescheduledCustomerNotifier(new EmailOutboxService(new EmailOutboxRepository())),
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ------------------------------------------------------------------------------

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
    await businessRepository.casUpdateStatus(business._id, ["PENDING"], "APPROVED", {
      fromStatus: "PENDING",
      actorUserId: business.ownerUserId,
      changedAt: new Date(),
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
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
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
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    });

  const createGroupService = async (
    businessId: Types.ObjectId,
    staffId: Types.ObjectId,
    maxPersons: number,
  ) =>
    serviceRepository.create({
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
        maxPersons,
        durationMin: 60,
        bookingIntervalMin: 60,
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    });

  const createClientFor = async (businessId: Types.ObjectId, ownerId: Types.ObjectId, tag = "a") =>
    clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Jane",
      lastName: "Doe",
      normalizedEmail: `client-${tag}-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: `991${tag}22334`, e164: `+357991${tag}22334` },
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

  const setupBookableBusiness = async () => {
    const { owner, business } = await createBusiness(
      `owner-${new Types.ObjectId().toString()}@example.com`,
      "Salon A",
    );
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id);
    return { owner, business, membership, service, client };
  };

  // --- Manual creation: happy path + snapshot correctness ------------------------------------

  it("creates a real, persisted MANUAL Booking with a correct financial snapshot and a real occupancy reservation", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();

    const booking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
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
        businessClientId: String(client._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );

    expect(booking.status).toBe("UPCOMING");
    expect(booking.source).toBe("MANUAL");
    expect(booking.financials.platformFeeCents).toBe(0);
    expect(booking.financials.depositCents).toBe(0);
    expect(booking.financials.servicesSubtotalCents).toBe(2000);
    expect(booking.financials.totalCents).toBe(2000);
    expect(booking.serviceLines[0]!.reservationId).toBeDefined();
    expect(booking.eventHistory).toHaveLength(1);
    expect(booking.eventHistory[0]!.type).toBe("CREATED");

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
      staffMembershipId: membership._id,
      occupancyDate: DATE,
    }).exec();
    expect(reservationDoc?.intervals).toHaveLength(1);
    expect(
      reservationDoc?.intervals[0]?.reservationId.equals(booking.serviceLines[0]!.reservationId),
    ).toBe(true);
  });

  it("rejects creation for a cross-business Client reference (anti-enumeration, matches 404 convention)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
    const { business: otherBusiness } = await createBusiness(
      `owner-b-${new Types.ObjectId().toString()}@example.com`,
      "Salon B",
    );
    const foreignClient = await createClientFor(otherBusiness._id, owner._id, "x");

    await expect(
      creationService.createManualBooking(
        String(owner._id),
        "BUSINESS_OWNER",
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
          businessClientId: String(foreignClient._id),
          idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("previewCustomerBooking computes a full, correct first-booking snapshot but persists nothing", async () => {
    const { business, membership, service } = await setupBookableBusiness();
    const customer = await userRepository.create({
      normalizedEmail: `preview-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    const preview = await creationService.previewCustomerBooking(
      String(customer._id),
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
        startAt: startAtFor("11:00"),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );

    expect(preview.finalizable).toBe(true);
    expect(preview.isFirstBooking).toBe(true);
    expect(preview.financials.servicesSubtotalCents).toBe(2000);
    expect(preview.financials.platformFeeCents).toBeGreaterThan(0);
    expect(preview.preTaxChargeCents).toBe(preview.financials.depositCents);
    expect(preview.taxCents).toBe(Math.round(preview.preTaxChargeCents * 0.19));
    expect(preview.dueNowCents).toBe(preview.preTaxChargeCents + preview.taxCents);
    expect(preview.balanceDueCents).toBe(preview.financials.balanceDueCents);
    expect(preview.requiresSavedCard).toBe(true);
    expect(preview.hasSavedCard).toBe(false);

    const count = await BookingModel.countDocuments({}).exec();
    expect(count).toBe(0);
    const reservationCount = await BookingSlotReservationModel.countDocuments({}).exec();
    expect(reservationCount).toBe(0);
  });

  // --- Idempotency -----------------------------------------------------------------------------

  it("returns the SAME Booking for a retried request with the same idempotencyKey — never a duplicate", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const idempotencyKey = `key-${new Types.ObjectId().toString()}`;
    const input = {
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
      idempotencyKey,
    };

    const first = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      input,
    );
    const second = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      input,
    );

    expect(String(second._id)).toBe(String(first._id));
    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(1);
  });

  // --- Concurrency (mandatory races) ------------------------------------------------------------

  it("[race] parallel booking-create for the exact same slot: exactly one succeeds", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const startAt = startAtFor("10:00");

    const attempts = Array.from({ length: 5 }, () =>
      creationService.createManualBooking(
        String(owner._id),
        "BUSINESS_OWNER",
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
          startAt,
          businessClientId: String(client._id),
          idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        },
      ),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(1);
  });

  it("[race] group-capacity ceiling is never exceeded under concurrent creation", async () => {
    const { owner, business, membership, client } = await setupBookableBusiness();
    const groupService = await createGroupService(business._id, membership._id, 5);
    const startAt = startAtFor("10:00");

    // 4 concurrent bookings x 2 people each = 8 requested against a ceiling of 5.
    const attempts = Array.from({ length: 4 }, () =>
      creationService.createManualBooking(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        {
          serviceLines: [
            {
              serviceId: String(groupService._id),
              staffMembershipId: String(membership._id),
              addonIds: [],
              pricingInput: { personCount: 2 },
            },
          ],
          startAt,
          businessClientId: String(client._id),
          idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        },
      ),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(fulfilled.length).toBeLessThan(4);

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
      staffMembershipId: membership._id,
      occupancyDate: DATE,
    }).exec();
    const interval = reservationDoc?.intervals[0];
    expect(interval?.capacityUsed).toBeLessThanOrEqual(5);
    expect(interval?.capacityUsed).toBe(fulfilled.length * 2);
  });

  // --- State machine -----------------------------------------------------------------------------

  const createUpcomingBooking = async (time = "10:00") => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const booking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
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
        startAt: startAtFor(time),
        businessClientId: String(client._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    return { owner, business, membership, service, client, booking };
  };

  it("completes an UPCOMING booking and preserves the reservation as immutable history", async () => {
    const { owner, business, booking } = await createUpcomingBooking();

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
    );
    expect(completed.status).toBe("COMPLETED");

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
    }).exec();
    expect(reservationDoc?.intervals).toHaveLength(1);
  });

  it("rejects illegal transitions: COMPLETED cannot be cancelled, CANCELLED cannot be completed", async () => {
    const { owner, business, booking } = await createUpcomingBooking();
    await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
    );

    await expect(
      lifecycleService.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const { owner: owner2, business: business2, booking: booking2 } = await createUpcomingBooking();
    await lifecycleService.cancelByBusiness(
      String(owner2._id),
      "BUSINESS_OWNER",
      String(business2._id),
      String(booking2._id),
      undefined,
    );

    await expect(
      lifecycleService.completeBooking(
        String(owner2._id),
        "BUSINESS_OWNER",
        String(business2._id),
        String(booking2._id),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("customer cancellation classifies FREE (>72h) vs LATE_CANCELLATION and releases the reservation", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();

    // Link the client BEFORE creating the Booking, so customer.customerUserId is populated on
    // the snapshot from the start (buildCustomerSnapshot reads client.linkState at create time).
    const customer = await userRepository.create({
      normalizedEmail: `cust2-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await clientRepository.setLinkState(client._id, {
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    const linkedClient = await clientRepository.findById(business._id, client._id);

    const linkedBooking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
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
        startAt: startAtFor("14:00"),
        businessClientId: String(linkedClient!._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    expect(linkedBooking.customer.customerUserId?.equals(customer._id)).toBe(true);

    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(linkedBooking._id),
      undefined,
    );
    expect(cancelled.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(cancelled.cancellationOutcome?.feeMode).toBe("FREE");
    expect(cancelled.cancellationOutcome?.cancellationFeeCents).toBe(0);

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
    }).exec();
    const remainingIntervals = reservationDoc?.intervals.filter((entry) =>
      entry.reservationId.equals(linkedBooking.serviceLines[0]!.reservationId),
    );
    expect(remainingIntervals).toHaveLength(0);
  });

  it("[race] repeated cancel is idempotent — exactly one succeeds, capacityUsed never goes negative", async () => {
    const { business, booking, client } = await createUpcomingBooking();
    const customer = await userRepository.create({
      normalizedEmail: `cust3-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const relinked = await clientRepository.setLinkState(client._id, {
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    expect(relinked).toBeDefined();

    // Re-fetch as a customer-owned booking by directly patching customerUserId at the DB level
    // (this Booking's own customer snapshot predates the link — see the prior test for the
    // create-after-link variant; this test only needs a customer-owned Booking to exist).
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "customer.customerUserId": customer._id } },
    ).exec();

    const results = await Promise.allSettled([
      lifecycleService.cancelByCustomer(String(customer._id), String(booking._id), undefined),
      lifecycleService.cancelByCustomer(String(customer._id), String(booking._id), undefined),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
    }).exec();
    for (const interval of reservationDoc?.intervals ?? []) {
      expect(interval.capacityUsed).toBeGreaterThanOrEqual(0);
    }
  });

  it("[race] cancel-vs-reschedule on the same booking: exactly one wins", async () => {
    const { owner, business, booking } = await createUpcomingBooking();

    const results = await Promise.allSettled([
      lifecycleService.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        undefined,
      ),
      lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("[race] complete-vs-cancel on the same booking: exactly one wins", async () => {
    const { owner, business, booking } = await createUpcomingBooking();

    const results = await Promise.allSettled([
      lifecycleService.completeBooking(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
      ),
      lifecycleService.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        undefined,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  // --- Reschedule --------------------------------------------------------------------------------

  describe("F1C-A booking-owned availability", () => {
    const reader = () =>
      new BookingRescheduleAvailabilityService(bookingService, availabilityService);
    const read = (f: Awaited<ReturnType<typeof createUpcomingBooking>>) =>
      reader().forBusiness(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        DATE,
        DATE,
      );
    const newBooking = async (hours = 4) => {
      const f = await setupBookableBusiness();
      await ServiceModel.updateOne(
        { _id: f.service._id },
        {
          $set: {
            pricingMode: "HOURLY",
            hourlyPricing: { ratePerHourCents: 1000, minHours: 2, maxHours: 4, bufferAfterMin: 15 },
          },
          $unset: { fixedPricing: "" },
        },
      );
      const booking = await creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        {
          businessClientId: String(f.client._id),
          idempotencyKey: new Types.ObjectId().toString(),
          startAt: businessLocalToUtc(TIMEZONE, "2030-08-19", "09:00").toISOString(),
          serviceLines: [
            {
              serviceId: String(f.service._id),
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: { hours },
            },
          ],
        },
      );
      return { ...f, booking };
    };
    const appAndToken = () => {
      const tokens = new TokenService(new SessionRepository());
      const controller = new BookingController(
        bookingService,
        creationService,
        lifecycleService,
        reader(),
      );
      const authenticate = createAuthenticateAccessTokenMiddleware(tokens, userRepository);
      const app = express();
      app.use(express.json());
      app.get(
        "/me/bookings/:bookingId/reschedule-availability",
        authenticate,
        requireActiveUser(),
        requireRoles(["CUSTOMER"]),
        validateRequest({
          params: bookingIdOnlyParamsSchema,
          query: rescheduleAvailabilityQuerySchema,
        }),
        asyncHandler(controller.getRescheduleAvailabilityForCustomer),
      );
      app.get(
        "/businesses/:businessId/bookings/:bookingId/reschedule-availability",
        authenticate,
        requireActiveUser(),
        requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
        validateRequest({
          params: bookingIdParamsSchema,
          query: rescheduleAvailabilityQuerySchema,
        }),
        asyncHandler(controller.getRescheduleAvailabilityForBusiness),
      );
      app.post(
        "/me/bookings/:bookingId/reschedule",
        authenticate,
        requireActiveUser(),
        requireRoles(["CUSTOMER"]),
        validateRequest({ params: bookingIdOnlyParamsSchema, body: rescheduleBookingBodySchema }),
        asyncHandler(controller.rescheduleByCustomer),
      );
      app.use(createErrorHandler({ isProduction: true }));
      return {
        app,
        token: async (
          userId: Types.ObjectId,
          role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
        ) => `Bearer ${await issueTestAccessToken(tokens, { userId, role })}`,
      };
    };
    it.each([2, 2.5, 4])(
      "retains original %s hours plus buffer after live timing/bounds drift and final reschedule",
      async (hours) => {
        const f = await newBooking(hours);
        await ServiceModel.updateOne(
          { _id: f.service._id },
          { $set: { "hourlyPricing.bufferAfterMin": 0, "hourlyPricing.maxHours": 3 } },
        );
        const result = await read(f);
        expect(result.bookingId).toBe(String(f.booking._id));
        expect(result.days[0]!.slots.length).toBeGreaterThan(0);
        for (const slot of result.days[0]!.slots)
          expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(
            (hours * 60 + 15) * 60_000,
          );
        const moved = await lifecycleService.rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          result.days[0]!.slots[0]!.startAt,
        );
        expect(moved.schedule.endAt.getTime() - moved.schedule.startAt.getTime()).toBe(
          (hours * 60 + 15) * 60_000,
        );
        expect(moved.serviceLines[0]!.pricingInput.hours).toBe(hours);
        expect(moved.financials).toEqual(f.booking.financials);
        expect(moved.customerRescheduleCount).toBe(0);
      },
    );
    it("protects actual Customer and management HTTP reads and leaves the final POST payload unchanged", async () => {
      const f = await newBooking();
      const customer = await userRepository.create({
        normalizedEmail: "f1ca-customer@example.com",
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      const stranger = await userRepository.create({
        normalizedEmail: "f1ca-stranger@example.com",
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      await BookingModel.updateOne(
        { _id: f.booking._id },
        { $set: { "customer.customerUserId": customer._id } },
      );
      const { user: supervisor } = await createStaff(f.business._id, "SUPERVISOR");
      const other = await createBusiness("f1ca-other@example.com", "Other");
      const { user: foreignSupervisor } = await createStaff(other.business._id, "SUPERVISOR");
      const { app, token } = appAndToken();
      const customerUrl = `/me/bookings/${f.booking._id}/reschedule-availability`;
      const managerUrl = `/businesses/${f.business._id}/bookings/${f.booking._id}/reschedule-availability`;
      const query = { fromDate: DATE, toDate: DATE };
      const own = await request(app)
        .get(customerUrl)
        .query(query)
        .set("Authorization", await token(customer._id, "CUSTOMER"));
      expect(own.status).toBe(200);
      expect(
        (
          await request(app)
            .get(customerUrl)
            .query(query)
            .set("Authorization", await token(stranger._id, "CUSTOMER"))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .get(managerUrl)
            .query(query)
            .set("Authorization", await token(other.owner._id, "BUSINESS_OWNER"))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .get(managerUrl)
            .query(query)
            .set("Authorization", await token(foreignSupervisor._id, "SUPERVISOR"))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .get(managerUrl)
            .query(query)
            .set("Authorization", await token(f.owner._id, "BUSINESS_OWNER"))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .get(managerUrl)
            .query(query)
            .set("Authorization", await token(supervisor._id, "SUPERVISOR"))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .get(managerUrl)
            .query(query)
            .set("Authorization", await token(f.membership.userId, "STAFF"))
        ).status,
      ).toBe(403);
      for (const injection of [
        { hours: 2 },
        { partySize: 1 },
        { reservationId: String(f.booking.serviceLines[0]!.reservationId) },
        { staffMembershipId: String(f.membership._id) },
      ]) {
        expect(
          (
            await request(app)
              .get(customerUrl)
              .query({ ...query, ...injection })
              .set("Authorization", await token(customer._id, "CUSTOMER"))
          ).status,
        ).toBe(400);
      }
      for (const invalid of [
        { fromDate: DATE, toDate: "2030-08-01" },
        { fromDate: "bad", toDate: DATE },
        { fromDate: DATE, toDate: "2031-08-20" },
      ]) {
        expect(
          (
            await request(app)
              .get(customerUrl)
              .query(invalid)
              .set("Authorization", await token(customer._id, "CUSTOMER"))
          ).status,
        ).toBe(400);
      }
      const saved = await request(app)
        .post(`/me/bookings/${f.booking._id}/reschedule`)
        .send({ startAt: own.body.data.days[0].slots[0].startAt })
        .set("Authorization", await token(customer._id, "CUSTOMER"));
      expect(saved.status).toBe(200);
      expect(saved.body.data.serviceLines[0].hours).toBe(4);
      expect(saved.body.data.customerRescheduleCount).toBe(1);
    });
    it("rejects missing/contradictory original proof and missing quantities without fallback", async () => {
      const f = await newBooking();
      await BookingSlotReservationClaimModel.collection.updateOne(
        { idempotencyKey: f.booking.serviceLines[0]!.reservationOperationKey },
        { $set: { "originalIntent.endAt": new Date(startAtFor("10:00")) } },
      );
      await expect(read(f)).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
      ).toEqual(f.booking.schedule.startAt);
      const other = await newBooking(2.5);
      await BookingModel.collection.updateOne(
        { _id: other.booking._id },
        { $unset: { "serviceLines.0.pricingInput.hours": "" } },
      );
      await expect(read(other)).rejects.toMatchObject({ statusCode: 409 });
    });
    it("excludes full-window breaks, stale staff assignment and occupied targets while retaining old reservations", async () => {
      const f = await newBooking();
      await staffScheduleRepository.replace(f.membership._id, f.business._id, [
        {
          dayOfWeek: "TUESDAY",
          intervals: [
            { startTime: "09:00", endTime: "12:00" },
            { startTime: "13:00", endTime: "17:00" },
          ],
        },
      ]);
      expect((await read(f)).days[0]!.slots).toEqual([]);
      await staffWorksMondayToFriday(f.membership._id, f.business._id);
      await reservationService.reserveOrJoin({
        businessId: f.business._id,
        staffMembershipId: f.membership._id,
        serviceId: f.service._id,
        timezone: TIMEZONE,
        startAt: new Date(startAtFor("12:00")),
        endAt: new Date(startAtFor("14:00")),
        capacityMax: 1,
        partySize: 1,
        idempotencyKey: new Types.ObjectId().toString(),
      });
      expect((await read(f)).days[0]!.slots).toEqual([]);
      await ServiceModel.updateOne(
        { _id: f.service._id },
        { $set: { assignedStaffMembershipIds: [] } },
      );
      expect((await read(f)).days[0]!.slots).toEqual([]);
    });
    it("ordinary group reads retain the complete party and exact-group same-slot remains a real lifecycle operation", async () => {
      const f = await setupBookableBusiness();
      const service = await createGroupService(f.business._id, f.membership._id, 6);
      const booking = await creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        {
          businessClientId: String(f.client._id),
          idempotencyKey: new Types.ObjectId().toString(),
          startAt: startAtFor("10:00"),
          serviceLines: [
            {
              serviceId: String(service._id),
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: { personCount: 4 },
            },
          ],
        },
      );
      const context = { ...f, service, booking };
      expect(
        (await read(context)).days[0]!.slots.some((s) => s.startAt === startAtFor("10:00")),
      ).toBe(false); // only 2 spare, original party=4
      await reservationService.reserveOrJoin({
        businessId: f.business._id,
        staffMembershipId: f.membership._id,
        serviceId: service._id,
        timezone: TIMEZONE,
        startAt: new Date(startAtFor("15:00")),
        endAt: new Date(startAtFor("16:00")),
        capacityMax: 6,
        partySize: 3,
        idempotencyKey: new Types.ObjectId().toString(),
      });
      expect(
        (await read(context)).days[0]!.slots.some((s) => s.startAt === startAtFor("15:00")),
      ).toBe(false);
      // A party of two has enough spare capacity for the existing join-before-release rule.
      const small = await creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        {
          businessClientId: String(f.client._id),
          idempotencyKey: new Types.ObjectId().toString(),
          startAt: startAtFor("12:00"),
          serviceLines: [
            {
              serviceId: String(service._id),
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: { personCount: 2 },
            },
          ],
        },
      );
      expect(
        (await read({ ...context, booking: small })).days[0]!.slots.some(
          (s) => s.startAt === startAtFor("12:00"),
        ),
      ).toBe(true);
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(small._id),
        startAtFor("12:00"),
      );
      expect(moved.rescheduleHistory).toHaveLength(1);
      expect(moved.serviceLines[0]!.pricingInput.personCount).toBe(2);
    });
    it("fixed historical occupancy and suspended-business lifecycle eligibility remain compatible", async () => {
      const f = await createUpcomingBooking();
      await ServiceModel.updateOne(
        { _id: f.service._id },
        { $set: { "fixedPricing.durationMin": 120, "fixedPricing.bufferAfterMin": 60 } },
      );
      await BusinessModel.collection.updateOne(
        { _id: f.business._id },
        { $set: { status: "SUSPENDED" } },
      );
      const result = await read(f);
      expect(result.days[0]!.slots.length).toBeGreaterThan(0);
      expect(
        result.days[0]!.slots.every(
          (s) => Date.parse(s.endAt) - Date.parse(s.startAt) === 60 * 60_000,
        ),
      ).toBe(true);
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        result.days[0]!.slots[0]!.startAt,
      );
      expect(moved.financials).toEqual(f.booking.financials);
    });
    it("all-line availability preserves distinct ends and excludes secondary-line failures", async () => {
      const f = await setupBookableBusiness();
      const other = await createStaff(f.business._id);
      await staffWorksMondayToFriday(other.membership._id, f.business._id);
      const service = await createFixedService(f.business._id, other.membership._id);
      await ServiceModel.updateOne(
        { _id: service._id },
        { $set: { "fixedPricing.durationMin": 240, "fixedPricing.bufferAfterMin": 15 } },
      );
      const booking = await creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        {
          businessClientId: String(f.client._id),
          idempotencyKey: new Types.ObjectId().toString(),
          startAt: businessLocalToUtc(TIMEZONE, "2030-08-19", "09:00").toISOString(),
          serviceLines: [f.service, service].map((s, index) => ({
            serviceId: String(s._id),
            staffMembershipId: String(index === 0 ? f.membership._id : other.membership._id),
            addonIds: [],
            pricingInput: {},
          })),
        },
      );
      const context = { ...f, booking };
      const before = await read(context);
      expect(before.days[0]!.slots.length).toBeGreaterThan(0);
      expect(
        before.days[0]!.slots.every(
          (slot) => Date.parse(slot.endAt) - Date.parse(slot.startAt) === 255 * 60_000,
        ),
      ).toBe(true);
      await staffScheduleRepository.replace(other.membership._id, f.business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "12:00" }] },
      ]);
      expect((await read(context)).days[0]!.slots).toEqual([]);
      await staffWorksMondayToFriday(other.membership._id, f.business._id);
      const offered = (await read(context)).days[0]!.slots[0]!;
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(booking._id),
        offered.startAt,
      );
      expect(moved.schedule.endAt.toISOString()).toBe(offered.endAt);
      expect(moved.serviceLines.map((line) => line.serviceSnapshot.durationMin)).toEqual([60, 255]);
      expect(moved.financials).toEqual(booking.financials);
    });
    it("read snapshots do not mutate the business fence, operations, booking or financials; failed moves roll back", async () => {
      const f = await newBooking();
      const businessBefore = await businessRepository.findById(f.business._id);
      const claimsBefore = await BookingSlotReservationClaimModel.countDocuments();
      const first = await read(f);
      expect(await read(f)).toEqual(first);
      expect((await businessRepository.findById(f.business._id))?.packageEligibilityVersion).toBe(
        businessBefore?.packageEligibilityVersion,
      );
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(claimsBefore);
      const failure = vi
        .spyOn(reservationService, "release")
        .mockRejectedValueOnce(new Error("F1C-A injected release failure"));
      await expect(
        lifecycleService.rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          first.days[0]!.slots[0]!.startAt,
        ),
      ).rejects.toThrow("F1C-A injected release failure");
      failure.mockRestore();
      const original = await bookingRepository.findById(f.business._id, f.booking._id);
      expect(original?.schedule).toEqual(f.booking.schedule);
      expect(original?.financials).toEqual(f.booking.financials);
      expect(original?.rescheduleHistory).toHaveLength(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(claimsBefore);
      expect(await read(f)).toEqual(first);
    });
    it("a concurrent ordinary booking and reschedule cannot both occupy the offered historical interval", async () => {
      const f = await newBooking();
      const offered = (await read(f)).days[0]!.slots[0]!;
      const results = await Promise.allSettled([
        lifecycleService.rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          offered.startAt,
        ),
        creationService.createManualBooking(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          {
            businessClientId: String(f.client._id),
            idempotencyKey: new Types.ObjectId().toString(),
            startAt: offered.startAt,
            serviceLines: [
              {
                serviceId: String(f.service._id),
                staffMembershipId: String(f.membership._id),
                addonIds: [],
                pricingInput: { hours: 4 },
              },
            ],
          },
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const day = await BookingSlotReservationModel.findOne({
        businessId: f.business._id,
        staffMembershipId: f.membership._id,
        occupancyDate: DATE,
      }).orFail();
      expect(day.intervals).toHaveLength(1);
      expect(day.intervals[0]!.capacityUsed).toBe(1);
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
    });
    it("time off and missing live travel eligibility cannot advertise a final-invalid slot", async () => {
      const f = await newBooking();
      await new StaffTimeOffRepository().create({
        membershipId: f.membership._id,
        businessId: f.business._id,
        type: "ANNUAL_HOLIDAY",
        startDate: DATE,
        endDate: DATE,
        createdByUserId: f.owner._id,
      });
      expect((await read(f)).days[0]!.slots).toEqual([]);
      const other = await newBooking();
      await BusinessModel.collection.updateOne(
        { _id: other.business._id },
        { $set: { visitType: "TRAVEL_TO_CUSTOMER" } },
      );
      expect((await read(other)).days[0]!.slots).toEqual([]); // original at-business fulfilment supplies no travel city
    });
    it("first-class activation remains denied instead of entering a new read-side entitlement path", async () => {
      const f = await newBooking();
      await BookingModel.collection.updateOne(
        { _id: f.booking._id },
        { $set: { "serviceLines.0.pricingInput.packageItemId": new Types.ObjectId() } },
      );
      await expect(read(f)).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    });
    it("a current pricing-mode edit cannot replace the historical occupied interval or original quantity", async () => {
      const f = await newBooking();
      await ServiceModel.updateOne(
        { _id: f.service._id },
        {
          $set: {
            pricingMode: "FIXED",
            fixedPricing: { priceCents: 1000, durationMin: 30, bookingIntervalMin: 60 },
          },
          $unset: { hourlyPricing: "" },
        },
      );
      const result = await read(f);
      expect(result.days[0]!.slots.length).toBeGreaterThan(0);
      expect(
        result.days[0]!.slots.every(
          (slot) => Date.parse(slot.endAt) - Date.parse(slot.startAt) === 255 * 60_000,
        ),
      ).toBe(true);
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        result.days[0]!.slots[0]!.startAt,
      );
      expect(moved.serviceLines[0]!.serviceSnapshot.pricingMode).toBe("HOURLY");
      expect(moved.serviceLines[0]!.pricingInput.hours).toBe(4);
      expect(moved.financials).toEqual(f.booking.financials);
    });
  });

  it("owner reschedule moves the booking and never increments customerRescheduleCount", async () => {
    const { owner, business, booking } = await createUpcomingBooking();
    const newStartAt = startAtFor("15:00");

    const rescheduled = await lifecycleService.rescheduleByOwner(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      newStartAt,
    );

    expect(rescheduled.schedule.startAt.toISOString()).toBe(newStartAt);
    expect(rescheduled.customerRescheduleCount).toBe(0);
    expect(rescheduled.rescheduleHistory).toHaveLength(1);
    expect(rescheduled.rescheduleHistory[0]!.countedTowardCustomerQuota).toBe(false);

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
    }).exec();
    const activeIntervals = reservationDoc?.intervals ?? [];
    expect(activeIntervals).toHaveLength(1);
    expect(
      activeIntervals[0]?.reservationId.equals(rescheduled.serviceLines[0]!.reservationId),
    ).toBe(true);
  });

  it("customer reschedule increments the quota and enforces the max-2 limit", async () => {
    const { business, booking, client } = await createUpcomingBooking();
    const customer = await userRepository.create({
      normalizedEmail: `cust4-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await clientRepository.setLinkState(client._id, {
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "customer.customerUserId": customer._id } },
    ).exec();

    const r1 = await lifecycleService.rescheduleByCustomer(
      String(customer._id),
      String(booking._id),
      startAtFor("13:00"),
    );
    expect(r1.customerRescheduleCount).toBe(1);

    const r2 = await lifecycleService.rescheduleByCustomer(
      String(customer._id),
      String(booking._id),
      startAtFor("15:00"),
    );
    expect(r2.customerRescheduleCount).toBe(2);

    await expect(
      lifecycleService.rescheduleByCustomer(
        String(customer._id),
        String(booking._id),
        startAtFor("16:00"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    void business;
  });

  it("[IDOR, Batch 9 completion pass] a customer cannot read, cancel, reschedule, or list another customer's booking", async () => {
    const { business, booking, client } = await createUpcomingBooking();
    const owner1 = await userRepository.create({
      normalizedEmail: `owner-cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await clientRepository.setLinkState(client._id, {
      linkState: "LINKED",
      linkedUserId: owner1._id,
    });
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "customer.customerUserId": owner1._id } },
    ).exec();

    const intruder = await userRepository.create({
      normalizedEmail: `intruder-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    // Read: anti-enumeration 404, never a 403 that would confirm the booking exists.
    await expect(
      bookingService.getBookingDetailForCustomer(String(intruder._id), String(booking._id)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // List: the intruder's own "/me/bookings" must never surface someone else's booking.
    const intruderList = await bookingService.listBookingsForCustomer(
      String(intruder._id),
      {},
      { page: 1, limit: 50 },
    );
    expect(intruderList.bookings.some((b) => String(b._id) === String(booking._id))).toBe(false);

    // Cancel: must not be able to cancel a booking that isn't theirs.
    await expect(
      lifecycleService.cancelByCustomer(String(intruder._id), String(booking._id), undefined),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Reschedule: must not be able to move someone else's booking.
    await expect(
      lifecycleService.rescheduleByCustomer(
        String(intruder._id),
        String(booking._id),
        startAtFor("13:00"),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The booking itself is completely untouched by all four attempts.
    const refetched = await bookingRepository.findById(business._id, booking._id);
    expect(refetched?.status).toBe("UPCOMING");
    expect(refetched?.customerRescheduleCount).toBe(0);
    expect(refetched?.schedule.startAt.toISOString()).toBe(booking.schedule.startAt.toISOString());

    // The RIGHTFUL owner can still do all of the above normally — this isn't a broken lockout.
    const ownDetail = await bookingService.getBookingDetailForCustomer(
      String(owner1._id),
      String(booking._id),
    );
    expect(String(ownDetail._id)).toBe(String(booking._id));
  });

  it("[race] a failed reschedule (target slot conflict) leaves the OLD reservation completely valid", async () => {
    const { owner, business, membership, service, booking } = await createUpcomingBooking("10:00");

    // Occupy the 15:00 slot with a second booking on the SAME staff, so rescheduling booking A
    // into it must fail.
    const otherClient = await createClientFor(business._id, owner._id, "z");
    await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
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
        startAt: startAtFor("15:00"),
        businessClientId: String(otherClient._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );

    const originalStartAt = booking.schedule.startAt.toISOString();
    const originalReservationId = booking.serviceLines[0]!.reservationId;

    await expect(
      lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      ),
    ).rejects.toBeDefined();

    const refetched = await bookingRepository.findById(business._id, booking._id);
    expect(refetched?.schedule.startAt.toISOString()).toBe(originalStartAt);
    expect(refetched?.serviceLines[0]?.reservationId.equals(originalReservationId)).toBe(true);
    expect(refetched?.status).toBe("UPCOMING");

    const reservationDoc = await BookingSlotReservationModel.findOne({
      businessId: business._id,
      staffMembershipId: membership._id,
      occupancyDate: DATE,
    }).exec();
    const stillHasOriginal = reservationDoc?.intervals.some((entry) =>
      entry.reservationId.equals(originalReservationId),
    );
    expect(stillHasOriginal).toBe(true);
  });

  it("[race] a repeated identical reschedule request does not double-consume the customer quota", async () => {
    const { business, booking, client } = await createUpcomingBooking();
    const customer = await userRepository.create({
      normalizedEmail: `cust5-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await clientRepository.setLinkState(client._id, {
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "customer.customerUserId": customer._id } },
    ).exec();

    const newStartAt = startAtFor("16:00");
    const results = await Promise.allSettled([
      lifecycleService.rescheduleByCustomer(String(customer._id), String(booking._id), newStartAt),
      lifecycleService.rescheduleByCustomer(String(customer._id), String(booking._id), newStartAt),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const finalBooking = await bookingRepository.findById(business._id, booking._id);
    expect(finalBooking?.customerRescheduleCount).toBe(1);
  }, 20_000);

  // --- Reschedule → mandatory customer confirmation email ------------------------------------

  describe("customer reschedule confirmation email", () => {
    const linkCustomer = async (clientId: Types.ObjectId, bookingId: Types.ObjectId) => {
      const customer = await userRepository.create({
        normalizedEmail: `cust-resched-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      await clientRepository.setLinkState(clientId, {
        linkState: "LINKED",
        linkedUserId: customer._id,
      });
      await BookingModel.updateOne(
        { _id: bookingId },
        { $set: { "customer.customerUserId": customer._id } },
      ).exec();
      return customer;
    };

    it("owner reschedule enqueues one PENDING BOOKING_RESCHEDULED_CUSTOMER row for the booking contact", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");

      const rescheduled = await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );
      expect(rescheduled.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));

      const rows = await EmailOutboxModel.find({
        templateKey: "BOOKING_RESCHEDULED_CUSTOMER",
      }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("PENDING");
      expect(rows[0]?.eventKey).toBe(`BOOKING_RESCHEDULED:${String(booking._id)}:1`);
      expect(rows[0]?.recipient).toBe(booking.customer.contact.normalizedEmail);
      expect(rows[0]?.payload["rescheduledByBusiness"]).toBe(true);
    });

    it("customer reschedule enqueues the row; a second genuine reschedule is its own :2 row", async () => {
      const { business, booking, client } = await createUpcomingBooking("10:00");
      const customer = await linkCustomer(client._id, booking._id);

      await lifecycleService.rescheduleByCustomer(
        String(customer._id),
        String(booking._id),
        startAtFor("13:00"),
      );
      await lifecycleService.rescheduleByCustomer(
        String(customer._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      const rows = await EmailOutboxModel.find({
        templateKey: "BOOKING_RESCHEDULED_CUSTOMER",
      })
        .sort({ createdAt: 1 })
        .lean();
      expect(rows.map((r) => r.eventKey)).toEqual([
        `BOOKING_RESCHEDULED:${String(booking._id)}:1`,
        `BOOKING_RESCHEDULED:${String(booking._id)}:2`,
      ]);
      expect(rows.every((r) => r.payload["rescheduledByBusiness"] === false)).toBe(true);
      void business;
    });

    it("a failing outbox enqueue never rolls back the committed reschedule", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");

      const brokenLifecycle = new BookingLifecycleService(
        bookingService,
        bookingRepository,
        businessRepository,
        reservationService,
        availabilityService,
        serviceRepository,
        staffRepository,
        paymentService,
        financialTransactionService,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new BookingRescheduledCustomerNotifier({
          enqueue: async () => {
            throw new Error("outbox unavailable");
          },
        } as never),
      );

      const rescheduled = await brokenLifecycle.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(rescheduled.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      expect(rescheduled.rescheduleHistory).toHaveLength(1);
      const persisted = await bookingRepository.findById(business._id, booking._id);
      expect(persisted?.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    });
  });

  // --- Reschedule → Google Calendar sync ----------------------------------------------------

  describe("Google Calendar reschedule sync", () => {
    const linkEvent = async (bookingId: Types.ObjectId, eventId = "gcal-evt-1") => {
      await BookingModel.updateOne(
        { _id: bookingId },
        { $set: { googleCalendarEventId: eventId } },
      ).exec();
    };

    const linkCustomer = async (clientId: Types.ObjectId, bookingId: Types.ObjectId) => {
      const customer = await userRepository.create({
        normalizedEmail: `cust-gcal-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      await clientRepository.setLinkState(clientId, {
        linkState: "LINKED",
        linkedUserId: customer._id,
      });
      await BookingModel.updateOne(
        { _id: bookingId },
        { $set: { "customer.customerUserId": customer._id } },
      ).exec();
      return customer;
    };

    // Reach the private best-effort wrapper directly to drive the race scenarios deterministically.
    const runSync = (booking: unknown): Promise<void> =>
      (
        lifecycleService as unknown as {
          syncBookingRescheduledToGoogleCalendar: (b: unknown) => Promise<void>;
        }
      ).syncBookingRescheduledToGoogleCalendar(booking);

    it("owner reschedule PATCHes the SAME event with the new time; no create; id unchanged", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);

      const rescheduled = await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(fakeIntegration.patchCalls).toHaveLength(1);
      expect(fakeIntegration.patchCalls[0]?.eventId).toBe("gcal-evt-1");
      expect(fakeIntegration.patchCalls[0]?.startIso).toBe(startAtFor("15:00"));
      expect(fakeIntegration.patchCalls[0]?.endIso).toBe(rescheduled.schedule.endAt.toISOString());
      expect(fakeIntegration.patchCalls[0]?.timezone).toBe(TIMEZONE);
      expect(fakeIntegration.createCalled).toBe(false);

      const persisted = await bookingRepository.findById(business._id, booking._id);
      expect(persisted?.googleCalendarEventId).toBe("gcal-evt-1");
    });

    it("customer reschedule PATCHes the same event", async () => {
      const { business, booking, client } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);
      const customer = await linkCustomer(client._id, booking._id);

      await lifecycleService.rescheduleByCustomer(
        String(customer._id),
        String(booking._id),
        startAtFor("13:00"),
      );

      expect(fakeIntegration.patchCalls).toHaveLength(1);
      expect(fakeIntegration.patchCalls[0]?.eventId).toBe("gcal-evt-1");
      expect(fakeIntegration.patchCalls[0]?.startIso).toBe(startAtFor("13:00"));
    });

    it("no linked Google event → no PATCH, reschedule still succeeds", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");

      const rescheduled = await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(rescheduled.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      expect(fakeIntegration.patchCalls).toHaveLength(0);
    });

    it("a throwing integration service never rolls back the reschedule; customer email still enqueued", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);
      fakeIntegration.throwOnUpdate = true;

      const rescheduled = await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(rescheduled.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      const persisted = await bookingRepository.findById(business._id, booking._id);
      expect(persisted?.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      expect(fakeIntegration.patchCalls).toHaveLength(1); // it WAS attempted
      expect(
        await EmailOutboxModel.countDocuments({ templateKey: "BOOKING_RESCHEDULED_CUSTOMER" }),
      ).toBe(1);
    });

    it("[race] rapid double reschedule: external event converges to the newest committed time", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);

      await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("13:00"),
      );
      await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(fakeIntegration.patchCalls).toHaveLength(2);
      expect(fakeIntegration.patchCalls.at(-1)?.startIso).toBe(startAtFor("15:00"));
      expect(fakeIntegration.appliedStartIso).toBe(startAtFor("15:00"));
    });

    it("[race] the sync live-re-reads: a STALE snapshot still PATCHes the latest committed time", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);

      // Commit the real move to 15:00.
      await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );
      fakeIntegration.patchCalls = [];
      fakeIntegration.appliedStartIso = null;

      // Now drive the wrapper with a stale snapshot claiming the booking is still at 13:00
      // (as a slow first reschedule's post-commit tail would carry). The wrapper must ignore
      // the snapshot's schedule and PATCH the DB's current 15:00.
      const staleSnapshot = {
        _id: booking._id,
        businessId: business._id,
        googleCalendarEventId: "gcal-evt-1",
        status: "UPCOMING",
        schedule: {
          timezone: TIMEZONE,
          startAt: new Date(startAtFor("13:00")),
          endAt: new Date(startAtFor("13:00")),
        },
      };
      await runSync(staleSnapshot);

      expect(fakeIntegration.patchCalls).toHaveLength(1);
      expect(fakeIntegration.patchCalls[0]?.startIso).toBe(startAtFor("15:00"));
      expect(fakeIntegration.patchCalls[0]?.startIso).not.toBe(startAtFor("13:00"));
    });

    it("[race] cancel-after-reschedule: the live re-read sees non-UPCOMING and skips the PATCH", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);

      await lifecycleService.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );
      fakeIntegration.patchCalls = [];

      // Booking is cancelled out from under a still-pending reschedule sync.
      await BookingModel.updateOne(
        { _id: booking._id },
        { $set: { status: "CANCELLED_BY_BUSINESS" } },
      ).exec();

      const staleUpcomingSnapshot = {
        _id: booking._id,
        businessId: business._id,
        googleCalendarEventId: "gcal-evt-1",
        status: "UPCOMING",
        schedule: {
          timezone: TIMEZONE,
          startAt: new Date(startAtFor("15:00")),
          endAt: new Date(startAtFor("15:00")),
        },
      };
      await runSync(staleUpcomingSnapshot);

      expect(fakeIntegration.patchCalls).toHaveLength(0);
    });

    it("disconnected integration (no method wired) → safe skip, reschedule succeeds", async () => {
      const { owner, business, booking } = await createUpcomingBooking("10:00");
      await linkEvent(booking._id);

      const noIntegrationLifecycle = new BookingLifecycleService(
        bookingService,
        bookingRepository,
        businessRepository,
        reservationService,
        availabilityService,
        serviceRepository,
        staffRepository,
        paymentService,
        financialTransactionService,
        undefined, // integrationService absent
      );

      const rescheduled = await noIntegrationLifecycle.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        startAtFor("15:00"),
      );

      expect(rescheduled.schedule.startAt.toISOString()).toBe(startAtFor("15:00"));
      expect(fakeIntegration.patchCalls).toHaveLength(0);
    });
  });

  it("B3 manual Group reschedule changes canonical membership atomically and retains old released evidence", async () => {
    const f = await setupBookableBusiness();
    const group = await createGroupService(f.business._id, f.membership._id, 5);
    const make = (time: string, partySize: number) =>
      creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        {
          serviceLines: [
            {
              serviceId: String(group._id),
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: { personCount: partySize },
            },
          ],
          startAt: startAtFor(time),
          businessClientId: String(f.client._id),
          idempotencyKey: `b3-manual-${new Types.ObjectId()}`,
        },
      );
    const creator = await make("10:00", 1);
    const joiner = await make("10:00", 2);
    const target = await make("15:00", 1);
    const original = joiner.serviceLines[0];
    if (!original?.reservationOperationKey) throw new Error("Real line operation required");
    const moved = await lifecycleService.rescheduleByOwner(
      String(f.owner._id),
      "BUSINESS_OWNER",
      String(f.business._id),
      String(joiner._id),
      startAtFor("15:00"),
    );
    const line = moved.serviceLines[0];
    if (!line?.reservationOperationKey) throw new Error("Rescheduled operation required");
    expect(String(line.reservationId)).toBe(String(target.serviceLines[0]?.reservationId));
    expect(line.reservationOperationKey).not.toBe(original.reservationOperationKey);
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: original.reservationOperationKey,
        }).orFail()
      ).effect?.state,
    ).toBe("RELEASED");
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: line.reservationOperationKey,
        }).orFail()
      ).effect?.state,
    ).toBe("APPLIED");
    const doc = await BookingSlotReservationModel.findOne().orFail();
    expect(
      doc.intervals.find((i) => i.reservationId.equals(creator.serviceLines[0]?.reservationId))
        ?.capacityUsed,
    ).toBe(1);
    expect(
      doc.intervals.find((i) => i.reservationId.equals(line.reservationId))?.capacityUsed,
    ).toBe(3);
    await lifecycleService.cancelByBusiness(
      String(f.owner._id),
      "BUSINESS_OWNER",
      String(f.business._id),
      String(moved._id),
      undefined,
    );
    expect(
      (await BookingSlotReservationModel.findOne().orFail()).intervals.find((i) =>
        i.reservationId.equals(line.reservationId),
      )?.capacityUsed,
    ).toBe(1);
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: line.reservationOperationKey,
        }).orFail()
      ).effect?.state,
    ).toBe("RELEASED");
  });

  it("C1 freezes a different Business timezone after Booking commitment", async () => {
    const f = await createUpcomingBooking();
    await expect(
      businessRepository.updateOwnedById(f.owner._id, f.business._id, { timezone: "UTC" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await businessRepository.findById(f.business._id))?.timezone).toBe(TIMEZONE);
  });
  it("C1 reschedule rejects an employment-inactive exact provider without moving occupancy", async () => {
    const f = await createUpcomingBooking();
    await staffRepository.updateActiveById(f.business._id, f.membership._id, {
      employmentActive: false,
    });
    await expect(
      lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        startAtFor("15:00"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
    ).toEqual(f.booking.schedule.startAt);
  });

  describe("C1 ordered scheduling admission", () => {
    afterEach(() => vi.restoreAllMocks());
    const signal = () => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    type Fixture = Awaited<ReturnType<typeof setupBookableBusiness>>;
    const manualInput = (f: Fixture, time = "10:00", key = `c1-${new Types.ObjectId()}`) => ({
      serviceLines: [
        {
          serviceId: String(f.service._id),
          staffMembershipId: String(f.membership._id),
          addonIds: [],
          pricingInput: {},
        },
      ],
      startAt: startAtFor(time),
      businessClientId: String(f.client._id),
      idempotencyKey: key,
    });
    const admit = (f: Fixture, input = manualInput(f)) =>
      creationService.createManualBooking(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        input,
      );
    const editService = async (f: Fixture, kind: "assignment" | "timing" | "manual") => {
      const doc = await ServiceModel.findById(f.service._id).orFail();
      if (!doc.fixedPricing) throw new Error("Fixed fixture required");
      const fields = doc.toObject();
      if (kind === "assignment") fields.assignedStaffMembershipIds = [];
      if (kind === "timing") {
        const pricing = fields.fixedPricing;
        if (!pricing) throw new Error("Fixed fixture required");
        fields.fixedPricing = { ...pricing, bufferAfterMin: 15 };
      }
      if (kind === "manual") {
        fields.scheduleMode = "MANUAL";
        fields.manualSchedule = [{ dayOfWeek: "TUESDAY", isOpen: true, times: ["19:00"] }];
      }
      return serviceRepository.replaceById(f.business._id, f.service._id, fields);
    };
    const mutate = async (f: Fixture, kind: string) => {
      switch (kind) {
        case "shift":
          return staffScheduleRepository.replace(f.membership._id, f.business._id, [], ["TUESDAY"]);
        case "hours":
          return businessHoursRepository.replace(f.business._id, [
            { dayOfWeek: "TUESDAY", isOpen: false, slots: [] },
          ]);
        case "leave":
          return new StaffTimeOffRepository().create({
            businessId: f.business._id,
            membershipId: f.membership._id,
            type: "SICK_LEAVE",
            startDate: DATE,
            endDate: DATE,
            createdByUserId: f.owner._id,
          });
        case "employment":
          return staffRepository.updateActiveById(f.business._id, f.membership._id, {
            employmentActive: false,
          });
        case "assignment":
          return editService(f, "assignment");
        case "timing":
          return editService(f, "timing");
        case "suspension":
          return businessRepository.casUpdateStatus(f.business._id, ["APPROVED"], "SUSPENDED", {
            fromStatus: "APPROVED",
            actorUserId: f.owner._id,
            changedAt: new Date(),
          });
        default:
          throw new Error("Unknown mutation");
      }
    };
    for (const kind of [
      "shift",
      "hours",
      "leave",
      "employment",
      "assignment",
      "timing",
      "suspension",
    ]) {
      it(`C1 ${kind} mutation after preview wins before final admission`, async () => {
        const f = await setupBookableBusiness();
        const reached = signal(),
          proceed = signal();
        const original = availabilityService.assertSlotIsBookable.bind(availabilityService);
        vi.spyOn(availabilityService, "assertSlotIsBookable").mockImplementation(
          async (input, session) => {
            const result = await original(input, session);
            if (!session) {
              reached.resolve();
              await proceed.promise;
            }
            return result;
          },
        );
        const pending = admit(f).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        try {
          await reached.promise;
          await mutate(f, kind);
        } finally {
          proceed.resolve();
        }
        expect((await pending).error).toMatchObject({ statusCode: 409 });
        expect(await BookingModel.countDocuments({ businessId: f.business._id })).toBe(0);
        expect(
          await BookingSlotReservationClaimModel.countDocuments({ businessId: f.business._id }),
        ).toBe(0);
      });
      it(`C1 final admission wins before prospective ${kind} mutation`, async () => {
        const f = await setupBookableBusiness();
        const reached = signal(),
          proceed = signal();
        const original = reservationService.reserveOrJoin.bind(reservationService);
        vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
          async (input, session) => {
            expect(session?.inTransaction()).toBe(true);
            reached.resolve();
            await proceed.promise;
            return original(input, session);
          },
        );
        const pending = admit(f);
        await reached.promise;
        const mutation = mutate(f, kind);
        proceed.resolve();
        const booking = await pending;
        await mutation;
        expect((await bookingRepository.findById(f.business._id, booking._id))?.status).toBe(
          "UPCOMING",
        );
        expect(
          await BookingSlotReservationClaimModel.countDocuments({
            businessId: f.business._id,
            "effect.state": "APPLIED",
          }),
        ).toBe(1);
        expect(
          (await BookingSlotReservationModel.findOne({ businessId: f.business._id }).orFail())
            .intervals[0]?.capacityUsed,
        ).toBe(1);
        const claim = await BookingSlotReservationClaimModel.findOne({
          businessId: f.business._id,
        }).orFail();
        expect(claim.originalIntent?.startAt).toEqual(booking.schedule.startAt);
        expect(claim.originalIntent?.endAt).toEqual(booking.schedule.endAt);
        expect(claim.originalIntent?.timezone).toBe(TIMEZONE);
        expect(claim.effect?.actualReservationId).toEqual(booking.serviceLines[0]?.reservationId);
        expect(booking.serviceLines[0]?.serviceSnapshot.durationMin).toBe(60);
      });
    }
    it("C1 manual Service outside general hours still requires a Staff shift", async () => {
      const f = await setupBookableBusiness();
      await editService(f, "manual");
      await staffScheduleRepository.replace(f.membership._id, f.business._id, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "21:00" }] },
      ]);
      const booking = await admit(f, manualInput(f, "19:00"));
      expect(booking.schedule.startAt).toEqual(new Date(startAtFor("19:00")));
      await new StaffTimeOffRepository().create({
        businessId: f.business._id,
        membershipId: f.membership._id,
        type: "SICK_LEAVE",
        startDate: DATE,
        endDate: DATE,
        createdByUserId: f.owner._id,
      });
      await expect(admit(f, manualInput(f, "19:00"))).rejects.toMatchObject({ statusCode: 409 });
    });
    it("C1 manual committed replay ignores a later shift edit without new effects", async () => {
      const f = await setupBookableBusiness(),
        input = manualInput(f);
      const first = await admit(f, input);
      await mutate(f, "shift");
      const version = (await businessRepository.findById(f.business._id))
        ?.packageEligibilityVersion;
      const replay = await admit(f, input);
      expect(replay._id).toEqual(first._id);
      expect((await businessRepository.findById(f.business._id))?.packageEligibilityVersion).toBe(
        version,
      );
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(1);
    });
    it("C1 overlapping leave writers elect one range", async () => {
      const f = await setupBookableBusiness();
      const input = {
        businessId: f.business._id,
        membershipId: f.membership._id,
        type: "SICK_LEAVE" as const,
        startDate: DATE,
        endDate: DATE,
        createdByUserId: f.owner._id,
      };
      const repo = new StaffTimeOffRepository();
      const results = await Promise.allSettled([repo.create(input), repo.create(input)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await repo.listByMembershipId(f.membership._id)).toHaveLength(1);
    });
    it("C1 first admission rejects a timezone change committed after preview", async () => {
      const f = await setupBookableBusiness();
      const reached = signal(),
        proceed = signal();
      const original = availabilityService.assertSlotIsBookable.bind(availabilityService);
      vi.spyOn(availabilityService, "assertSlotIsBookable").mockImplementation(
        async (input, session) => {
          const result = await original(input, session);
          if (!session) {
            reached.resolve();
            await proceed.promise;
          }
          return result;
        },
      );
      const pending = admit(f).then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      try {
        await reached.promise;
        await businessRepository.updateOwnedById(f.owner._id, f.business._id, { timezone: "UTC" });
      } finally {
        proceed.resolve();
      }
      expect((await pending).error).toMatchObject({ statusCode: 409 });
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    });
    it("C1 first admission freezes the zone before a concurrent profile change", async () => {
      const f = await setupBookableBusiness();
      const reached = signal(),
        proceed = signal();
      const original = reservationService.reserveOrJoin.bind(reservationService);
      vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
        async (input, session) => {
          reached.resolve();
          await proceed.promise;
          return original(input, session);
        },
      );
      const pending = admit(f);
      await reached.promise;
      const change = businessRepository
        .updateOwnedById(f.owner._id, f.business._id, {
          timezone: "UTC",
          name: "Must not partially apply",
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
      proceed.resolve();
      await pending;
      expect((await change).error).toMatchObject({ statusCode: 409 });
      const business = await businessRepository.findById(f.business._id);
      expect(business?.timezone).toBe(TIMEZONE);
      expect(business?.name).toBe(f.business.name);
    });
    it("C1 same-zone and unrelated edits remain permitted after terminal history", async () => {
      const f = await createUpcomingBooking();
      await lifecycleService.cancelByBusiness(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        undefined,
      );
      const changed = await businessRepository.updateOwnedById(f.owner._id, f.business._id, {
        timezone: TIMEZONE,
        name: "New display name",
      });
      expect(changed?.name).toBe("New display name");
      await expect(
        businessRepository.updateOwnedById(f.owner._id, f.business._id, { timezone: "UTC" }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("C1 reschedule preserves verified occupied duration after catalogue timing changes", async () => {
      const f = await createUpcomingBooking();
      await editService(f, "timing");
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        startAtFor("15:00"),
      );
      expect(moved.schedule.endAt.getTime() - moved.schedule.startAt.getTime()).toBe(60 * 60_000);
    });
    it("C1 contradictory original intent denies a move and preserves the old Booking", async () => {
      const f = await createUpcomingBooking();
      await BookingSlotReservationClaimModel.collection.updateOne(
        { idempotencyKey: f.booking.serviceLines[0]?.reservationOperationKey },
        { $set: { "originalIntent.endAt": new Date(startAtFor("10:30")) } },
      );
      await expect(
        lifecycleService.rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          startAtFor("15:00"),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
      ).toEqual(f.booking.schedule.startAt);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(1);
    });
    it("C1 lifecycle reschedule remains allowed on a suspended Business", async () => {
      const f = await createUpcomingBooking();
      await mutate(f, "suspension");
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        startAtFor("15:00"),
      );
      expect(moved.schedule.startAt).toEqual(new Date(startAtFor("15:00")));
    });
    it("C1 shared coordinator and schedule mutation roll back with the caller", async () => {
      const f = await setupBookableBusiness();
      const before = await businessRepository.findById(f.business._id);
      const session = await mongoose.startSession();
      try {
        await expect(
          session.withTransaction(async () => {
            await acquireSchedulingAdmission(f.business, session);
            await staffScheduleRepository.replace(
              f.membership._id,
              f.business._id,
              [],
              ["TUESDAY"],
              session,
            );
            throw new Error("abort C1");
          }),
        ).rejects.toThrow("abort C1");
      } finally {
        await session.endSession();
      }
      expect((await businessRepository.findById(f.business._id))?.packageEligibilityVersion).toBe(
        before?.packageEligibilityVersion,
      );
      expect(
        (await staffScheduleRepository.findByMembershipId(f.membership._id))?.days,
      ).toHaveLength(5);
    });
    it("C1 counter exhaustion rejects without occupancy or Booking effects", async () => {
      const f = await setupBookableBusiness();
      await BusinessModel.updateOne(
        { _id: f.business._id },
        { $set: { packageEligibilityVersion: Number.MAX_SAFE_INTEGER } },
      );
      await expect(admit(f)).rejects.toMatchObject({ statusCode: 409 });
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    });
    it("C1 a real stale-snapshot write conflict retries with one stable operation key", async () => {
      const f = await setupBookableBusiness(),
        read = signal(),
        proceed = signal();
      const session = await mongoose.startSession();
      const key = `c1-retry:${new Types.ObjectId()}`;
      let attempts = 0;
      const serverCodes: unknown[] = [];
      const pending = session.withTransaction(async () => {
        attempts++;
        await BusinessModel.findById(f.business._id).session(session);
        if (attempts === 1) {
          read.resolve();
          await proceed.promise;
        }
        const current = await acquireSchedulingAdmission(f.business, session).catch((error) => {
          if (error instanceof mongoose.mongo.MongoServerError) serverCodes.push(error.code);
          throw error;
        });
        await validateSchedulingLine(
          {
            business: current,
            serviceId: f.service._id,
            staffMembershipId: f.membership._id,
            startAt: new Date(startAtFor("10:00")),
            endAt: new Date(startAtFor("11:00")),
            partySize: 1,
            capacityMax: 1,
            allowInactive: false,
            expectedService: f.service,
            fulfilment: {
              mode: "AT_BUSINESS_LOCATION",
              businessLocation: {
                city: "Larnaca",
                area: "Center",
                streetName: "Main",
                streetNumber: "1",
              },
            },
          },
          availabilityService,
          session,
        );
        const schedule = await staffScheduleRepository.findByMembershipId(
          f.membership._id,
          session,
        );
        expect(schedule?.days[0]?.intervals[0]?.endTime).toBe("17:00");
        return reservationService.reserveOrJoin(
          {
            businessId: f.business._id,
            staffMembershipId: f.membership._id,
            serviceId: f.service._id,
            timezone: TIMEZONE,
            startAt: new Date(startAtFor("10:00")),
            endAt: new Date(startAtFor("11:00")),
            partySize: 1,
            capacityMax: 1,
            idempotencyKey: key,
          },
          session,
        );
      });
      try {
        await read.promise;
        await staffScheduleRepository.replace(f.membership._id, f.business._id, [
          { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
        ]);
        proceed.resolve();
        await pending;
      } finally {
        proceed.resolve();
        await session.endSession();
      }
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(serverCodes).toContain(112);
      expect(
        await BookingSlotReservationClaimModel.countDocuments({
          idempotencyKey: key,
          "effect.state": "APPLIED",
        }),
      ).toBe(1);
      expect((await BookingSlotReservationModel.findOne().orFail()).intervals).toHaveLength(1);
    });
    it.each(["Booking", "claim", "day"] as const)(
      "C1 isolated %s history independently freezes the timezone",
      async (evidence) => {
        const f = await createUpcomingBooking();
        // Disposable historical evidence fixtures; never a production history cleanup.
        if (evidence !== "Booking")
          await BookingModel.collection.deleteMany({ businessId: f.business._id });
        if (evidence !== "claim")
          await BookingSlotReservationClaimModel.collection.deleteMany({
            businessId: f.business._id,
          });
        if (evidence !== "day")
          await BookingSlotReservationModel.collection.deleteMany({ businessId: f.business._id });
        await expect(
          businessRepository.updateOwnedById(f.owner._id, f.business._id, { timezone: "UTC" }),
        ).rejects.toMatchObject({ statusCode: 409 });
      },
    );
    it("C1 identical UTC interval cannot be moved into a second timezone partition", async () => {
      const f = await setupBookableBusiness();
      const doc = await ServiceModel.findById(f.service._id).orFail();
      const fields = doc.toObject();
      if (!fields.fixedPricing) throw new Error("Fixed fixture required");
      fields.fixedPricing.durationMin = 30;
      await serviceRepository.replaceById(f.business._id, f.service._id, fields);
      const days = ["TUESDAY", "WEDNESDAY"] as const;
      await staffScheduleRepository.replace(
        f.membership._id,
        f.business._id,
        days.map((dayOfWeek) => ({
          dayOfWeek,
          intervals: [{ startTime: "00:00", endTime: "23:59" }],
        })),
      );
      await businessHoursRepository.replace(
        f.business._id,
        days.map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: true,
          slots: [{ startTime: "00:00", endTime: "23:59" }],
        })),
      );
      const input = { ...manualInput(f), startAt: "2030-08-20T21:30:00.000Z" };
      await admit(f, input);
      await expect(
        businessRepository.updateOwnedById(f.owner._id, f.business._id, { timezone: "UTC" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        admit(f, { ...input, idempotencyKey: `c1-second-${new Types.ObjectId()}` }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await BookingModel.countDocuments()).toBe(1);
      const day = await BookingSlotReservationModel.findOne().orFail();
      expect(day.occupancyDate).toBe("2030-08-21");
      expect(day.intervals).toHaveLength(1);
    });
    it("C1 inactive supplied mutation sessions reject without writes", async () => {
      const f = await setupBookableBusiness();
      const session = await mongoose.startSession();
      try {
        await expect(
          staffScheduleRepository.replace(f.membership._id, f.business._id, [], [], session),
        ).rejects.toMatchObject({ statusCode: 503 });
      } finally {
        await session.endSession();
      }
      expect(
        (await staffScheduleRepository.findByMembershipId(f.membership._id))?.days,
      ).toHaveLength(5);
    });

    it("C1 multi-line reschedule preserves independent occupied durations and sorted reservation order", async () => {
      const f = await setupBookableBusiness();
      const second = await createStaff(f.business._id);
      await staffWorksMondayToFriday(second.membership._id, f.business._id);
      const service = await createFixedService(f.business._id, second.membership._id);
      const doc = await ServiceModel.findById(service._id).orFail();
      const fields = doc.toObject();
      if (!fields.fixedPricing) throw new Error("Fixed fixture required");
      fields.fixedPricing.durationMin = 30;
      await serviceRepository.replaceById(f.business._id, service._id, fields);
      const input = manualInput(f);
      input.serviceLines.unshift({
        serviceId: String(service._id),
        staffMembershipId: String(second.membership._id),
        addonIds: [],
        pricingInput: {},
      });
      const original = reservationService.reserveOrJoin.bind(reservationService);
      const order: string[] = [];
      vi.spyOn(reservationService, "reserveOrJoin").mockImplementation(async (request, session) => {
        order.push(String(request.staffMembershipId));
        return original(request, session);
      });
      const booking = await admit(f, input);
      const expected = [String(f.membership._id), String(second.membership._id)].sort();
      expect(order).toEqual(expected);
      order.length = 0;
      const moved = await lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(booking._id),
        startAtFor("15:00"),
      );
      expect(order).toEqual(expected);
      const day = await BookingSlotReservationModel.findOne({
        staffMembershipId: second.membership._id,
      }).orFail();
      const interval = day.intervals.find((entry) =>
        entry.reservationId.equals(moved.serviceLines[0]?.reservationId),
      );
      expect(interval?.endAt.getTime()).toBe(new Date(startAtFor("15:30")).getTime());
      expect(moved.schedule.endAt).toEqual(new Date(startAtFor("16:00")));
    });
    it("C1 a failed second reservation rolls back every line and the coordinator", async () => {
      const f = await setupBookableBusiness();
      const second = await createStaff(f.business._id);
      await staffWorksMondayToFriday(second.membership._id, f.business._id);
      const service = await createFixedService(f.business._id, second.membership._id);
      const input = manualInput(f);
      input.serviceLines.push({
        serviceId: String(service._id),
        staffMembershipId: String(second.membership._id),
        addonIds: [],
        pricingInput: {},
      });
      const version = (await businessRepository.findById(f.business._id))
        ?.packageEligibilityVersion;
      const original = reservationService.reserveOrJoin.bind(reservationService);
      vi.spyOn(reservationService, "reserveOrJoin")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("second-line failure"));
      await expect(admit(f, input)).rejects.toThrow("second-line failure");
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
      expect((await businessRepository.findById(f.business._id))?.packageEligibilityVersion).toBe(
        version,
      );
    });

    it.each(["assignment", "removed", "inactive Service"] as const)(
      "C1 reschedule denies %s and keeps original membership",
      async (kind) => {
        const f = await createUpcomingBooking();
        if (kind === "assignment") await editService(f, "assignment");
        else if (kind === "removed")
          await staffRepository.softRemoveById(f.business._id, f.membership._id);
        else await serviceRepository.updateStatusById(f.business._id, f.service._id, "INACTIVE");
        const original = JSON.stringify(
          await BookingSlotReservationModel.find({ businessId: f.business._id }).lean(),
        );
        await expect(
          lifecycleService.rescheduleByOwner(
            String(f.owner._id),
            "BUSINESS_OWNER",
            String(f.business._id),
            String(f.booking._id),
            startAtFor("15:00"),
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          JSON.stringify(
            await BookingSlotReservationModel.find({ businessId: f.business._id }).lean(),
          ),
        ).toBe(original);
        expect(
          (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
        ).toEqual(f.booking.schedule.startAt);
      },
    );
    it("C1 reschedule sees a shift edit committed after its original Booking read", async () => {
      const f = await createUpcomingBooking(),
        reached = signal(),
        proceed = signal();
      const original = bookingRepository.findById.bind(bookingRepository);
      vi.spyOn(bookingRepository, "findById").mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        reached.resolve();
        await proceed.promise;
        return result;
      });
      const pending = lifecycleService
        .rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          startAtFor("15:00"),
        )
        .then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
      try {
        await reached.promise;
        await mutate(f, "shift");
      } finally {
        proceed.resolve();
      }
      expect((await pending).error).toMatchObject({ statusCode: 409 });
      expect(
        (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
      ).toEqual(f.booking.schedule.startAt);
      expect(
        await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "APPLIED" }),
      ).toBe(1);
    });
    it("C1 reschedule commits before a prospective shift edit", async () => {
      const f = await createUpcomingBooking(),
        reached = signal(),
        proceed = signal();
      const original = reservationService.reserveOrJoin.bind(reservationService);
      vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
        async (input, session) => {
          reached.resolve();
          await proceed.promise;
          return original(input, session);
        },
      );
      const pending = lifecycleService.rescheduleByOwner(
        String(f.owner._id),
        "BUSINESS_OWNER",
        String(f.business._id),
        String(f.booking._id),
        startAtFor("15:00"),
      );
      await reached.promise;
      const change = mutate(f, "shift");
      proceed.resolve();
      const moved = await pending;
      await change;
      expect(moved.schedule.startAt).toEqual(new Date(startAtFor("15:00")));
      expect(
        await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "APPLIED" }),
      ).toBe(1);
      expect(
        await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "RELEASED" }),
      ).toBe(1);
    });

    it.each(["mutation-first", "admission-first"] as const)(
      "C1 existing Group join obeys scheduling order: %s",
      async (order) => {
        const f = await setupBookableBusiness();
        const group = await createGroupService(f.business._id, f.membership._id, 3);
        const input = {
          ...manualInput(f),
          serviceLines: [
            {
              serviceId: String(group._id),
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: { personCount: 1 },
            },
          ],
        };
        await admit(f, input);
        const reached = signal(),
          proceed = signal();
        if (order === "mutation-first") {
          const original = availabilityService.assertSlotIsBookable.bind(availabilityService);
          vi.spyOn(availabilityService, "assertSlotIsBookable").mockImplementation(
            async (request, session) => {
              const result = await original(request, session);
              if (!session) {
                reached.resolve();
                await proceed.promise;
              }
              return result;
            },
          );
        } else {
          const original = reservationService.reserveOrJoin.bind(reservationService);
          vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
            async (request, session) => {
              reached.resolve();
              await proceed.promise;
              return original(request, session);
            },
          );
        }
        const pending = admit(f, {
          ...input,
          idempotencyKey: `group-c1-${new Types.ObjectId()}`,
        }).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await reached.promise;
        if (order === "mutation-first") {
          try {
            await mutate(f, "leave");
          } finally {
            proceed.resolve();
          }
        } else {
          const mutation = mutate(f, "leave");
          proceed.resolve();
          await pending;
          await mutation;
        }
        const result = await pending;
        if (order === "mutation-first") expect(result.error).toMatchObject({ statusCode: 409 });
        else expect(result.value?.status).toBe("UPCOMING");
        expect(
          (await BookingSlotReservationModel.findOne({ businessId: f.business._id }).orFail())
            .intervals[0]?.capacityUsed,
        ).toBe(order === "mutation-first" ? 1 : 2);
        expect(
          await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "APPLIED" }),
        ).toBe(order === "mutation-first" ? 1 : 2);
      },
    );
    it("C1 missing historical exclusive evidence cannot authorize a guessed move", async () => {
      const f = await createUpcomingBooking();
      await BookingModel.collection.updateOne(
        { _id: f.booking._id },
        { $unset: { "serviceLines.0.reservationOperationKey": "" } },
      );
      await BookingSlotReservationClaimModel.collection.deleteMany({ businessId: f.business._id });
      await BookingSlotReservationModel.collection.deleteMany({ businessId: f.business._id });
      await expect(
        lifecycleService.rescheduleByOwner(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          startAtFor("15:00"),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await bookingRepository.findById(f.business._id, f.booking._id))?.schedule.startAt,
      ).toEqual(f.booking.schedule.startAt);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    });
    it("C1 schedule deletion and leave deletion primitives use owned or joined coordination", async () => {
      const f = await setupBookableBusiness();
      await staffScheduleRepository.deleteByMembershipId(f.membership._id);
      await expect(admit(f)).rejects.toMatchObject({ statusCode: 409 });
      await staffWorksMondayToFriday(f.membership._id, f.business._id);
      const repo = new StaffTimeOffRepository();
      await repo.create({
        businessId: f.business._id,
        membershipId: f.membership._id,
        type: "SICK_LEAVE",
        startDate: DATE,
        endDate: DATE,
        createdByUserId: f.owner._id,
      });
      const session = await mongoose.startSession();
      try {
        await expect(
          session.withTransaction(async () => {
            await repo.deleteByMembershipId(f.membership._id, session);
            throw new Error("abort leave deletion");
          }),
        ).rejects.toThrow("abort leave deletion");
      } finally {
        await session.endSession();
      }
      expect(await repo.listByMembershipId(f.membership._id)).toHaveLength(1);
      await repo.deleteByMembershipId(f.membership._id);
      expect((await admit(f)).status).toBe("UPCOMING");
    });

    it("C1 multi-line admission rejects one changed provider schedule without a partial result", async () => {
      const f = await setupBookableBusiness();
      const second = await createStaff(f.business._id);
      await staffWorksMondayToFriday(second.membership._id, f.business._id);
      const service = await createFixedService(f.business._id, second.membership._id);
      const input = manualInput(f);
      input.serviceLines.push({
        serviceId: String(service._id),
        staffMembershipId: String(second.membership._id),
        addonIds: [],
        pricingInput: {},
      });
      const reached = signal(),
        proceed = signal();
      let previews = 0;
      const original = availabilityService.assertSlotIsBookable.bind(availabilityService);
      vi.spyOn(availabilityService, "assertSlotIsBookable").mockImplementation(
        async (request, session) => {
          const result = await original(request, session);
          if (!session && ++previews === 2) {
            reached.resolve();
            await proceed.promise;
          }
          return result;
        },
      );
      const pending = admit(f, input).then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      try {
        await reached.promise;
        await staffScheduleRepository.replace(second.membership._id, f.business._id, []);
      } finally {
        proceed.resolve();
      }
      expect((await pending).error).toMatchObject({ statusCode: 409 });
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
    });
  });
});
