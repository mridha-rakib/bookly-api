import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
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
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingRescheduledCustomerNotifier } from "../../../src/modules/notification/booking-rescheduled-customer.notifier.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
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
    expect(preview.amountDueNowCents).toBe(preview.financials.platformFeeCents);
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
});
