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
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
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
const DATE = "2030-08-20";
const DATE_2 = "2030-08-21";
const DATE_3 = "2030-08-22";

/**
 * Session End Email Reminder — Booking-creation snapshot coverage. Confirms the LOCKED product
 * rule end-to-end at the persistence layer: `Service.sessionExpiryAlert` is copied onto every
 * new Booking's `sessionEndReminderSnapshot` at creation time (see booking.model.ts's own doc
 * comment), regardless of which of the three physical creation paths is used
 * (createManualBooking / finalizeCustomerBooking+finalizePackagePurchase / redeemPackageSession —
 * all three route through `bookingRepository.create` in booking-creation.service.ts), and that a
 * later Service edit never retroactively touches an already-created Booking. Reminder
 * scheduling/delivery itself (recipient resolution, preference bypass, retirement, reschedule
 * re-anchoring) is unit-tested against the scheduler/worker directly — see
 * appointment-reminder-scheduler.test.ts and appointment-reminder-worker.test.ts.
 */
describe("database-backed Session End Reminder snapshot integration", () => {
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
  let paymentService: PaymentService;

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
    const cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
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
    const packageProgressRepository = new PackageProgressRepository();

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
      cancellationPolicyRepository,
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
      undefined, // integrationService
      undefined, // platformSettingsService
      undefined, // bookingCreatedNotifier
      undefined, // appointmentReminderScheduler — snapshot correctness doesn't require it
      packageProgressRepository,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ------------------------------------------------------------------------------

  const createBusiness = async () => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Salon A",
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Wellness & Beauty",
      subcategories: ["Massage"],
    } as Parameters<typeof businessRepository.create>[0]);
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
      firstName: "Staff",
      lastName: "Member",
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

  const openEveryDay = async (businessId: Types.ObjectId, ownerId: Types.ObjectId) => {
    const days = [
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ] as const;
    await businessHoursService.putOpeningHours(
      String(ownerId),
      String(businessId),
      days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
  };

  const staffWorksEveryDay = async (membershipId: Types.ObjectId, businessId: Types.ObjectId) => {
    const days = [
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ] as const;
    await staffScheduleRepository.replace(
      membershipId,
      businessId,
      days.map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "18:00" })),
    );
  };

  const createFixedService = async (
    businessId: Types.ObjectId,
    staffId: Types.ObjectId,
    sessionExpiryAlert: { enabled: boolean; minutesBeforeSessionEnds?: number },
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 10_000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert,
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    } as Parameters<typeof serviceRepository.create>[0]);

  const createPackageService = async (
    businessId: Types.ObjectId,
    staffId: Types.ObjectId,
    sessionExpiryAlert: { enabled: boolean; minutesBeforeSessionEnds?: number },
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: true,
      category: "Wellness & Beauty",
      name: "5 Session Massage Pack",
      packageServicesName: "Deep Tissue Massage",
      packagePricing: {
        durationMin: 60,
        bookingIntervalMin: 60,
        sessionsInPackage: 5,
        bundlePriceCents: 45_000,
        discountPercent: 10,
      },
      sessionExpiryAlert,
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    } as Parameters<typeof serviceRepository.create>[0]);

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

  let linkedClientPhoneCounter = 0;
  const linkCustomerToBusiness = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    customerId: Types.ObjectId,
  ) => {
    const user = await userRepository.findById(customerId);
    linkedClientPhoneCounter += 1;
    const nationalNumber = String(99_000_000 + linkedClientPhoneCounter);
    return clientRepository.create({
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

  const startAtFor = (date: string, time: string) =>
    businessLocalToUtc(TIMEZONE, date, time).toISOString();

  /** `sessionEndReminderSnapshot` comes back as a Mongoose subdocument (not a plain object) —
   * `.toObject()` first, matching this codebase's own established convention for comparing a
   * Mongoose subdocument against a plain-object expectation (see the Restore Validation batch's
   * own fix for the identical issue). `undefined` (legacy — no snapshot at all) passes through. */
  const plainSnapshot = (doc: { sessionEndReminderSnapshot?: unknown }): unknown => {
    const snapshot = doc.sessionEndReminderSnapshot as { toObject?: () => unknown } | undefined;
    return snapshot?.toObject ? snapshot.toObject() : snapshot;
  };

  const bookingInput = (
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
    date: string,
    idempotencyKey: string,
  ) => ({
    serviceLines: [
      {
        serviceId: String(serviceId),
        staffMembershipId: String(staffId),
        addonIds: [],
        pricingInput: {},
      },
    ],
    startAt: startAtFor(date, "10:00"),
    idempotencyKey,
  });

  // --- Tests -----------------------------------------------------------------------------------

  it("createManualBooking (Owner/Supervisor path) snapshots an enabled Service alert onto the Booking", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, {
      enabled: true,
      minutesBeforeSessionEnds: 15,
    });
    await openEveryDay(business._id, owner._id);
    await staffWorksEveryDay(membership._id, business._id);
    const customer = await createCustomer("manual");
    const client = await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const booking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      {
        ...bookingInput(service._id, membership._id, DATE, "manual-1"),
        businessClientId: String(client._id),
      },
    );

    expect(plainSnapshot(booking)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 15,
    });
  });

  it("createManualBooking snapshots a disabled alert as {enabled:false} — present, not omitted", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, { enabled: false });
    await openEveryDay(business._id, owner._id);
    await staffWorksEveryDay(membership._id, business._id);
    const customer = await createCustomer("manual2");
    const client = await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const booking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      {
        ...bookingInput(service._id, membership._id, DATE, "manual-2"),
        businessClientId: String(client._id),
      },
    );

    expect(plainSnapshot(booking)).toEqual({ enabled: false });
  });

  it("finalizeCustomerBooking (normal Customer self-service path) snapshots the Service alert", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, {
      enabled: true,
      minutesBeforeSessionEnds: 10,
    });
    await openEveryDay(business._id, owner._id);
    await staffWorksEveryDay(membership._id, business._id);
    const customer = await createCustomer("self");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      bookingInput(service._id, membership._id, DATE, "self-1"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed booking");

    expect(plainSnapshot(result.booking)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 10,
    });
  });

  it("finalizePackagePurchase (Package session 1) and redeemPackageSession (session 2) each snapshot the Service alert independently", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const service = await createPackageService(business._id, membership._id, {
      enabled: true,
      minutesBeforeSessionEnds: 20,
    });
    await openEveryDay(business._id, owner._id);
    await staffWorksEveryDay(membership._id, business._id);
    const customer = await createCustomer("pkg");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const purchase = await creationService.finalizePackagePurchase(
      String(customer._id),
      String(business._id),
      bookingInput(service._id, membership._id, DATE, "pkg-purchase-1"),
    );
    if (purchase.status !== "confirmed") throw new Error("expected confirmed purchase");
    expect(plainSnapshot(purchase.booking)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 20,
    });

    // Disable the alert on the Service BEFORE redeeming session 2 — the redemption is a NEW
    // Booking, so it must snapshot the Service's CURRENT (now-disabled) setting; it must NOT
    // reuse session 1's snapshot, and session 1's own snapshot must stay untouched (see the
    // separate per-booking-independence test below for the inverse direction).
    await ServiceModel.updateOne(
      { _id: service._id },
      { $set: { sessionExpiryAlert: { enabled: false } } },
    );

    const progress = await PackageProgressModel.findOne({ originBookingId: purchase.booking._id })
      .orFail()
      .exec();
    await BookingModel.updateOne(
      { _id: purchase.booking._id },
      { $set: { status: "COMPLETED", "financials.balanceDueCents": 0 } },
    );

    const redemption = await creationService.redeemPackageSession(
      String(customer._id),
      String(business._id),
      String(progress._id),
      {
        staffMembershipId: String(membership._id),
        startAt: startAtFor(DATE_2, "10:00"),
        idempotencyKey: "pkg-redeem-1",
      },
    );
    if (redemption.status !== "confirmed") throw new Error("expected confirmed redemption");

    expect(plainSnapshot(redemption.booking)).toEqual({ enabled: false });

    const reloadedPurchase = await BookingModel.findById(purchase.booking._id).orFail().exec();
    expect(plainSnapshot(reloadedPurchase)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 20,
    });
  });

  it("a later Service.sessionExpiryAlert edit never changes an already-created Booking's snapshot (per-booking independence)", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, {
      enabled: true,
      minutesBeforeSessionEnds: 5,
    });
    await openEveryDay(business._id, owner._id);
    await staffWorksEveryDay(membership._id, business._id);
    const customer = await createCustomer("indep");
    const client = await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const before = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      {
        ...bookingInput(service._id, membership._id, DATE, "indep-1"),
        businessClientId: String(client._id),
      },
    );

    // Flip the Service setting in BOTH directions after the fact.
    await ServiceModel.updateOne(
      { _id: service._id },
      { $set: { sessionExpiryAlert: { enabled: true, minutesBeforeSessionEnds: 45 } } },
    );

    const after = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      {
        ...bookingInput(service._id, membership._id, DATE_3, "indep-2"),
        businessClientId: String(client._id),
      },
    );

    const reloadedBefore = await BookingModel.findById(before._id).orFail().exec();
    expect(plainSnapshot(reloadedBefore)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 5,
    });
    expect(plainSnapshot(after)).toEqual({
      enabled: true,
      minutesBeforeSessionEnds: 45,
    });
  });

  it("a legacy Booking with no sessionEndReminderSnapshot at all round-trips as undefined — never inferred as disabled", async () => {
    const { business } = await createBusiness();
    const legacy = await BookingModel.create({
      businessId: business._id,
      reference: "LEGACY01",
      source: "MANUAL",
      status: "UPCOMING",
      customer: {
        businessClientId: new Types.ObjectId(),
        contact: {
          firstName: "Legacy",
          normalizedEmail: "legacy@example.com",
          phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
        },
      },
      createdBy: { actorUserId: new Types.ObjectId(), actorRole: "BUSINESS_OWNER" },
      fulfilment: { mode: "AT_BUSINESS_LOCATION" },
      serviceLines: [
        {
          serviceId: new Types.ObjectId(),
          serviceSnapshot: { name: "Legacy Service", pricingMode: "FIXED", durationMin: 60 },
          pricingInput: {},
          responsibleStaffMembershipId: new Types.ObjectId(),
          addons: [],
          amountCents: 10_000,
          reservationId: new Types.ObjectId(),
        },
      ],
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 10_000,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: 10_000,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: 10_000,
        totalCents: 10_000,
      },
      schedule: {
        timezone: TIMEZONE,
        startAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        endAt: new Date(Date.now() + 73 * 60 * 60 * 1000),
      },
      customerRescheduleCount: 0,
      rescheduleHistory: [],
      eventHistory: [],
      // sessionEndReminderSnapshot deliberately omitted — simulates a pre-feature document.
    });

    const reloaded = await BookingModel.findById(legacy._id).orFail().exec();
    expect(reloaded.sessionEndReminderSnapshot).toBeUndefined();
  });
});
