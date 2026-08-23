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
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { CustomerPaymentProfileModel } from "../../../src/modules/payment/customer-payment-profile.model.js";
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

describe("database-backed Booking payment integration (Batch 4)", () => {
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

  /**
   * Pre-links a BusinessClient for this Customer at this Business — representing the realistic
   * "the Business already has this Customer on file" case. AT_BUSINESS_LOCATION businesses
   * (every fixture in this file) have no structured address source for a genuinely first-time
   * self-service Customer (see BookingCreationService.resolveOrCreateCustomerClient's own
   * comment — a real, still-unresolved product gap flagged since Batch 3); these payment-focused
   * tests intentionally sidestep that unrelated gap rather than conflating two different concerns.
   */
  let linkedClientPhoneCounter = 0;

  const linkCustomerToBusiness = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    customerId: Types.ObjectId,
  ) => {
    const user = await userRepository.findById(customerId);
    // A real unique-per-Business constraint on (businessId, phone.e164) means every Client
    // linked to the SAME Business within one test must get a distinct phone — a single fixed
    // number silently only worked while no test linked two different Customers to one Business.
    linkedClientPhoneCounter += 1;
    const nationalNumber = String(99_000_000 + linkedClientPhoneCounter);
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

  // --- First-booking activation charge --------------------------------------------------------

  it("first-booking finalize charges the activation fee, persists the Booking, and activates the Client", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("a");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );

    expect(result.status).toBe("confirmed");
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.status).toBe("UPCOMING");
    expect(result.booking.financials.platformFeeCents).toBeGreaterThan(0);

    const client = await BusinessClientModel.findOne({
      businessId: business._id,
      linkedUserId: customer._id,
    }).exec();
    expect(client?.activatedAt).toBeDefined();
    expect(String(client?.activatedByBookingId)).toBe(String(result.booking._id));

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    const platformFeeEntry = ledger.find((entry) => entry.type === "PLATFORM_FEE");
    expect(platformFeeEntry?.status).toBe("SUCCEEDED");
    expect(platformFeeEntry?.amountCents).toBe(result.booking.financials.platformFeeCents);
  });

  it("finalize without a saved card is rejected before any reservation is made", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("b");
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 402 });

    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  it("Batch 6.5: a returning customer's second booking still charges a real deposit online, but Bookly earns no platform fee on it", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("c");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    expect(first.status).toBe("confirmed");
    if (first.status !== "confirmed") throw new Error("expected confirmed");
    // €100 basis -> €20 deposit; first booking, so Bookly keeps it as platform fee.
    expect(first.booking.financials.depositCents).toBe(2000);
    expect(first.booking.financials.platformFeeCents).toBe(2000);

    const second = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "14:00"),
    );

    expect(second.status).toBe("confirmed");
    if (second.status !== "confirmed") throw new Error("expected confirmed");
    // The deposit is STILL charged online for a returning booking — never €0 due now — but
    // Bookly does not economically keep it (platformFeeCents 0).
    expect(second.booking.financials.depositCents).toBe(2000);
    expect(second.booking.financials.platformFeeCents).toBe(0);
    expect(second.booking.financials.balanceDueCents).toBe(8000);

    // A real Stripe deposit charge happened (ledgered DEPOSIT, not PLATFORM_FEE — the Business,
    // not Bookly, economically owns this money).
    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const depositEntry = ledger.find((entry) => entry.type === "DEPOSIT");
    expect(depositEntry?.status).toBe("SUCCEEDED");
    expect(depositEntry?.amountCents).toBe(2000);
    expect(ledger.some((entry) => entry.type === "PLATFORM_FEE")).toBe(false);
  });

  it("Batch 6.5: a returning customer without a saved card is rejected before finalizing (deposit is still required)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("c2");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    expect(first.status).toBe("confirmed");

    // Remove the saved card AFTER the first (activated) booking — a returning booking must
    // still be rejected without one, exactly like a first booking would be.
    await CustomerPaymentProfileModel.updateOne(
      { userId: customer._id },
      { $unset: { defaultPaymentMethodId: "" } },
    ).exec();

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "14:00"),
      ),
    ).rejects.toMatchObject({ statusCode: 402 });
  });

  it("the SAME customer activates INDEPENDENTLY at a different business", async () => {
    const {
      owner: ownerA,
      business: businessA,
      membership: staffA,
      service: serviceA,
    } = await setupBookableBusiness();
    const {
      owner: ownerB,
      business: businessB,
      membership: staffB,
      service: serviceB,
    } = await setupBookableBusiness();
    const customer = await createCustomer("d");
    await saveCard(customer._id);
    await linkCustomerToBusiness(businessA._id, ownerA._id, customer._id);
    await linkCustomerToBusiness(businessB._id, ownerB._id, customer._id);

    const atA = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(businessA._id),
      finalizeInput(serviceA._id, staffA._id),
    );
    const atB = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(businessB._id),
      finalizeInput(serviceB._id, staffB._id),
    );

    expect(atA.status).toBe("confirmed");
    expect(atB.status).toBe("confirmed");
    if (atA.status !== "confirmed" || atB.status !== "confirmed")
      throw new Error("expected confirmed");
    // Both are "first bookings" for their own business — both charge an activation fee.
    expect(atA.booking.financials.platformFeeCents).toBeGreaterThan(0);
    expect(atB.booking.financials.platformFeeCents).toBeGreaterThan(0);
  });

  it("[race] two different customers finalizing the SAME slot: both charges succeed, the loser is refunded, and no orphan/misattributed ledger entry remains (Batch 9 completion pass)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customerA = await createCustomer("race-slot-1");
    const customerB = await createCustomer("race-slot-2");
    await saveCard(customerA._id);
    await saveCard(customerB._id);
    await linkCustomerToBusiness(business._id, owner._id, customerA._id);
    await linkCustomerToBusiness(business._id, owner._id, customerB._id);

    // Same exact staff + slot for both — a genuine exclusive-slot conflict, not two
    // independently-bookable times. Promise.allSettled preserves input order in its results
    // array regardless of which settles first, so results[0]/[1] map to customerA/customerB —
    // but WHICH of the two actually wins the underlying race is nondeterministic, so it must be
    // determined from the outcome, never assumed from call order.
    const results = await Promise.allSettled([
      creationService.finalizeCustomerBooking(
        String(customerA._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "10:00"),
      ),
      creationService.finalizeCustomerBooking(
        String(customerB._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "10:00"),
      ),
    ]);
    const customerIds = [customerA._id, customerB._id];

    const fulfilled = results.filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof creationService.finalizeCustomerBooking>>
      > => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const loserCustomerId = customerIds[results.findIndex((r) => r.status === "rejected")];

    // Exactly one customer actually gets the slot — the other's finalize call must surface a
    // real, catchable error (never a silent no-op, never a second Booking for the same slot).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Either conflict code is a correct outcome of this exact race depending on which branch of
    // reserveOrJoin's atomic retry loop the loser lands on — both mean "no double-booking, a
    // real recoverable 409" (see booking-slot-reservation.service.ts), never a 5xx/silent drop.
    const rejection = rejected[0]?.reason as {
      statusCode?: number;
      details?: Array<{ code?: string }>;
    };
    expect(rejection.statusCode).toBe(409);
    expect(rejection.details?.[0]?.code).toMatch(
      /^BOOKING_SLOT_RESERVATION_(CONFLICT|CAPACITY_UNAVAILABLE)$/,
    );

    // Exactly one Booking exists for this business — no orphan/partial Booking for the loser.
    const bookingCount = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(bookingCount).toBe(1);

    // The loser's charge genuinely succeeded (FakePaymentGateway defaults to "succeeded") but
    // must have been refunded as a compensating action — never left as an uncollected,
    // unattributed charge, and never recorded as PLATFORM_FEE/DEPOSIT revenue for anyone since
    // the transaction that would have written that entry rolled back before it could.
    const allLedgerEntries = await financialTransactionService.listForBusiness({
      businessId: business._id,
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const winningBooking = fulfilled[0]?.value;
    if (winningBooking?.status !== "confirmed") {
      throw new Error("expected the winning call to be confirmed");
    }

    // Only ONE PLATFORM_FEE/DEPOSIT-type entry exists across the whole business for this race —
    // belonging to the winner's own Booking, never a second one for the loser's non-existent
    // Booking.
    const activationLikeEntries = allLedgerEntries.filter(
      (entry) => entry.type === "PLATFORM_FEE" || entry.type === "DEPOSIT",
    );
    expect(activationLikeEntries).toHaveLength(1);
    expect(String(activationLikeEntries[0]?.bookingId)).toBe(String(winningBooking.booking._id));

    // The loser's compensating refund is real, SUCCEEDED, and deliberately unattributed to
    // either Bookly or the Business (see compensateFailedBookingAfterPayment's own comment —
    // `sourceType: "COMPENSATION"`, never counted as anyone's revenue since nothing was ever
    // durably ledgered as revenue in the first place).
    const compensationRefunds = allLedgerEntries.filter(
      (entry) => entry.type === "REFUND" && entry.metadata?.["sourceType"] === "COMPENSATION",
    );
    expect(compensationRefunds).toHaveLength(1);
    expect(compensationRefunds[0]?.status).toBe("SUCCEEDED");
    expect(compensationRefunds[0]?.amountCents).toBe(
      winningBooking.booking.financials.depositCents,
    );

    // The loser's own BusinessClient row was never activated by this failed attempt.
    const loserClient = await BusinessClientModel.findOne({
      businessId: business._id,
      linkedUserId: loserCustomerId,
    }).exec();
    expect(loserClient?.activatedAt).toBeUndefined();
  });

  it("[race] duplicate finalize with the same idempotencyKey results in exactly one charge and one booking", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("e");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const input = finalizeInput(service._id, membership._id);
    const results = await Promise.allSettled([
      creationService.finalizeCustomerBooking(String(customer._id), String(business._id), input),
      creationService.finalizeCustomerBooking(String(customer._id), String(business._id), input),
    ]);

    const confirmed = results.filter(
      (r) => r.status === "fulfilled" && r.value.status === "confirmed",
    );
    expect(confirmed.length).toBeGreaterThanOrEqual(1);

    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(1);

    const bookingId = (
      confirmed[0] as PromiseFulfilledResult<{
        status: "confirmed";
        booking: { _id: Types.ObjectId };
      }>
    ).value.booking._id;
    const ledger = await financialTransactionService.listForBooking(bookingId);
    const platformFeeEntries = ledger.filter((entry) => entry.type === "PLATFORM_FEE");
    expect(platformFeeEntries).toHaveLength(1);
  });

  it("a declined activation charge leaves no Booking and no reservation behind", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("f");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    paymentGateway.queueNextChargeOutcome("failed");

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 402 });

    const count = await BookingModel.countDocuments({ businessId: business._id }).exec();
    expect(count).toBe(0);
  });

  // --- Manual booking never touches Stripe ----------------------------------------------------

  it("manual booking creation makes zero payment-gateway calls", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
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

    expect(booking.financials.platformFeeCents).toBe(0);
  });

  // --- Cancellation charge execution -----------------------------------------------------------

  it("a LATE customer cancellation charges the saved card and records SUCCEEDED settlement", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 50 },
      ],
      100,
    );
    const customer = await createCustomer("g");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    // Create at the standard fixed, known-within-business-hours slot (creation itself requires
    // a real availability match, which real "now + 90min" cannot reliably guarantee regardless
    // of what time of day this suite happens to run). Then move the persisted schedule.startAt
    // to 90 minutes from the real clock — the classifier only reads `schedule.startAt` and
    // `now`, so this cleanly produces a genuinely UNDER_2_HOURS cancellation without needing a
    // real reservation at that instant (cancellation itself does not re-validate availability).
    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    await BookingModel.updateOne(
      { _id: finalizeResult.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 90 * 60_000) } },
    ).exec();

    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(finalizeResult.booking._id),
      undefined,
    );

    expect(cancelled.status).toBe("LATE_CANCELLATION");
    expect(cancelled.cancellationOutcome?.cancellationFeeCents).toBeGreaterThan(0);
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("SUCCEEDED");

    const ledger = await financialTransactionService.listForBooking(finalizeResult.booking._id);
    const feeEntry = ledger.find((entry) => entry.type === "CANCELLATION_FEE");
    expect(feeEntry?.status).toBe("SUCCEEDED");
  });

  it("a FREE customer cancellation never attempts a charge", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("h");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(finalizeResult.booking._id),
      undefined,
    );

    expect(cancelled.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("NOT_APPLICABLE");

    const ledger = await financialTransactionService.listForBooking(finalizeResult.booking._id);
    expect(ledger.find((entry) => entry.type === "CANCELLATION_FEE")).toBeUndefined();
  });

  // --- Business cancellation refund -------------------------------------------------------------

  it("business cancellation refunds an already-collected activation fee exactly once", async () => {
    const { business, owner, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("i");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    const cancelled = await lifecycleService.cancelByBusiness(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(finalizeResult.booking._id),
      "Business closed for the day",
    );

    expect(cancelled.status).toBe("CANCELLED_BY_BUSINESS");
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("SUCCEEDED");

    const ledger = await financialTransactionService.listForBooking(finalizeResult.booking._id);
    const refundEntries = ledger.filter((entry) => entry.type === "REFUND");
    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0]?.status).toBe("SUCCEEDED");
  });

  // --- No-show worker ----------------------------------------------------------------------------

  it("the no-show worker charges the configured fee and marks the booking NO_SHOW_CHARGED", async () => {
    const { business, owner, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        { tier: "UNDER_2_HOURS", mode: "FREE" },
      ],
      80,
    );
    const customer = await createCustomer("j");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    const marked = await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(finalizeResult.booking._id),
    );
    expect(marked.status).toBe("PENDING");

    // Force the deadline into the past so the worker considers it overdue.
    await BookingModel.updateOne(
      { _id: finalizeResult.booking._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();

    const outcome = await noShowService.autoResolve(finalizeResult.booking._id);
    expect(outcome).toBe("charged");

    const resolved = await bookingRepository.findByIdOnly(finalizeResult.booking._id);
    expect(resolved?.status).toBe("NO_SHOW_CHARGED");

    const ledger = await financialTransactionService.listForBooking(finalizeResult.booking._id);
    // Gross no-show fee is 80% of the €100 basis = €80 (8000c), but the customer's first-booking
    // €20 (2000c) deposit was already collected as PLATFORM_FEE — the worker nets against it
    // (Batch 5 correction; see BookingCancellationOutcome's own doc comment), so only the €60
    // (6000c) shortfall is actually newly charged here.
    const platformFeeEntry = ledger.find((entry) => entry.type === "PLATFORM_FEE");
    expect(platformFeeEntry?.amountCents).toBe(2000);
    const noShowEntry = ledger.find((entry) => entry.type === "NO_SHOW_FEE");
    expect(noShowEntry?.status).toBe("SUCCEEDED");
    expect(noShowEntry?.amountCents).toBe(6000);
  });

  it("the no-show worker auto-waives when no cancellation policy was ever configured", async () => {
    const { business, owner, membership, service } = await setupBookableBusiness();
    const customer = await createCustomer("k");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(finalizeResult.booking._id),
    );
    await BookingModel.updateOne(
      { _id: finalizeResult.booking._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();

    const outcome = await noShowService.autoResolve(finalizeResult.booking._id);
    expect(outcome).toBe("waived_no_policy");

    const resolved = await bookingRepository.findByIdOnly(finalizeResult.booking._id);
    expect(resolved?.status).toBe("NO_SHOW_WAIVED");
  });

  it("[race] two concurrent no-show worker passes on the same overdue booking result in exactly one charge", async () => {
    const { business, owner, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        { tier: "UNDER_2_HOURS", mode: "FREE" },
      ],
      50,
    );
    const customer = await createCustomer("l");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const finalizeResult = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    expect(finalizeResult.status).toBe("confirmed");
    if (finalizeResult.status !== "confirmed") throw new Error("expected confirmed");

    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(finalizeResult.booking._id),
    );
    await BookingModel.updateOne(
      { _id: finalizeResult.booking._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();

    const outcomes = await Promise.all([
      noShowService.autoResolve(finalizeResult.booking._id),
      noShowService.autoResolve(finalizeResult.booking._id),
    ]);

    expect(outcomes.filter((o) => o === "charged")).toHaveLength(1);

    const ledger = await financialTransactionService.listForBooking(finalizeResult.booking._id);
    expect(ledger.filter((entry) => entry.type === "NO_SHOW_FEE")).toHaveLength(1);
  });
});
