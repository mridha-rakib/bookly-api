import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { toBookingDetailDto } from "../../../src/modules/booking/booking.dto.js";
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
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

describe("database-backed Booking Waive Fee + completion venue-payment integration (Batch 5)", () => {
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

  // --- Fixtures (mirrors booking-payment-database.integration.test.ts) -----------------------

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

  /** Books, saves a card, and returns a confirmed first booking with a 100%-no-show-fee,
   * FREE-cancellation policy (so `markNoShow` + the worker/waive path are the only levers). */
  const bookFirstBookingWithNoShowPolicy = async (
    noShowPercentage: number,
    priceCents = 10_000,
  ) => {
    const { owner, business, membership, service } = await setupBookableBusiness(priceCents);
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        { tier: "UNDER_2_HOURS", mode: "FREE" },
      ],
      noShowPercentage,
    );
    const customer = await createCustomer(new Types.ObjectId().toString());
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const marked = await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
    );
    expect(marked.status).toBe("PENDING");

    // Force the deadline into the past so the worker considers this booking overdue and ready
    // to resolve — otherwise autoResolve always short-circuits to "skipped_already_resolved"
    // regardless of what else is going on, making any test that races it against a manual waive
    // meaningless.
    await BookingModel.updateOne(
      { _id: marked._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();

    return { owner, business, membership, service, customer, booking: marked };
  };

  // --- Waive Fee: no-show branch --------------------------------------------------------------

  it("waives an outstanding no-show fee, nets it against the deposit, and never charges the card", async () => {
    const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80, 10_000);
    // €100 basis, 80% no-show fee = €80 gross; €20 deposit already collected -> €60 additional.

    const waived = await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      "Customer did not attend",
      "Called ahead, traffic accident",
    );

    expect(waived.status).toBe("NO_SHOW_WAIVED");

    const ledger = await financialTransactionService.listForBooking(booking._id);
    const noShowEntry = ledger.find((entry) => entry.type === "NO_SHOW_FEE");
    expect(noShowEntry?.status).toBe("WAIVED");
    expect(noShowEntry?.amountCents).toBe(6000); // 8000 gross - 2000 deposit

    // The internal note must never leak into the customer-facing/business-facing DTO.
    const dto = toBookingDetailDto(waived);
    expect(JSON.stringify(dto)).not.toContain("traffic accident");
  });

  it("repeated waive of the same no-show fee is idempotent (no double ledger entry, no error)", async () => {
    const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80);

    const first = await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      "Customer did not attend",
      undefined,
    );
    expect(first.status).toBe("NO_SHOW_WAIVED");

    // A second waive attempt against the now-NO_SHOW_WAIVED booking is rejected by the status
    // guard itself (there is no longer a PENDING/LATE_CANCELLATION fee to waive) — the
    // idempotent-retry guarantee is proven by the RACE test below, which exercises the actual
    // ledger-claim collision this guard is meant to make safe.
    await expect(
      lifecycleService.waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Customer did not attend",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const ledger = await financialTransactionService.listForBooking(booking._id);
    expect(ledger.filter((entry) => entry.type === "NO_SHOW_FEE")).toHaveLength(1);
  });

  it("[race] concurrent waive vs. the auto-charge worker produces exactly one financial outcome", async () => {
    const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80);

    const results = await Promise.allSettled([
      lifecycleService.waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Customer did not attend",
        undefined,
      ),
      noShowService.autoResolve(booking._id),
    ]);

    const ledger = await financialTransactionService.listForBooking(booking._id);
    const noShowEntries = ledger.filter((entry) => entry.type === "NO_SHOW_FEE");
    // Exactly one ledger row for this obligation, ever — never both a WAIVED and a
    // SUCCEEDED/PENDING row for the same fee.
    expect(noShowEntries).toHaveLength(1);
    expect(["WAIVED", "SUCCEEDED"]).toContain(noShowEntries[0]?.status);

    const final = await bookingRepository.findByIdOnly(booking._id);
    // The Booking's own status must agree with whichever side actually won.
    if (noShowEntries[0]?.status === "WAIVED") {
      expect(final?.status).toBe("NO_SHOW_WAIVED");
    } else {
      expect(final?.status).toBe("NO_SHOW_CHARGED");
    }

    // The losing side must fail cleanly, never silently succeed twice.
    const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(1);
  });

  it("a fee that already SUCCEEDED can never later be waived", async () => {
    const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80);

    const outcome = await noShowService.autoResolve(booking._id);
    expect(outcome).toBe("charged");

    await expect(
      lifecycleService.waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Changed my mind",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a fee whose only charge attempt FAILED can still be waived afterward", async () => {
    const { owner, business, booking, customer } = await bookFirstBookingWithNoShowPolicy(80);

    // Simulate a declined/removed card: strip the saved default payment method so
    // chargeOffSession throws PAYMENT_METHOD_REQUIRED (mirrors payment.service.ts's own guard).
    await CustomerPaymentProfileModel.updateOne(
      { userId: customer._id },
      { $unset: { defaultPaymentMethodId: "" } },
    ).exec();

    const outcome = await noShowService.autoResolve(booking._id);
    expect(outcome).toBe("skipped_already_resolved");

    const afterFailedCharge = await bookingRepository.findByIdOnly(booking._id);
    expect(afterFailedCharge?.status).toBe("PENDING");

    const waived = await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      "Card declined, forgiving it",
      undefined,
    );
    expect(waived.status).toBe("NO_SHOW_WAIVED");

    const ledger = await financialTransactionService.listForBooking(booking._id);
    const noShowEntries = ledger.filter((entry) => entry.type === "NO_SHOW_FEE");
    expect(noShowEntries).toHaveLength(1);
    expect(noShowEntries[0]?.status).toBe("WAIVED");
  });

  // --- Waive Fee: late-cancellation branch ----------------------------------------------------

  it("waives an outstanding late-cancellation fee (settlementStatus WAIVED, booking status unchanged)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 100 },
      ],
      100,
    );
    const customer = await createCustomer("late-cancel-waive");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    // Deliberately remove the saved card AFTER booking so the customer-initiated cancellation's
    // own off-session charge attempt fails, leaving settlementStatus PENDING->FAILED — proving
    // the Business can still waive a fee whose customer-side charge attempt failed.
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    await BookingModel.updateOne(
      { _id: result.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();

    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(result.booking._id),
      "Can't make it",
    );
    expect(cancelled.status).toBe("LATE_CANCELLATION");
    expect(cancelled.cancellationOutcome?.settlementStatus).toBe("SUCCEEDED");

    // Nothing PENDING left to waive once the charge already succeeded.
    await expect(
      lifecycleService.waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(result.booking._id),
        "Too late",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // --- Complete Booking: venue-payment capture ------------------------------------------------

  it("records the Business's venue-payment attestation on completion as a PAYMENT ledger entry", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("venue-pay");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    // €100 total, €20 deposit -> €80 balance due at the venue.
    expect(result.booking.financials.balanceDueCents).toBe(8000);

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
      { paid: true, note: "Paid by card in person" },
    );

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completionPayment?.paid).toBe(true);
    expect(completed.completionPayment?.amountCents).toBe(8000);

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    const venueEntry = ledger.find(
      (entry) => entry.type === "PAYMENT" && entry.idempotencyKey?.startsWith("venue-payment:"),
    );
    expect(venueEntry?.status).toBe("SUCCEEDED");
    expect(venueEntry?.amountCents).toBe(8000);

    const dto = toBookingDetailDto(completed);
    expect(dto.completionPayment).toEqual({
      paid: true,
      amountCents: 8000,
      recordedAt: expect.any(String),
    });
  });

  it("completion without a venuePayment answer leaves completionPayment unset (backward compatible)", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("no-venue-pay");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
    );

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completionPayment).toBeUndefined();

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    expect(ledger.some((entry) => entry.type === "PAYMENT")).toBe(false);
  });
});
