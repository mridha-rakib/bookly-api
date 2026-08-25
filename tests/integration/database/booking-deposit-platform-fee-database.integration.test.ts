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
import { NoShowResolutionService } from "../../../src/modules/booking/no-show-resolution.service.js";
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

describe("database-backed Booking DEPOSIT vs PLATFORM FEE correction (Batch 6.5)", () => {
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
  let noShowService: NoShowResolutionService;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;

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

  // --- Fixtures --------------------------------------------------------------------------------

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
    await clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Test",
      lastName: "Customer",
      normalizedEmail: user?.normalizedEmail ?? `linked-${customerId.toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
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
    const { owner, business } = await createBusiness(
      `owner-${new Types.ObjectId().toString()}@example.com`,
      "Salon A",
    );
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

  // --- Deposit clamp bounds (spec examples) ----------------------------------------------------

  it("deposit clamps: €10 -> €5, €100 -> €20, €2,000 -> €35", () => {
    expect(bookingService.calculateBookingDepositCents(1000)).toBe(500);
    expect(bookingService.calculateBookingDepositCents(10_000)).toBe(2000);
    expect(bookingService.calculateBookingDepositCents(200_000)).toBe(3500);
  });

  // --- Travel fee exclusion ---------------------------------------------------------------------

  it("travel fee is excluded from the deposit/platform-fee basis (AT_BUSINESS_LOCATION has none to test against, so this asserts eligiblePlatformFeeBasisCents never includes it structurally)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("travel");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.financials.travelFeeCents).toBe(0);
    expect(result.booking.financials.eligiblePlatformFeeBasisCents).toBe(10_000);
    expect(result.booking.financials.depositCents).toBe(2000);
  });

  // --- Returning customer: cancellation-fee netting against the DEPOSIT ledger type ------------

  it("returning customer's late cancellation nets the fee against the DEPOSIT-ledgered amount (not platformFeeCents)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(40),
      100,
    );
    const customer = await createCustomer("cancel-returning");
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
    expect(second.booking.financials.depositCents).toBe(2000);

    // Force the second booking's schedule inside the UNDER_2_HOURS window.
    await BookingModel.updateOne(
      { _id: second.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();

    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(second.booking._id),
      "Can't make it",
    );
    expect(cancelled.status).toBe("LATE_CANCELLATION");
    // €100 basis * 40% = €40 gross fee. €20 already collected as DEPOSIT (not PLATFORM_FEE) ->
    // €20 additional charge.
    expect(cancelled.cancellationOutcome?.cancellationFeeCents).toBe(4000);
    expect(cancelled.cancellationOutcome?.depositAppliedCents).toBe(2000);
    expect(cancelled.cancellationOutcome?.additionalChargeCents).toBe(2000);
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("SUCCEEDED");

    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const cancellationFeeEntry = ledger.find((entry) => entry.type === "CANCELLATION_FEE");
    expect(cancellationFeeEntry?.amountCents).toBe(2000);
    expect(cancellationFeeEntry?.status).toBe("SUCCEEDED");
  });

  // --- Returning customer: no-show netting against the DEPOSIT ledger type ----------------------

  it("returning customer's no-show worker nets the fee against the DEPOSIT-ledgered amount", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(20),
      100,
    );
    const customer = await createCustomer("noshow-returning");
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
    expect(second.booking.financials.depositCents).toBe(2000);

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

    const outcome = await noShowService.autoResolve(second.booking._id);
    expect(outcome).toBe("charged");

    // €100 no-show obligation (100%) minus the €20 already-collected DEPOSIT -> €80 additional.
    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const noShowEntry = ledger.find((entry) => entry.type === "NO_SHOW_FEE");
    expect(noShowEntry?.amountCents).toBe(8000);
    expect(noShowEntry?.status).toBe("SUCCEEDED");
  });

  // --- Business cancellation refunds a RETURNING customer's DEPOSIT (the bug this batch fixes) --

  it("business cancellation refunds a returning customer's DEPOSIT-ledgered amount (previously invisible when only PLATFORM_FEE was searched)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("business-cancel-returning");
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
    expect(second.booking.financials.depositCents).toBe(2000);

    const cancelled = await lifecycleService.cancelByBusiness(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
      "Staff emergency",
    );

    expect(cancelled.status).toBe("CANCELLED_BY_BUSINESS");
    expect(cancelled.cancellationOutcome?.refundOwedCents).toBe(2000);
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("SUCCEEDED");

    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const refundEntries = ledger.filter((entry) => entry.type === "REFUND");
    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0]?.status).toBe("SUCCEEDED");
    expect(refundEntries[0]?.amountCents).toBe(2000);
  });

  // --- Concurrency: two concurrent finalize calls for the SAME first-time customer+business -----

  it("[race] concurrent first-booking finalize attempts: exactly one gets platformFeeCents, the other still gets a real Business-owned deposit", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("race");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

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

    const confirmed = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<typeof creationService.finalizeCustomerBooking>>
        > => r.status === "fulfilled" && r.value.status === "confirmed",
      )
      .map((r) => r.value);

    // Both are genuinely different bookings (different requested times) — both should succeed.
    expect(confirmed).toHaveLength(2);

    const platformFeeBookings = confirmed.filter(
      (r) => r.status === "confirmed" && r.booking.financials.platformFeeCents > 0,
    );
    const depositOnlyBookings = confirmed.filter(
      (r) => r.status === "confirmed" && r.booking.financials.platformFeeCents === 0,
    );

    // Exactly ONE of the two concurrent bookings may economically be "first" — never both,
    // never neither (the CAS-gated markActivated result is authoritative, not the pre-charge
    // read).
    expect(platformFeeBookings).toHaveLength(1);
    expect(depositOnlyBookings).toHaveLength(1);

    // The "losing" booking still charged a REAL deposit online — never €0 — and that deposit is
    // ledgered as DEPOSIT (Business-owned), never silently dropped or double-counted as
    // platform revenue.
    for (const r of depositOnlyBookings) {
      if (r.status !== "confirmed") continue;
      expect(r.booking.financials.depositCents).toBe(2000);
      const ledger = await financialTransactionService.listForBooking(r.booking._id);
      const depositEntry = ledger.find((entry) => entry.type === "DEPOSIT");
      expect(depositEntry?.status).toBe("SUCCEEDED");
      expect(depositEntry?.amountCents).toBe(2000);
    }
    for (const r of platformFeeBookings) {
      if (r.status !== "confirmed") continue;
      const ledger = await financialTransactionService.listForBooking(r.booking._id);
      const platformFeeEntry = ledger.find((entry) => entry.type === "PLATFORM_FEE");
      expect(platformFeeEntry?.status).toBe("SUCCEEDED");
      expect(platformFeeEntry?.amountCents).toBe(2000);
    }

    // Exactly one BusinessClient activation happened, attributed to whichever booking actually
    // won it.
    const client = await clientRepository.findByBusinessIdAndLinkedUserId(
      business._id,
      customer._id,
    );
    expect(client?.activatedAt).toBeDefined();
    const winnerId = String(client?.activatedByBookingId);
    const winner = platformFeeBookings.find(
      (r) => r.status === "confirmed" && String(r.booking._id) === winnerId,
    );
    expect(winner).toBeDefined();
  });

  // --- Waived returning no-show never charges later (nets against DEPOSIT correctly) -----------

  it("a waived returning-customer no-show correctly nets against the DEPOSIT ledger entry and never charges later", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      percentageNoShowAndCancellationPolicy(20),
      100,
    );
    const customer = await createCustomer("waive-returning");
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

    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
    );

    const waived = await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
      "Customer called ahead",
      undefined,
    );
    expect(waived.status).toBe("NO_SHOW_WAIVED");

    // €100 obligation - €20 already-collected DEPOSIT = €80 waived (not €100 — proves the
    // waiver also nets against the DEPOSIT-typed ledger entry, not just PLATFORM_FEE).
    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const noShowEntry = ledger.find((entry) => entry.type === "NO_SHOW_FEE");
    expect(noShowEntry?.status).toBe("WAIVED");
    expect(noShowEntry?.amountCents).toBe(8000);

    // The worker must never later charge a waived obligation.
    await BookingModel.updateOne(
      { _id: second.booking._id },
      { $set: { status: "PENDING", noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();
    const outcome = await noShowService.autoResolve(second.booking._id);
    expect(outcome).toBe("skipped_already_resolved");
    const ledgerAfter = await financialTransactionService.listForBooking(second.booking._id);
    expect(ledgerAfter.filter((entry) => entry.type === "NO_SHOW_FEE")).toHaveLength(1);
  });

  // --- MANUAL invariants remain untouched --------------------------------------------------------

  it("MANUAL booking remains depositCents=0/platformFeeCents=0 and makes zero payment-gateway calls", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const client = await clientRepository.create({
      businessId: business._id,
      createdByUserId: owner._id,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99887766", e164: "+35799887766" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });

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

    expect(booking.financials.depositCents).toBe(0);
    expect(booking.financials.platformFeeCents).toBe(0);
    const ledger = await financialTransactionService.listForBooking(booking._id);
    expect(ledger).toHaveLength(0);
  });
});
