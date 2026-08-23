import mongoose, { Types } from "mongoose";
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
import { NoShowResolutionService } from "../../../src/modules/booking/no-show-resolution.service.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { FinanceError } from "../../../src/modules/finance/finance.errors.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
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
const DATE = "2026-08-25"; // a Tuesday, safely in the future relative to any real "now"

describe("database-backed Business Finance (Batch 7)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
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
  let noShowService: NoShowResolutionService;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
  let financeService: FinanceService;
  let businessPayoutRepository: BusinessPayoutRepository;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
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
    businessPayoutRepository = new BusinessPayoutRepository();
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      businessPayoutRepository,
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

    noShowService = new NoShowResolutionService(
      bookingRepository,
      businessRepository,
      paymentService,
      financialTransactionService,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures (mirrors booking-deposit-platform-fee-database.integration.test.ts) -------------

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
    priceCents = 10_000,
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
    // Unique per customer within a business (businessId+phone.e164 is a unique index) — derived
    // from the customer's own id so parallel/multi-customer fixtures in the same test never
    // collide.
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
    await clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Test",
      lastName: "Customer",
      normalizedEmail: user?.normalizedEmail ?? `linked-${customerId.toString()}@example.com`,
      phone: {
        countryCode: "+357",
        nationalNumber,
        e164: `+357${nationalNumber}`,
      },
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

  const setupBookableBusiness = async (priceCents = 10_000) => {
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

  const percentageNoShowAndCancellationPolicy = (percentage: number) => [
    { tier: "MORE_THAN_72_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_24_AND_72_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_12_AND_24_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_2_AND_12_HOURS" as const, mode: "FREE" as const },
    { tier: "UNDER_2_HOURS" as const, mode: "PERCENTAGE" as const, percentage },
  ];

  // Ledger `createdAt` is real wall-clock "now" (the fictional `DATE` above only controls the
  // Booking's own `schedule.startAt`) — bounded to `MAX_BUSINESS_LEDGER_RANGE_DAYS` (92), unlike
  // a real calendar year, per BookingFinancialTransactionService.requireBoundedRange.
  const around = () => ({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  // --- Fee-recovery summary: cancellation + no-show -----------------------------------------------

  it("counts a returning customer's settled late-cancellation fee as Business payout, excludes PLATFORM_FEE/DEPOSIT", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(40),
      100,
    );
    const customer = await createCustomer("cancel-summary");
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

    await BookingModel.updateOne(
      { _id: second.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();
    await lifecycleService.cancelByCustomer(String(customer._id), String(second.booking._id), "x");

    const summary = await financeService.getSummary(
      String(owner._id),
      String(business._id),
      around(),
    );
    expect(summary.currency).toBe("EUR");
    // Additional charge only (gross €40 - €20 already-collected DEPOSIT = €20) — see
    // finance.types.ts's own ownership-matrix comment.
    expect(summary.lateCancellationFees).toEqual({ amountCents: 2000, count: 1 });
    expect(summary.noShowFees).toEqual({ amountCents: 0, count: 0 });
    expect(summary.netPayoutCents).toBe(2000);
    expect(summary.protectedEarningsAllTimeCents).toBe(2000);

    // The FIRST booking's own PLATFORM_FEE (Bookly revenue) must never leak into this figure.
    const ledger = await financialTransactionService.listForBooking(first.booking._id);
    expect(ledger.find((e) => e.type === "PLATFORM_FEE")).toBeDefined();
  });

  it("a waived no-show contributes €0 to payout, appears in the transaction list as WAIVED", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(20),
      100,
    );
    const customer = await createCustomer("waive-summary");
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

    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
    );
    await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
      "Called ahead",
      undefined,
    );

    const summary = await financeService.getSummary(
      String(owner._id),
      String(business._id),
      around(),
    );
    expect(summary.noShowFees).toEqual({ amountCents: 0, count: 0 });
    expect(summary.protectedEarningsAllTimeCents).toBe(0);

    const page = await financeService.listTransactions(
      String(owner._id),
      String(business._id),
      around(),
      {
        page: 1,
        limit: 20,
      },
    );
    const row = page.rows.find((r) => r.bookingId === String(second.booking._id));
    expect(row?.status).toBe("WAIVED");
    expect(row?.businessOwnedCents).toBe(0);
    expect(row?.customerType).toBe("RETURNING");
  });

  it("a failed no-show charge contributes €0 to payout", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(20),
      100,
    );
    const customer = await createCustomer("failed-summary");
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

    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
    );
    await BookingModel.updateOne(
      { _id: second.booking._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();

    paymentGateway.queueNextChargeOutcome("failed");
    const outcome = await noShowService.autoResolve(second.booking._id);
    expect(outcome).toBe("skipped_already_resolved");

    const summary = await financeService.getSummary(
      String(owner._id),
      String(business._id),
      around(),
    );
    expect(summary.noShowFees).toEqual({ amountCents: 0, count: 0 });

    const page = await financeService.listTransactions(
      String(owner._id),
      String(business._id),
      around(),
      {
        page: 1,
        limit: 20,
      },
    );
    const row = page.rows.find((r) => r.bookingId === String(second.booking._id));
    expect(row?.status).toBe("FAILED");
    expect(row?.businessOwnedCents).toBe(0);
  });

  // --- First/Returning label uses domain truth, not inference from the fee row alone -------------

  it("labels a first-booking customer's cancellation-fee row FIRST_BOOKING using Booking.financials.platformFeeCents, not the fee type", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(20_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(90),
      100,
    );
    const customer = await createCustomer("first-cancel");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const booking = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (booking.status !== "confirmed") throw new Error("expected confirmed");
    expect(booking.booking.financials.platformFeeCents).toBeGreaterThan(0);

    await BookingModel.updateOne(
      { _id: booking.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();
    await lifecycleService.cancelByCustomer(String(customer._id), String(booking.booking._id), "x");

    const page = await financeService.listTransactions(
      String(owner._id),
      String(business._id),
      around(),
      {
        page: 1,
        limit: 20,
      },
    );
    const row = page.rows.find((r) => r.bookingId === String(booking.booking._id));
    expect(row?.customerType).toBe("FIRST_BOOKING");
    expect(row?.bookingReference).toBe(booking.booking.reference);
  });

  // --- Pagination ------------------------------------------------------------------------------

  it("paginates the transaction breakdown", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(40),
      100,
    );

    // Three distinct returning customers, each with a late-cancellation fee. Non-overlapping
    // (activation, cancel) time pairs — all three share the same staff member.
    const slotPairs: Array<[string, string]> = [
      ["09:00", "10:00"],
      ["11:00", "12:00"],
      ["13:00", "14:00"],
    ];
    for (const [activationTime, cancelTime] of slotPairs) {
      const customer = await createCustomer(`page-${activationTime}`);
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      const activation = await creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, activationTime),
      );
      if (activation.status !== "confirmed") throw new Error("expected confirmed");

      const second = await creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, cancelTime),
      );
      if (second.status !== "confirmed") throw new Error("expected confirmed");
      await BookingModel.updateOne(
        { _id: second.booking._id },
        { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
      ).exec();
      await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(second.booking._id),
        "x",
      );
    }

    const pageOne = await financeService.listTransactions(
      String(owner._id),
      String(business._id),
      around(),
      { page: 1, limit: 2 },
    );
    expect(pageOne.rows).toHaveLength(2);
    expect(pageOne.total).toBe(3);

    const pageTwo = await financeService.listTransactions(
      String(owner._id),
      String(business._id),
      around(),
      { page: 2, limit: 2 },
    );
    expect(pageTwo.rows).toHaveLength(1);
  });

  // --- Business isolation ------------------------------------------------------------------------

  it("never leaks another Business's fee transactions into this Business's summary/transactions", async () => {
    const a = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      a.business._id,
      percentageNoShowAndCancellationPolicy(40),
      100,
    );
    const b = await setupBookableBusiness(10_000);

    const customer = await createCustomer("isolation");
    await saveCard(customer._id);
    await linkCustomerToBusiness(a.business._id, a.owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(a.business._id),
      finalizeInput(a.service._id, a.membership._id, "10:00"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");
    const second = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(a.business._id),
      finalizeInput(a.service._id, a.membership._id, "14:00"),
    );
    if (second.status !== "confirmed") throw new Error("expected confirmed");
    await BookingModel.updateOne(
      { _id: second.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();
    await lifecycleService.cancelByCustomer(String(customer._id), String(second.booking._id), "x");

    const summaryA = await financeService.getSummary(
      String(a.owner._id),
      String(a.business._id),
      around(),
    );
    const summaryB = await financeService.getSummary(
      String(b.owner._id),
      String(b.business._id),
      around(),
    );
    expect(summaryA.lateCancellationFees.amountCents).toBeGreaterThan(0);
    expect(summaryB.lateCancellationFees).toEqual({ amountCents: 0, count: 0 });
    expect(summaryB.protectedEarningsAllTimeCents).toBe(0);
  });

  // --- Authorization: Owner-only, anti-enumeration -----------------------------------------------

  it("denies a Business's own Supervisor (BusinessAccess) with the same not-found error as a stranger", async () => {
    const { business } = await setupBookableBusiness(10_000);
    const supervisor = await userRepository.create({
      normalizedEmail: `supervisor-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });
    // Linked/secondary access to the SAME business — must still be denied (rule #28: linked
    // BusinessAccess must never accidentally grant Finance access).
    await businessAccessRepository.create({ userId: supervisor._id, businessId: business._id });

    await expect(
      financeService.getSummary(String(supervisor._id), String(business._id), around()),
    ).rejects.toThrow(FinanceError);
  });

  it("denies a Staff member of the business", async () => {
    const { business, membership } = await setupBookableBusiness(10_000);
    await expect(
      financeService.getSummary(String(membership.userId), String(business._id), around()),
    ).rejects.toThrow(FinanceError);
  });

  it("denies access with the SAME error whether the businessId belongs to someone else or does not exist at all", async () => {
    const ownerA = await createBusiness("Salon A");
    const ownerB = await createBusiness("Salon B");

    let errorForOtherOwnersBusiness: unknown;
    try {
      await financeService.getSummary(
        String(ownerA.owner._id),
        String(ownerB.business._id),
        around(),
      );
    } catch (error) {
      errorForOtherOwnersBusiness = error;
    }

    let errorForNonexistentBusiness: unknown;
    try {
      await financeService.getSummary(
        String(ownerA.owner._id),
        String(new Types.ObjectId()),
        around(),
      );
    } catch (error) {
      errorForNonexistentBusiness = error;
    }

    expect(errorForOtherOwnersBusiness).toBeInstanceOf(FinanceError);
    expect(errorForNonexistentBusiness).toBeInstanceOf(FinanceError);
    expect((errorForOtherOwnersBusiness as FinanceError).statusCode).toBe(404);
    expect((errorForOtherOwnersBusiness as FinanceError).message).toBe(
      (errorForNonexistentBusiness as FinanceError).message,
    );
  });

  // --- Payout history: honest empty state, no fabricated "Paid" rows ------------------------------

  it("returns an honest empty payout history for a Business with no real payout records", async () => {
    const { owner, business } = await setupBookableBusiness(10_000);
    const page = await financeService.listPayoutHistory(String(owner._id), String(business._id), {
      page: 1,
      limit: 20,
    });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("BusinessPayoutRepository can create and list a real payout record once one exists", async () => {
    const { owner, business } = await setupBookableBusiness(10_000);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await businessPayoutRepository.create(
          {
            businessId: business._id,
            periodStart: new Date("2026-04-01T00:00:00.000Z"),
            periodEnd: new Date("2026-05-01T00:00:00.000Z"),
            grossBusinessOwnedCents: 10_000,
            processingFeesCents: 300,
            refundsCents: 0,
            netPayoutCents: 9700,
            currency: "EUR",
            status: "PAID",
            settledTransactionIds: [new Types.ObjectId()],
            initiatedByUserId: owner._id,
            paidAt: new Date("2026-05-01T00:00:00.000Z"),
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    const { items, total } = await businessPayoutRepository.listByBusinessId({
      businessId: business._id,
      page: 1,
      limit: 20,
    });
    expect(total).toBe(1);
    expect(items[0]?.status).toBe("PAID");
    expect(items[0]?.netPayoutCents).toBe(9700);
  });

  // --- Range validation reused from BookingFinancialTransactionService --------------------------

  it("rejects an inverted period range", async () => {
    const { owner, business } = await setupBookableBusiness(10_000);
    await expect(
      financeService.getSummary(String(owner._id), String(business._id), {
        from: new Date("2026-06-01T00:00:00.000Z"),
        to: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });
});
