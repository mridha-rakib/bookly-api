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
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { cancellationTiers } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
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
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"
const DATE_2 = "2030-08-21"; // Wednesday — a second redemption date

/**
 * Package Deal audit — end-to-end coverage for the confirmed lifecycle: purchase (session 1,
 * fully paid, exactly like a normal FIXED booking) -> PackageProgress entitlement -> incremental
 * session redemption ($0, no deposit-floor double-charge) -> cancellation restores the balance
 * (no refund) -> completion marks a session consumed. Every test here exercises the SAME
 * BookingCreationService/BookingLifecycleService classes the normal booking suites already cover
 * (booking-payment-database.integration.test.ts, booking-lifecycle-database.integration.test.ts)
 * — this file adds only what's genuinely new: the Package-specific orchestration and the atomic
 * PackageProgressRepository operations.
 */
describe("database-backed Package Deal integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let reservationService: BookingSlotReservationService;
  let availabilityService: AvailabilityService;
  let bookingService: BookingService;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
  let packageProgressRepository: PackageProgressRepository;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
  let businessTravelSettingsRepository: BusinessTravelSettingsRepository;

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
    reservationService = new BookingSlotReservationService(reservationRepository);
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
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
    packageProgressRepository = new PackageProgressRepository();

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
      undefined, // integrationService
      undefined, // platformSettingsService
      undefined, // bookingCreatedNotifier
      undefined, // appointmentReminderScheduler
      packageProgressRepository,
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
      undefined, // integrationService
      undefined, // bookingCompletedNotifier
      undefined, // bookingCancelledNotifier
      undefined, // noShowNotifier
      undefined, // staffBookingNotifier
      undefined, // appointmentReminderScheduler
      undefined, // bookingRescheduledCustomerNotifier
      packageProgressRepository,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ------------------------------------------------------------------------------

  const createBusiness = async (
    email: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ) => {
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
      category: "Wellness & Beauty",
      subcategories: ["Massage"],
      ...overrides,
    } as Parameters<typeof businessRepository.create>[0]);
    return { owner, business };
  };

  const createStaff = async (businessId: Types.ObjectId, tag: string) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Staff",
      lastName: tag,
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

  const createPackageService = async (
    businessId: Types.ObjectId,
    staffIds: Types.ObjectId[],
    overrides: Record<string, unknown> = {},
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
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: staffIds,
      ...overrides,
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

  const setupPackageBusiness = async (
    staffCount = 1,
    businessOverrides: Record<string, unknown> = {},
    serviceOverrides: Record<string, unknown> = {},
  ) => {
    const { owner, business } = await createBusiness(
      `owner-${new Types.ObjectId().toString()}@example.com`,
      "Salon A",
      businessOverrides,
    );
    const staff = await Promise.all(
      Array.from({ length: staffCount }, (_, index) => createStaff(business._id, `s${index}`)),
    );
    const service = await createPackageService(
      business._id,
      staff.map((s) => s.membership._id),
      serviceOverrides,
    );
    await openEveryDay(business._id, owner._id);
    await Promise.all(staff.map((s) => staffWorksEveryDay(s.membership._id, business._id)));
    return { owner, business, staff, service };
  };

  /** A TRAVEL_TO_CUSTOMER Package business with Larnaca served and a real, nonzero fee — used
   * by the travel-fee-on-redemption coverage (approved rule: the Package base stays $0, but a
   * redemption's real travel fee for THAT visit is still owed). */
  const setupTravelPackageBusiness = async (staffCount = 1) => {
    const fixture = await setupPackageBusiness(
      staffCount,
      { visitType: "TRAVEL_TO_CUSTOMER" },
      { servedCities: ["Larnaca"] },
    );
    await businessTravelSettingsRepository.upsertByBusinessId(fixture.business._id, [
      { city: "Larnaca", active: true, feeCents: 1_200 },
    ]);
    return fixture;
  };

  const purchaseInput = (
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
    date = DATE,
    time = "10:00",
  ) => ({
    serviceLines: [
      {
        serviceId: String(serviceId),
        staffMembershipId: String(staffId),
        addonIds: [],
        pricingInput: {},
      },
    ],
    startAt: startAtFor(date, time),
    idempotencyKey: `pkg-purchase-${new Types.ObjectId().toString()}`,
  });

  const redeemInput = (staffId: Types.ObjectId, date = DATE_2, time = "10:00") => ({
    staffMembershipId: String(staffId),
    startAt: startAtFor(date, time),
    idempotencyKey: `pkg-redeem-${new Types.ObjectId().toString()}`,
  });

  const setUpPurchasedPackage = async () => {
    const { owner, business, staff, service } = await setupPackageBusiness();
    const customer = await createCustomer("buyer");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizePackagePurchase(
      String(customer._id),
      String(business._id),
      purchaseInput(service._id, staff[0]!.membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed purchase");

    const progress = await PackageProgressModel.findOne({ originBookingId: result.booking._id })
      .orFail()
      .exec();

    return { owner, business, staff, service, customer, purchase: result.booking, progress };
  };

  /** Records the origin (session 1) purchase Booking's remaining venue balance as fully paid —
   * the ONLY thing that unlocks redeemPackageSession for session 2+ (approved payment/unlock
   * rule; see package-progress.rules.ts's computePackageBalanceSettlement). Reuses the EXISTING
   * completeBooking venue-payment flow verbatim — never a second, Package-specific
   * payment-status field. */
  const settleOriginBalance = async (
    owner: { _id: Types.ObjectId },
    business: { _id: Types.ObjectId },
    purchaseBookingId: Types.ObjectId,
  ) =>
    lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(purchaseBookingId),
      { settlement: "FULL" },
    );

  /** Same as setUpPurchasedPackage, but additionally settles session 1's venue balance in full —
   * the precondition every session-2+ redemption test now requires. */
  const setUpSettledPackage = async () => {
    const fixture = await setUpPurchasedPackage();
    await settleOriginBalance(fixture.owner, fixture.business, fixture.purchase._id);
    return fixture;
  };

  /** Unwraps a "confirmed" FinalizeBookingResult, failing loudly on requires_action (no test in
   * this suite ever expects 3DS — every saved card here is the FakePaymentGateway's default
   * immediate-success outcome unless a test explicitly queues otherwise). */
  const redeemConfirmed = async (
    ...args: Parameters<BookingCreationService["redeemPackageSession"]>
  ) => {
    const result = await creationService.redeemPackageSession(...args);
    if (result.status !== "confirmed") throw new Error("expected confirmed redemption");
    return result.booking;
  };

  // --- Purchase --------------------------------------------------------------------------------

  describe("Package purchase", () => {
    it("charges the full bundle price as a normal deposit, creates session 1, and creates the entitlement", async () => {
      const { business, staff, service, customer, purchase, progress } =
        await setUpPurchasedPackage();

      expect(purchase.status).toBe("UPCOMING");
      expect(purchase.serviceLines).toHaveLength(1);
      const line = purchase.serviceLines[0]!;
      expect(line.serviceSnapshot.pricingMode).toBe("PACKAGE");
      expect(line.amountCents).toBe(45_000);
      expect(line.pricingInput.sessionIndex).toBe(1);
      expect(line.pricingInput.sessionsInPackage).toBe(5);
      expect(String(line.pricingInput.packageProgressId)).toBe(String(progress._id));

      // Same deposit formula as any FIXED-price booking — clamp(20% of 45000, 500, 3500) = 3500.
      expect(purchase.financials.depositCents).toBe(3_500);
      expect(purchase.financials.balanceDueCents).toBeGreaterThan(0);

      expect(progress.businessId.toString()).toBe(business._id.toString());
      expect(progress.customerUserId.toString()).toBe(customer._id.toString());
      expect(progress.serviceId.toString()).toBe(service._id.toString());
      expect(progress.totalSessions).toBe(5);
      expect(progress.remainingSessions).toBe(4);
      expect(progress.completedSessions).toBe(0);
      expect(progress.sessions).toHaveLength(1);
      expect(progress.sessions[0]).toMatchObject({
        sessionIndex: 1,
        status: "SCHEDULED",
      });
      expect(String(progress.sessions[0]!.bookingId)).toBe(String(purchase._id));

      const ledger = await financialTransactionService.listForBooking(purchase._id);
      const debitEntry = ledger.find((entry) => entry.direction === "DEBIT");
      expect(debitEntry?.amountCents).toBe(3_500);
      expect(debitEntry?.status).toBe("SUCCEEDED");

      void staff;
    });

    it("rejects a purchase with no saved card, persisting neither a Booking nor an entitlement", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("nocard");
      await linkCustomerToBusiness(business._id, owner._id, customer._id);

      await expect(
        creationService.finalizePackagePurchase(
          String(customer._id),
          String(business._id),
          purchaseInput(service._id, staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 402 });

      expect(await BookingModel.countDocuments({ businessId: business._id }).exec()).toBe(0);
      expect(await PackageProgressModel.countDocuments({ businessId: business._id }).exec()).toBe(
        0,
      );
    });

    it("rejects a purchase body with more than one service line", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("twolines");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);

      const input = purchaseInput(service._id, staff[0]!.membership._id);
      input.serviceLines.push({ ...input.serviceLines[0]! });

      await expect(
        creationService.finalizePackagePurchase(String(customer._id), String(business._id), input),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a purchase whose single line is not a Package Deal service", async () => {
      const { owner, business, staff } = await setupPackageBusiness();
      const nonPackage = await serviceRepository.create({
        businessId: business._id,
        status: "ACTIVE",
        isFeatured: false,
        isPackageDeal: false,
        category: "Wellness & Beauty",
        name: "Single Massage",
        pricingMode: "FIXED",
        fixedPricing: { priceCents: 9_000, durationMin: 60 },
        sessionExpiryAlert: { enabled: false },
        scheduleMode: "AUTO",
        manualSchedule: [],
        servedCities: [],
        assignedStaffMembershipIds: [staff[0]!.membership._id],
      } as Parameters<typeof serviceRepository.create>[0]);
      const customer = await createCustomer("notpkg");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);

      await expect(
        creationService.finalizePackagePurchase(
          String(customer._id),
          String(business._id),
          purchaseInput(nonPackage._id, staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("a failed charge persists neither a Booking nor an entitlement", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("declined");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      paymentGateway.queueNextChargeOutcome("failed");

      await expect(
        creationService.finalizePackagePurchase(
          String(customer._id),
          String(business._id),
          purchaseInput(service._id, staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 402 });

      expect(await BookingModel.countDocuments({ businessId: business._id }).exec()).toBe(0);
      expect(await PackageProgressModel.countDocuments({ businessId: business._id }).exec()).toBe(
        0,
      );
    });

    it("a requires_action charge returns a clientSecret and persists nothing", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("threeds");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      paymentGateway.queueNextChargeOutcome("requires_action");

      const result = await creationService.finalizePackagePurchase(
        String(customer._id),
        String(business._id),
        purchaseInput(service._id, staff[0]!.membership._id),
      );

      expect(result.status).toBe("requires_action");
      expect(await BookingModel.countDocuments({ businessId: business._id }).exec()).toBe(0);
      expect(await PackageProgressModel.countDocuments({ businessId: business._id }).exec()).toBe(
        0,
      );
    });

    it("retrying the same idempotencyKey after a successful purchase returns the same Booking, never double-charging", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("retry");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      const input = purchaseInput(service._id, staff[0]!.membership._id);

      const first = await creationService.finalizePackagePurchase(
        String(customer._id),
        String(business._id),
        input,
      );
      const second = await creationService.finalizePackagePurchase(
        String(customer._id),
        String(business._id),
        input,
      );

      if (first.status !== "confirmed" || second.status !== "confirmed") {
        throw new Error("expected both confirmed");
      }
      expect(String(second.booking._id)).toBe(String(first.booking._id));
      expect(await BookingModel.countDocuments({ businessId: business._id }).exec()).toBe(1);
      expect(await PackageProgressModel.countDocuments({ businessId: business._id }).exec()).toBe(
        1,
      );
    });
  });

  // --- Redemption ------------------------------------------------------------------------------

  describe("Package session redemption", () => {
    it("is blocked until the origin purchase's venue balance is settled (approved unlock rule)", async () => {
      const { business, staff, customer, progress } = await setUpPurchasedPackage();

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      const untouched = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(untouched.remainingSessions).toBe(4);
      expect(untouched.sessions).toHaveLength(1);
    });

    it("a PARTIAL venue payment still does not unlock redemption", async () => {
      const { owner, business, staff, customer, progress, purchase } =
        await setUpPurchasedPackage();
      // Balance due is 45_000 - 3_500 = 41_500 — pay less than that.
      await lifecycleService.completeBooking(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(purchase._id),
        { settlement: "PARTIAL", amountCents: 10_000 },
      );

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("unlocks once the origin's venue balance is recorded FULLY paid, then redeems session 2: zero base financials, decrements remainingSessions, appends a SCHEDULED entry", async () => {
      const { business, staff, customer, progress } = await setUpSettledPackage();

      const booking = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      expect(booking.status).toBe("UPCOMING");
      expect(booking.financials.totalCents).toBe(0);
      expect(booking.financials.depositCents).toBe(0);
      const line = booking.serviceLines[0]!;
      expect(line.amountCents).toBe(0);
      expect(line.pricingInput.sessionIndex).toBe(2);
      expect(line.pricingInput.sessionsInPackage).toBe(5);
      expect(String(line.pricingInput.packageProgressId)).toBe(String(progress._id));

      const updated = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(updated.remainingSessions).toBe(3);
      expect(updated.sessions).toHaveLength(2);
      expect(updated.sessions[1]).toMatchObject({ sessionIndex: 2, status: "SCHEDULED" });

      // Never re-runs the base-service deposit calculator (which floors at €5 even for a €0
      // basis) when there are no Add-ons/travel fee — no ledger entry at all.
      const ledger = await financialTransactionService.listForBooking(booking._id);
      expect(ledger).toHaveLength(0);
    });

    it("rejects redemption once no sessions remain, and creates no Booking", async () => {
      const { business, staff, customer, progress } = await setUpSettledPackage();
      // Drain the remaining 4 sessions directly via the atomic primitive (isolates this test
      // from needing 4 real redemption round trips).
      for (let i = 0; i < 4; i += 1) {
        await packageProgressRepository.claimSession(progress._id);
      }
      const drained = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(drained.remainingSessions).toBe(0);

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(
        await BookingModel.countDocuments({
          businessId: business._id,
          _id: { $ne: drained.originBookingId },
        }).exec(),
      ).toBe(0);
    });

    it("re-validates staff eligibility — an unassigned staff member is rejected", async () => {
      const { owner, business, customer, progress } = await setUpSettledPackage();
      const { membership: outsider } = await createStaff(business._id, "outsider");

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(outsider._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      void owner;
    });

    it("stays redeemable while the Service is only INACTIVE (approved rule: existing customers keep access; only new purchases are blocked)", async () => {
      const { business, staff, service, customer, progress } = await setUpSettledPackage();
      await serviceRepository.updateStatusById(business._id, service._id, "INACTIVE");

      const booking = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );
      expect(booking.status).toBe("UPCOMING");

      const updated = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(updated.remainingSessions).toBe(3);

      // But a NEW purchase of the same, now-INACTIVE Service is still blocked.
      const otherCustomer = await createCustomer("newbuyer");
      await saveCard(otherCustomer._id);
      await linkCustomerToBusiness(business._id, service.businessId, otherCustomer._id);
      await expect(
        creationService.finalizePackagePurchase(
          String(otherCustomer._id),
          String(business._id),
          purchaseInput(service._id, staff[0]!.membership._id, DATE_2, "12:00"),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("is blocked once the Service is ARCHIVED", async () => {
      const { business, staff, service, customer, progress } = await setUpSettledPackage();
      await serviceRepository.archiveById(business._id, service._id);

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("two simultaneous redemptions for the LAST remaining session: exactly one succeeds, remainingSessions never goes negative", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness(2);
      const customer = await createCustomer("race");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      const purchase = await creationService.finalizePackagePurchase(
        String(customer._id),
        String(business._id),
        purchaseInput(service._id, staff[0]!.membership._id),
      );
      if (purchase.status !== "confirmed") throw new Error("expected confirmed");
      await settleOriginBalance(owner, business, purchase.booking._id);
      const progress = await PackageProgressModel.findOne({
        originBookingId: purchase.booking._id,
      })
        .orFail()
        .exec();
      // Drain down to exactly ONE remaining session so both concurrent attempts race for it.
      for (let i = 0; i < 3; i += 1) {
        await packageProgressRepository.claimSession(progress._id);
      }

      const preRace = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(preRace.remainingSessions).toBe(1);

      // Two DIFFERENT staff members and DIFFERENT idempotency keys — the only shared, contended
      // resource is the PackageProgress's own remainingSessions counter, never a reservation
      // conflict, isolating the assertion to the session-count race specifically.
      const [outcomeA, outcomeB] = await Promise.allSettled([
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id, DATE_2, "10:00"),
        ),
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[1]!.membership._id, DATE_2, "11:00"),
        ),
      ]);

      const outcomes = [outcomeA, outcomeB];
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });

      const final = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(final.remainingSessions).toBe(0);
      // Session 1 (the purchase) is COMPLETED here, not SCHEDULED — settling its venue balance
      // (the precondition for any redemption at all) already completed it; only the one winning
      // redemption is left SCHEDULED.
      expect(final.sessions.filter((s) => s.status === "SCHEDULED")).toHaveLength(1);
      expect(final.sessions.filter((s) => s.status === "COMPLETED")).toHaveLength(1);
    });

    it("a different Customer cannot find or redeem another Customer's Package (anti-enumeration)", async () => {
      const { business, staff, progress } = await setUpSettledPackage();
      const intruder = await createCustomer("intruder");

      await expect(
        creationService.redeemPackageSession(
          String(intruder._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("a Package is not found when redeemed through a different Business's own scope", async () => {
      const { customer, progress } = await setUpSettledPackage();
      const { business: otherBusiness, staff: otherStaff } = await setupPackageBusiness();

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(otherBusiness._id),
          String(progress._id),
          redeemInput(otherStaff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // --- Add-ons and travel fee on redemption (approved rules) -----------------------------------

  describe("Add-ons and travel fee on redemption", () => {
    it("charges a real, separately-payable deposit for a selected Add-on on an otherwise $0 redemption", async () => {
      const { business, staff, service, customer, progress } = await setUpSettledPackage();
      const addon = await addonRepository.create({
        businessId: business._id,
        status: "ACTIVE",
        name: "Hot towel",
        priceCents: 1_000,
      });
      await addonServiceAssignmentRepository.insertMany([
        { businessId: business._id, addonId: addon._id, serviceId: service._id },
      ]);

      const booking = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        { ...redeemInput(staff[0]!.membership._id), addonIds: [String(addon._id)] },
      );

      const line = booking.serviceLines[0]!;
      expect(line.amountCents).toBe(0); // base session stays $0
      expect(line.addons).toMatchObject([
        { addonId: addon._id, name: "Hot towel", priceCents: 1_000 },
      ]);
      expect(booking.financials.addonsSubtotalCents).toBe(1_000);
      // clamp(20% of 1000, 500, 3500) = 500
      expect(booking.financials.depositCents).toBe(500);

      const ledger = await financialTransactionService.listForBooking(booking._id);
      const debit = ledger.find((e) => e.direction === "DEBIT");
      expect(debit?.amountCents).toBe(500);
      expect(debit?.type).toBe("DEPOSIT"); // never PLATFORM_FEE — redemption is never a "first booking"
    });

    it("rejects an Add-on that is not assigned to the Package's own Service, exactly like a normal booking", async () => {
      const { business, staff, customer, progress } = await setUpSettledPackage();
      const unrelatedAddon = await addonRepository.create({
        businessId: business._id,
        status: "ACTIVE",
        name: "Unrelated",
        priceCents: 500,
      });

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          { ...redeemInput(staff[0]!.membership._id), addonIds: [String(unrelatedAddon._id)] },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("charges the real per-visit travel fee for a TRAVEL_TO_CUSTOMER redemption — never bundled or hardcoded to 0", async () => {
      const { owner, business, staff, service } = await setupTravelPackageBusiness();
      const customer = await createCustomer("travelbuyer");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);

      const travelAddress = {
        city: "Larnaca" as const,
        propertyType: "House" as const,
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      };
      const purchase = await creationService.finalizePackagePurchase(
        String(customer._id),
        String(business._id),
        {
          ...purchaseInput(service._id, staff[0]!.membership._id),
          travelAddress,
          customerCity: "Larnaca",
        },
      );
      if (purchase.status !== "confirmed") throw new Error("expected confirmed purchase");
      await settleOriginBalance(owner, business, purchase.booking._id);
      const progress = await PackageProgressModel.findOne({
        originBookingId: purchase.booking._id,
      })
        .orFail()
        .exec();

      const booking = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        {
          ...redeemInput(staff[0]!.membership._id),
          travelAddress,
          customerCity: "Larnaca",
        },
      );

      expect(booking.financials.travelFeeCents).toBe(1_200);
      expect(booking.financials.totalCents).toBe(1_200);
      // clamp(20% of 0 eligible-basis, 500, 3500) — travel fee is excluded from the deposit
      // basis (same rule as every other booking), but IS included in totalCents/balanceDue.
      expect(booking.financials.depositCents).toBe(500);
      expect(booking.financials.balanceDueCents).toBe(700);
    });
  });

  // --- Cancellation / completion lifecycle hooks ------------------------------------------------

  describe("Package session cancellation and completion", () => {
    it("on-time cancellation of a redeemed session RESTORES it to the balance, no refund attempted", async () => {
      const { business, staff, customer, progress } = await setUpSettledPackage();
      const session2 = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );
      const afterRedeem = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(afterRedeem.remainingSessions).toBe(3);

      const cancelled = await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(session2._id),
        undefined,
      );
      expect(cancelled.status).toBe("CANCELLED_BY_CUSTOMER");

      const afterCancel = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(afterCancel.remainingSessions).toBe(4);
      const entry = afterCancel.sessions.find((s) => String(s.bookingId) === String(session2._id));
      expect(entry?.status).toBe("CANCELLED");

      // The $0 session Booking never had any money to refund.
      const ledger = await financialTransactionService.listForBooking(session2._id);
      expect(ledger.filter((e) => e.type === "REFUND")).toHaveLength(0);
    });

    it("LATE cancellation FORFEITS the session (never restored) and charges no additional Package base-service fee", async () => {
      const { owner, business, staff, customer, progress } = await setUpSettledPackage();
      // Force every tier (all far-future test dates land in MORE_THAN_72_HOURS) to classify as a
      // fee-bearing tier, so cancelByCustomer's own classifier assigns LATE_CANCELLATION.
      await cancellationPolicyRepository.replace(
        business._id,
        cancellationTiers.map((tier) =>
          tier === "MORE_THAN_72_HOURS"
            ? { tier, mode: "PERCENTAGE" as const, percentage: 50 }
            : { tier, mode: "FREE" as const },
        ),
        50,
      );
      const session2 = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      const cancelled = await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(session2._id),
        undefined,
      );
      expect(cancelled.status).toBe("LATE_CANCELLATION");
      // Confirmed rule: "the lost session IS the penalty" — no percentage fee layered on top of
      // a Package base session (amount would otherwise be 50% of a real basis; here it's 0).
      expect(cancelled.cancellationOutcome?.cancellationFeeCents).toBe(0);
      expect(cancelled.cancellationOutcome?.additionalChargeCents).toBe(0);

      const after = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(after.remainingSessions).toBe(3); // NOT restored
      const entry = after.sessions.find((s) => String(s.bookingId) === String(session2._id));
      expect(entry?.status).toBe("FORFEITED");
      void owner;
    });

    it("a genuinely resolved NO_SHOW forfeits the session, with PackageProgress never stuck SCHEDULED", async () => {
      const { owner, business, staff, customer, progress } = await setUpSettledPackage();
      const session2 = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      await lifecycleService.markNoShow(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(session2._id),
      );
      // A Package booking's noShowPercentage is always suppressed (undefined) — nothing
      // chargeable — so the business's own waiveFee resolves it straight to NO_SHOW_WAIVED,
      // exactly like any other no-chargeable-amount case.
      const resolved = await lifecycleService.waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(session2._id),
        "Package session — no additional fee",
        undefined,
      );
      expect(resolved.status).toBe("NO_SHOW_WAIVED");

      const after = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(after.remainingSessions).toBe(3); // NOT restored
      const entry = after.sessions.find((s) => String(s.bookingId) === String(session2._id));
      expect(entry?.status).toBe("FORFEITED");
    });

    it("business-initiated cancellation RESTORES the session (never the customer's fault)", async () => {
      const { owner, business, staff, customer, progress } = await setUpSettledPackage();
      const session2 = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      const cancelled = await lifecycleService.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(session2._id),
        undefined,
      );
      expect(cancelled.status).toBe("CANCELLED_BY_BUSINESS");

      const after = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(after.remainingSessions).toBe(4);
      const entry = after.sessions.find((s) => String(s.bookingId) === String(session2._id));
      expect(entry?.status).toBe("CANCELLED");
    });

    it("completing a redeemed session marks it COMPLETED and increments completedSessions, without touching remainingSessions", async () => {
      const { owner, business, staff, customer, progress } = await setUpSettledPackage();
      const session2 = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      await lifecycleService.completeBooking(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(session2._id),
      );

      const after = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(after.remainingSessions).toBe(3); // unchanged by completion
      // 2, not 1: settling the origin's venue balance (setUpSettledPackage's own precondition
      // for any redemption) already completed session 1, so this is the SECOND completion.
      expect(after.completedSessions).toBe(2);
      const entry = after.sessions.find((s) => String(s.bookingId) === String(session2._id));
      expect(entry?.status).toBe("COMPLETED");
    });

    it("cancelling the original purchase (session 1) also RESTORES it to the balance, same as any other session", async () => {
      const { purchase, customer, progress } = await setUpPurchasedPackage();

      await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(purchase._id),
        undefined,
      );

      const after = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(after.remainingSessions).toBe(5);
      const entry = after.sessions.find((s) => String(s.bookingId) === String(purchase._id));
      expect(entry?.status).toBe("CANCELLED");
    });
  });

  // --- Whole-package refund / void (approved rule) ----------------------------------------------

  describe("voidUnusedPackage — whole-package refund", () => {
    it("refunds and voids a completely unused Package (only the deposit actually collected — never the full bundle price)", async () => {
      const { business, staff, customer, progress, purchase } = await setUpPurchasedPackage();

      const voided = await lifecycleService.voidUnusedPackage(
        String(customer._id),
        String(business._id),
        String(progress._id),
        "Customer changed their mind",
      );
      expect(voided.voidedAt).toBeTruthy();

      const cancelledPurchase = await bookingRepository.findById(business._id, purchase._id);
      expect(cancelledPurchase?.status).toBe("CANCELLED_BY_CUSTOMER");

      const ledger = await financialTransactionService.listForBooking(purchase._id);
      const refund = ledger.find((e) => e.type === "REFUND");
      expect(refund?.amountCents).toBe(3_500); // exactly what was actually charged, not 45_000

      await expect(
        creationService.redeemPackageSession(
          String(customer._id),
          String(business._id),
          String(progress._id),
          redeemInput(staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("rejects voiding once the purchase (origin) session itself has been COMPLETED — settling the venue balance already means 'used', even with every other session still untouched", async () => {
      const { business, customer, progress } = await setUpSettledPackage();

      await expect(
        lifecycleService.voidUnusedPackage(
          String(customer._id),
          String(business._id),
          String(progress._id),
          "Trying to refund after use",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      const untouched = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(untouched.voidedAt).toBeUndefined();
    });

    it("rejects voiding while a redeemed session is still SCHEDULED and unresolved — a defensive guard for a state the current settlement-gated flow cannot yet reach through the public API, exercised here directly against the repository", async () => {
      const { business, customer, progress } = await setUpPurchasedPackage();
      // Simulate "a second session got scheduled" directly via the same atomic primitives
      // redeemPackageSession itself uses — bypassing the settlement gate on purpose, since this
      // guard exists for defense-in-depth against exactly that kind of future/edge state, not
      // something today's redemption flow can produce (redemption requires the origin to already
      // be COMPLETED, which would independently fail the "everUsed" check first).
      const claimed = await packageProgressRepository.claimSession(progress._id);
      await packageProgressRepository.recordScheduledSession(
        progress._id,
        claimed!.totalSessions - claimed!.remainingSessions,
        new Types.ObjectId(),
      );

      await expect(
        lifecycleService.voidUnusedPackage(
          String(customer._id),
          String(business._id),
          String(progress._id),
          "Too early",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("an on-time-cancelled-and-restored purchase session does NOT by itself count as 'used' — void still succeeds even after a prior cancel/restore", async () => {
      const { business, customer, progress, purchase } = await setUpPurchasedPackage();

      // First cancellation restores the session (on-time, no policy configured -> FREE).
      await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(purchase._id),
        undefined,
      );
      const afterCancel = await PackageProgressModel.findById(progress._id).orFail().exec();
      expect(afterCancel.remainingSessions).toBe(5);
      expect(afterCancel.sessions[0]?.status).toBe("CANCELLED");

      // Nothing left SCHEDULED (the only session was just restored) and nothing ever
      // COMPLETED/FORFEITED — voidUnusedPackage's own origin-still-UPCOMING branch is a no-op
      // here (status is already CANCELLED_BY_CUSTOMER, not UPCOMING) and eligibility still holds.
      const voided = await lifecycleService.voidUnusedPackage(
        String(customer._id),
        String(business._id),
        String(progress._id),
        "Still unused",
      );
      expect(voided.voidedAt).toBeTruthy();
    });

    it("rejects voiding an already-voided Package (no double refund)", async () => {
      const { business, customer, progress } = await setUpPurchasedPackage();
      await lifecycleService.voidUnusedPackage(
        String(customer._id),
        String(business._id),
        String(progress._id),
        "First void",
      );

      await expect(
        lifecycleService.voidUnusedPackage(
          String(customer._id),
          String(business._id),
          String(progress._id),
          "Second void attempt",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // --- Snapshot vs live purchase terms (approved rule) -------------------------------------------

  describe("Purchased Package terms are snapshotted; operational availability stays live", () => {
    it("a redeemed session keeps the PURCHASED duration even after the live Service duration is later edited", async () => {
      const { business, staff, service, customer, progress } = await setUpSettledPackage();
      expect(progress.purchaseSnapshot.durationMin).toBe(60);

      await ServiceModel.updateOne(
        { _id: service._id, businessId: business._id },
        { $set: { "packagePricing.durationMin": 90 } },
      ).exec();

      const booking = await redeemConfirmed(
        String(customer._id),
        String(business._id),
        String(progress._id),
        redeemInput(staff[0]!.membership._id),
      );

      expect(booking.serviceLines[0]!.serviceSnapshot.durationMin).toBe(60);
      const scheduledMinutes =
        (booking.schedule.endAt.getTime() - booking.schedule.startAt.getTime()) / 60_000;
      expect(scheduledMinutes).toBe(60);
    });
  });

  // --- Regression: the normal booking guard stays intact ----------------------------------------

  describe("Normal booking flow still rejects Package Deal services (guard unchanged)", () => {
    it("previewCustomerBooking, finalizeCustomerBooking, and createManualBooking all reject a Package Deal service", async () => {
      const { owner, business, staff, service } = await setupPackageBusiness();
      const customer = await createCustomer("guard");
      await saveCard(customer._id);
      const client = await linkCustomerToBusiness(business._id, owner._id, customer._id);

      await expect(
        creationService.previewCustomerBooking(
          String(customer._id),
          String(business._id),
          purchaseInput(service._id, staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      await expect(
        creationService.finalizeCustomerBooking(
          String(customer._id),
          String(business._id),
          purchaseInput(service._id, staff[0]!.membership._id),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      await expect(
        creationService.createManualBooking(
          String(owner._id),
          "BUSINESS_OWNER",
          String(business._id),
          {
            ...purchaseInput(service._id, staff[0]!.membership._id),
            businessClientId: String(client._id),
          },
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(await BookingModel.countDocuments({ businessId: business._id }).exec()).toBe(0);
    });
  });
});
