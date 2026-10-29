import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P4B-2A/2C — both ordinary Calendar rollout authorities are default-denied; only tests toggle them.
const calendarAuthority = vi.hoisted(() => ({ enabled: false, delivery: false }));
vi.mock("../../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => calendarAuthority.enabled,
  verifyOrdinaryCalendarDeliveryAuthority: async () => {
    if (!calendarAuthority.delivery) throw new Error("delivery not authorized in this suite");
  },
}));

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
import {
  OrdinaryCalendarJournal,
  type OrdinaryCalendarJournalPort,
} from "../../../src/modules/booking/ordinary-calendar-journal.js";
import { OrdinaryCalendarJournalModel } from "../../../src/modules/booking/ordinary-calendar-journal.model.js";
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
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCancelledNotifier } from "../../../src/modules/notification/booking-cancelled.notifier.js";
import { NoShowNotifier } from "../../../src/modules/notification/no-show.notifier.js";
import { withPackageEligibility } from "../../../src/modules/package-progress/package-eligibility.js";
import { CustomerPaymentProfileModel } from "../../../src/modules/payment/customer-payment-profile.model.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import type { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { ordinaryCompletionHttp } from "../../helpers/ordinary-completion-http.js";
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
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
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

    // Simulate a removed card: strip the saved default payment method — P5 records a definitive
    // FAILED obligation with no PaymentAttempt (nothing can ever be dispatched for it).
    await CustomerPaymentProfileModel.updateOne(
      { userId: customer._id },
      { $unset: { defaultPaymentMethodId: "" } },
    ).exec();

    const outcome = await noShowService.autoResolve(booking._id);
    expect(outcome).toBe("charge_failed");

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
      { settlement: "FULL", note: "Paid by card in person" },
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

  // --- P4B-1R: terminal notification intents commit with the authoritative transition --------

  describe("Calendar completion financial contract", () => {
    const upcoming = async () => {
      const f = await setupBookableBusiness(10_000);
      const customer = await createCustomer("calendar-completion");
      await saveCard(customer._id);
      await linkCustomerToBusiness(f.business._id, f.owner._id, customer._id);
      const result = await creationService.finalizeCustomerBooking(
        String(customer._id),
        String(f.business._id),
        finalizeInput(f.service._id, f.membership._id),
      );
      if (result.status !== "confirmed") throw Error("confirmed fixture required");
      return { ...f, booking: result.booking };
    };
    const venueEntries = async (id: Types.ObjectId) =>
      (await financialTransactionService.listForBooking(id)).filter(
        (entry) => entry.idempotencyKey === `venue-payment:${id}`,
      );

    it("ordinary HTTP endpoint preserves authorized completion and its payment DTO", async () => {
      const f = await upcoming();
      const post = await ordinaryCompletionHttp(
        bookingService,
        lifecycleService,
        String(f.owner._id),
      );
      const result = await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "FULL" },
        expectedBalanceDueCents: 8000,
      }).expect(200);
      expect(result.body.data.status).toBe("COMPLETED");
      expect(result.body.data.completionPayment.amountCents).toBe(8000);
      expect((await venueEntries(f.booking._id)).map((entry) => entry.amountCents)).toEqual([8000]);
      await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "FULL" },
      }).expect(409);
      expect((await venueEntries(f.booking._id)).map((entry) => entry.amountCents)).toEqual([8000]);
    });

    it.each([
      { settlement: "NOT_PAID" as const, expected: 0 },
      { settlement: "FULL" as const, expected: 8000 },
      { settlement: "PARTIAL" as const, amountCents: 1234, expected: 1234 },
    ])(
      "records $settlement once without a duplicate ledger on repeated completion",
      async (answer) => {
        const f = await upcoming();
        const { expected, ...payment } = answer;
        const complete = () =>
          lifecycleService.completeBooking(
            String(f.owner._id),
            "BUSINESS_OWNER",
            String(f.business._id),
            String(f.booking._id),
            payment,
          );
        const completed = await complete();
        expect(completed.status).toBe("COMPLETED");
        expect(completed.completionPayment?.paid).toBe(expected > 0);
        expect(completed.completionPayment?.amountCents ?? 0).toBe(expected);
        const before = await venueEntries(f.booking._id);
        expect(before.map((entry) => entry.amountCents)).toEqual(expected > 0 ? [expected] : []);
        await expect(complete()).rejects.toMatchObject({ statusCode: 409 });
        expect(await venueEntries(f.booking._id)).toEqual(before);
      },
    );

    it.each([0, -1, 8000, 8001, 1.5])("rejects partial %s before effects", async (amountCents) => {
      const f = await upcoming();
      await expect(
        lifecycleService.completeBooking(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          { settlement: "PARTIAL", amountCents },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect((await BookingModel.findById(f.booking._id))?.status).toBe("UPCOMING");
      expect((await BookingModel.findById(f.booking._id))?.completionPayment).toBeUndefined();
      expect(await venueEntries(f.booking._id)).toEqual([]);
    });

    it.each(["FULL", "NOT_PAID"] as const)(
      "zero balance %s preserves completion without a positive venue ledger",
      async (settlement) => {
        const f = await upcoming();
        // Isolated zero-balance persistence fixture; no new financial calculator or production writer.
        await BookingModel.updateOne(
          { _id: f.booking._id },
          { $set: { "financials.balanceDueCents": 0 } },
        );
        const completed = await lifecycleService.completeBooking(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          { settlement },
        );
        expect(completed.status).toBe("COMPLETED");
        expect(completed.completionPayment?.amountCents).toBeUndefined();
        expect(await venueEntries(f.booking._id)).toEqual([]);
      },
    );

    it("rechecks a stale partial against the stored balance instead of the Calendar's old amount", async () => {
      const f = await upcoming();
      expect(toBookingDetailDto(f.booking).paymentSummary.outstandingVenueBalanceCents).toBe(8000);
      // Model a changed authoritative snapshot after an earlier read; the API receives no trusted balance.
      await BookingModel.updateOne(
        { _id: f.booking._id },
        { $set: { "financials.balanceDueCents": 4000 } },
      );
      await expect(
        lifecycleService.completeBooking(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          { settlement: "PARTIAL", amountCents: 5000 },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect((await BookingModel.findById(f.booking._id))?.status).toBe("UPCOMING");
      expect(await venueEntries(f.booking._id)).toEqual([]);
    });

    it("rejects a stale FULL snapshot through HTTP before any completion or venue write", async () => {
      const f = await upcoming();
      const post = await ordinaryCompletionHttp(
        bookingService,
        lifecycleService,
        String(f.owner._id),
      );
      await BookingModel.updateOne(
        { _id: f.booking._id },
        { $set: { "financials.balanceDueCents": 4000 } },
      );
      const response = await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "FULL" },
        expectedBalanceDueCents: 8000,
      }).expect(409);
      expect(response.body.errors[0].code).toBe("BOOKING_COMPLETION_BALANCE_CHANGED");
      expect((await BookingModel.findById(f.booking._id))?.status).toBe("UPCOMING");
      expect((await BookingModel.findById(f.booking._id))?.completionPayment).toBeUndefined();
      expect(await venueEntries(f.booking._id)).toEqual([]);
      // A new explicit confirmation of fresh terms succeeds; no automatic resubmission.
      await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "FULL" },
        expectedBalanceDueCents: 4000,
      }).expect(200);
      expect((await venueEntries(f.booking._id)).map((entry) => entry.amountCents)).toEqual([4000]);
    });

    it.each(["FULL", "PARTIAL"] as const)(
      "stale outstanding %s rejects even when original balance is unchanged",
      async (settlement) => {
        const f = await upcoming();
        const displayed = toBookingDetailDto(f.booking).paymentSummary.outstandingVenueBalanceCents;
        const record = {
          paid: true,
          amountCents: 2000,
          recordedAt: new Date(),
          recordedBy: f.owner._id,
        };
        await BookingModel.updateOne(
          { _id: f.booking._id },
          { $set: { completionPayment: record } },
        );
        const changed = await BookingModel.findById(f.booking._id).orFail();
        expect(changed.financials.balanceDueCents).toBe(8000);
        expect(toBookingDetailDto(changed).paymentSummary.outstandingVenueBalanceCents).toBe(6000);
        const before = changed.toObject();
        const post = await ordinaryCompletionHttp(
          bookingService,
          lifecycleService,
          String(f.owner._id),
        );
        const payment = settlement === "FULL" ? { settlement } : { settlement, amountCents: 1000 };
        const response = await post(String(f.business._id), String(f.booking._id), {
          venuePayment: payment,
          expectedOutstandingVenueBalanceCents: displayed,
        }).expect(409);
        expect(response.body.errors[0].code).toBe("BOOKING_COMPLETION_BALANCE_CHANGED");
        // An anomalous ordinary UPCOMING record is not an incremental-settlement authority.
        const fresh = await post(String(f.business._id), String(f.booking._id), {
          venuePayment: payment,
          expectedOutstandingVenueBalanceCents: 6000,
        }).expect(409);
        expect(fresh.body.errors[0].code).toBe("BOOKING_COMPLETION_PAYMENT_ALREADY_RECORDED");
        expect((await BookingModel.findById(f.booking._id).orFail()).toObject()).toEqual(before);
        expect(await venueEntries(f.booking._id)).toEqual([]);
      },
    );

    it.each(["balance", "venue record"])(
      "outstanding CAS protects post-read %s changes atomically",
      async (change) => {
        const f = await upcoming();
        const original = bookingRepository.casUpdate.bind(bookingRepository);
        vi.spyOn(bookingRepository, "casUpdate").mockImplementationOnce(
          async (business, id, statuses, update, session) => {
            expect(update.extraFilter).toEqual({
              "financials.balanceDueCents": 8000,
              completionPayment: null,
            });
            await BookingModel.updateOne(
              { _id: id },
              {
                $set:
                  change === "balance"
                    ? { "financials.balanceDueCents": 7000 }
                    : {
                        completionPayment: {
                          paid: true,
                          amountCents: 1000,
                          recordedAt: new Date(),
                          recordedBy: f.owner._id,
                        },
                      },
              },
            ).session(session ?? null);
            return original(business, id, statuses, update, session);
          },
        );
        await expect(
          lifecycleService.completeBooking(
            String(f.owner._id),
            "BUSINESS_OWNER",
            String(f.business._id),
            String(f.booking._id),
            { settlement: "FULL" },
            undefined,
            8000,
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        const after = await BookingModel.findById(f.booking._id).orFail();
        expect(after.status).toBe("UPCOMING");
        expect(after.completionPayment).toBeUndefined();
        expect(after.financials.balanceDueCents).toBe(8000);
        expect(await venueEntries(f.booking._id)).toEqual([]);
      },
    );

    it("outstanding zero HTTP confirmation stays zero and duplicate submission writes no money", async () => {
      const f = await upcoming();
      await BookingModel.updateOne(
        { _id: f.booking._id },
        { $set: { "financials.balanceDueCents": 0 } },
      );
      const post = await ordinaryCompletionHttp(
        bookingService,
        lifecycleService,
        String(f.owner._id),
      );
      const body = {
        venuePayment: { settlement: "FULL" },
        expectedOutstandingVenueBalanceCents: 0,
      };
      await post(String(f.business._id), String(f.booking._id), body).expect(200);
      await post(String(f.business._id), String(f.booking._id), body).expect(409);
      expect(await venueEntries(f.booking._id)).toEqual([]);
    });

    const supervisor = async (businessId: Types.ObjectId) => {
      const user = await userRepository.create({
        normalizedEmail: `sup-${new Types.ObjectId()}@test.local`,
        passwordHash: "unused",
        role: "SUPERVISOR",
        status: "ACTIVE",
      });
      const membership = await staffRepository.create({
        userId: user._id,
        businessId,
        role: "SUPERVISOR",
        createdByUserId: user._id,
      });
      return { user, membership };
    };
    it("active Supervisor completes with venue payment; deactivation denies HTTP and direct management", async () => {
      const f = await upcoming(),
        s = await supervisor(f.business._id);
      const post = await ordinaryCompletionHttp(
        bookingService,
        lifecycleService,
        String(s.user._id),
        "SUPERVISOR",
      );
      await StaffMembershipModel.updateOne(
        { _id: s.membership._id },
        { $set: { employmentActive: false } },
      );
      await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "FULL" },
      }).expect(404);
      await expect(
        lifecycleService.completeBooking(
          String(s.user._id),
          "SUPERVISOR",
          String(f.business._id),
          String(f.booking._id),
          { settlement: "FULL" },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await BookingModel.findById(f.booking._id))?.status).toBe("UPCOMING");
      expect(await venueEntries(f.booking._id)).toEqual([]);
      await StaffMembershipModel.updateOne(
        { _id: s.membership._id },
        { $set: { employmentActive: true, removedAt: null } },
      );
      await post(String(f.business._id), String(f.booking._id), {
        venuePayment: { settlement: "PARTIAL", amountCents: 1000 },
      }).expect(200);
      expect((await venueEntries(f.booking._id)).map((e) => e.amountCents)).toEqual([1000]);
    });

    it("Supervisor deactivation winning the fence before ordinary CAS prevents status and venue writes", async () => {
      const f = await upcoming(),
        s = await supervisor(f.business._id);
      const original = bookingRepository.casUpdate.bind(bookingRepository);
      vi.spyOn(bookingRepository, "casUpdate").mockImplementationOnce(async (...args) => {
        // Deterministic race seam after entry authorization, before persistence fencing.
        await withPackageEligibility(f.business._id, undefined, async (session) => {
          await StaffMembershipModel.updateOne(
            { _id: s.membership._id },
            { $set: { employmentActive: false } },
          ).session(session);
        });
        return original(...args);
      });
      await expect(
        lifecycleService.completeBooking(
          String(s.user._id),
          "SUPERVISOR",
          String(f.business._id),
          String(f.booking._id),
          { settlement: "FULL" },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await BookingModel.findById(f.booking._id))?.status).toBe("UPCOMING");
      expect(await venueEntries(f.booking._id)).toEqual([]);
    });

    it("balance CAS refuses a post-read change and rolls back without venue effects", async () => {
      const f = await upcoming();
      const original = bookingRepository.casUpdate.bind(bookingRepository);
      vi.spyOn(bookingRepository, "casUpdate").mockImplementationOnce(
        async (business, id, statuses, update, session) => {
          expect(update.extraFilter).toEqual({
            "financials.balanceDueCents": 8000,
            completionPayment: null,
          });
          // Deterministic persistence seam: move the stored balance after service validation,
          // inside its transaction, then exercise the real CAS predicate and rollback.
          await BookingModel.updateOne(
            { _id: id },
            { $set: { "financials.balanceDueCents": 4000 } },
          ).session(session ?? null);
          return original(business, id, statuses, update, session);
        },
      );
      await expect(
        lifecycleService.completeBooking(
          String(f.owner._id),
          "BUSINESS_OWNER",
          String(f.business._id),
          String(f.booking._id),
          { settlement: "FULL" },
          8000,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      const after = await BookingModel.findById(f.booking._id).orFail();
      expect(after.status).toBe("UPCOMING");
      expect(after.completionPayment).toBeUndefined();
      expect(after.financials.balanceDueCents).toBe(8000);
      expect(await venueEntries(f.booking._id)).toEqual([]);
    });
  });

  describe("P4B-1R transactional notification intents", () => {
    const outbox = () => new EmailOutboxService(new EmailOutboxRepository());

    const notifyingLifecycle = (
      noShowNotifier: NoShowNotifier = new NoShowNotifier(outbox()),
      cancelledNotifier: ConstructorParameters<
        typeof BookingLifecycleService
      >[11] = new BookingCancelledNotifier(outbox(), userRepository),
    ) =>
      new BookingLifecycleService(
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
        cancelledNotifier,
        noShowNotifier,
      );

    const recovery = () =>
      new MoneyRecoveryService(
        paymentService,
        new PaymentAttemptRepository(),
        new RefundOperationRepository(),
        bookingRepository,
        financialTransactionService,
        {
          recoverDue: async () => ({ processed: 0, failed: 0 }),
        } as unknown as StripeWebhookService,
      );

    const failingNoShowNotifier = () => {
      const notifier = new NoShowNotifier(outbox());
      vi.spyOn(notifier, "enqueueNoShowWaivedInTransaction").mockRejectedValue(
        new Error("outbox unavailable"),
      );
      vi.spyOn(notifier, "enqueueNoShowCancelledInTransaction").mockRejectedValue(
        new Error("outbox unavailable"),
      );
      return notifier;
    };

    const bookUpcomingPaidBooking = async () => {
      const { owner, business, membership, service } = await setupBookableBusiness(10_000);
      const customer = await createCustomer("biz-cancel");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      const result = await creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id),
      );
      if (result.status !== "confirmed") throw new Error("expected confirmed");
      return { owner, business, booking: result.booking };
    };

    afterEach(() => vi.restoreAllMocks());

    it("a gated no-show waiver commits its NO_SHOW_WAIVED intent with the transition", async () => {
      const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80);
      const waived = await notifyingLifecycle().waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Excused",
        undefined,
      );
      expect(waived.status).toBe("NO_SHOW_WAIVED");
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `NO_SHOW_WAIVED:${String(booking._id)}`,
        }),
      ).toBe(1);
    });

    it("a zero-amount no-show waiver also commits its intent in the Booking transaction", async () => {
      // 20% of the EUR 100 basis equals the EUR 20 deposit, so nothing further is owed.
      const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(20);
      const waived = await notifyingLifecycle().waiveFee(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Excused",
        undefined,
      );
      expect(waived.status).toBe("NO_SHOW_WAIVED");
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `NO_SHOW_WAIVED:${String(booking._id)}`,
        }),
      ).toBe(1);
    });

    it("a failed waiver intent rolls back the waiver, its ledger row, and leaves no notice", async () => {
      const { owner, business, booking } = await bookFirstBookingWithNoShowPolicy(80);
      await expect(
        notifyingLifecycle(failingNoShowNotifier()).waiveFee(
          String(owner._id),
          "BUSINESS_OWNER",
          String(business._id),
          String(booking._id),
          "Excused",
          undefined,
        ),
      ).rejects.toThrow("outbox unavailable");
      expect((await BookingModel.findById(booking._id).lean())?.status).toBe("PENDING");
      const ledger = await financialTransactionService.listForBooking(booking._id);
      expect(ledger.some((entry) => entry.type === "NO_SHOW_FEE")).toBe(false);
      expect(await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^NO_SHOW_" } })).toBe(0);
    });

    it("a no-show cancellation commits NO_SHOW_CANCELLED once and rolls back on enqueue failure", async () => {
      const failed = await bookFirstBookingWithNoShowPolicy(80);
      await expect(
        notifyingLifecycle(failingNoShowNotifier()).cancelNoShowByBusiness(
          String(failed.owner._id),
          "BUSINESS_OWNER",
          String(failed.business._id),
          String(failed.booking._id),
        ),
      ).rejects.toThrow("outbox unavailable");
      expect((await BookingModel.findById(failed.booking._id).lean())?.status).toBe("PENDING");
      expect(await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^NO_SHOW_" } })).toBe(0);

      const cancelled = await notifyingLifecycle().cancelNoShowByBusiness(
        String(failed.owner._id),
        "BUSINESS_OWNER",
        String(failed.business._id),
        String(failed.booking._id),
      );
      expect(cancelled.status).toBe("NO_SHOW_CANCELLED");
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `NO_SHOW_CANCELLED:${String(failed.booking._id)}`,
        }),
      ).toBe(1);
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `NO_SHOW_WAIVED:${String(failed.booking._id)}`,
        }),
      ).toBe(0);
    });

    it("a synchronous Business refund success records one exact final event with its marker", async () => {
      const { owner, business, booking } = await bookUpcomingPaidBooking();
      await notifyingLifecycle().cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Closed",
      );
      const operation = await RefundOperationModel.findOne({
        logicalIdempotencyKey: `business-cancel-refund:${String(booking._id)}`,
      }).lean();
      expect(operation?.finalNotificationProtocolVersion).toBe(1);
      expect(operation?.providerStatus).toBe("SUCCEEDED");
      expect(operation?.finalNotificationRecordedAt).toBeInstanceOf(Date);
      const initial = await EmailOutboxModel.findOne({
        eventKey: `BOOKING_CANCELLED:${String(booking._id)}`,
        templateKey: "BOOKING_CANCELLED_CUSTOMER",
      }).lean();
      // The cancellation notice committed with the Booking never claims a settled refund.
      if (!initial?.payload) throw new Error("Expected initial cancellation notification payload");
      expect(
        (initial.payload as { financialOutcome?: { settlementStatus?: string } }).financialOutcome
          ?.settlementStatus,
      ).toBe("PENDING");
      const finalKey = `BUSINESS_REFUND:${String(booking._id)}:${String(operation?._id)}:SUCCEEDED`;
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: finalKey,
          templateKey: "BOOKING_CANCELLED_CUSTOMER",
        }),
      ).toBe(1);

      // A repeated management request and a recovery pass converge on the same event.
      await notifyingLifecycle().cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Closed",
      );
      await recovery().runOnce(10);
      expect(
        await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^BUSINESS_REFUND:" } }),
      ).toBe(await EmailOutboxModel.countDocuments({ eventKey: finalKey }));
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: finalKey,
          templateKey: "BOOKING_CANCELLED_CUSTOMER",
        }),
      ).toBe(1);
    });

    it("a pending provider refund sends no final notice until recovery observes definitive success", async () => {
      const { owner, business, booking } = await bookUpcomingPaidBooking();
      paymentGateway.queueNextRefundOutcome("pending");
      await notifyingLifecycle().cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Closed",
      );
      const pending = await RefundOperationModel.findOne({
        logicalIdempotencyKey: `business-cancel-refund:${String(booking._id)}`,
      }).lean();
      expect(pending?.providerStatus).toBe("PROVIDER_PENDING");
      expect(pending?.finalNotificationRecordedAt).toBeUndefined();
      expect(
        await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^BUSINESS_REFUND:" } }),
      ).toBe(0);

      // A recovery pass while the provider is still pending changes nothing.
      await recovery().runOnce(10);
      expect(
        await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^BUSINESS_REFUND:" } }),
      ).toBe(0);

      if (!pending?.providerRefundId) throw new Error("expected a provider refund id");
      paymentGateway.succeedRefund(pending.providerRefundId);
      await RefundOperationModel.updateOne({ _id: pending._id }, { $unset: { nextRecoveryAt: 1 } });
      await recovery().runOnce(10);
      await recovery().runOnce(10);

      const settled = await RefundOperationModel.findById(pending._id).lean();
      expect(settled?.providerStatus).toBe("SUCCEEDED");
      expect(settled?.finalNotificationRecordedAt).toBeInstanceOf(Date);
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `BUSINESS_REFUND:${String(booking._id)}:${String(pending._id)}:SUCCEEDED`,
          templateKey: "BOOKING_CANCELLED_CUSTOMER",
        }),
      ).toBe(1);
    });

    it("a Business refund without exact ordinary PaymentAttempt evidence is not opted in", async () => {
      const { owner, business, booking } = await bookUpcomingPaidBooking();
      await PaymentAttemptModel.deleteMany({ bookingId: booking._id });
      await notifyingLifecycle().cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Closed",
      );
      const operation = await RefundOperationModel.findOne({
        logicalIdempotencyKey: `business-cancel-refund:${String(booking._id)}`,
      }).lean();
      expect(operation?.providerStatus).toBe("SUCCEEDED");
      expect(operation?.finalNotificationProtocolVersion).toBeUndefined();
      expect(
        await EmailOutboxModel.countDocuments({ eventKey: { $regex: "^BUSINESS_REFUND:" } }),
      ).toBe(0);
      expect(
        await EmailOutboxModel.countDocuments({
          eventKey: `BOOKING_CANCELLED:${String(booking._id)}`,
        }),
      ).toBeGreaterThan(0);
    });

    it("a legacy cancellation port without transactional enqueue keeps its post-refund notice", async () => {
      const { owner, business, booking } = await bookUpcomingPaidBooking();
      const legacy = { notifyBookingCancelled: vi.fn(async (..._args: unknown[]) => undefined) };
      await notifyingLifecycle(new NoShowNotifier(outbox()), legacy).cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(booking._id),
        "Closed",
      );
      expect(legacy.notifyBookingCancelled).toHaveBeenCalledTimes(1);
      const [notifiedBooking, , cancelledBy, refundOutcome] =
        legacy.notifyBookingCancelled.mock.calls[0] ?? [];
      expect(String((notifiedBooking as { _id?: unknown } | undefined)?._id)).toBe(
        String(booking._id),
      );
      expect(cancelledBy).toBe("BUSINESS");
      expect(refundOutcome).toMatchObject({ succeeded: true, status: "SUCCEEDED" });
    });
  });

  // --- P4B-2A: ordinary Calendar desired state through the real Booking transactions --------

  describe("P4B-2A ordinary Calendar journal", () => {
    const legacyCalendar = () => ({
      createEventForBooking: vi.fn(
        async (..._args: unknown[]) => "legacy-event-1" as string | undefined,
      ),
      deleteEventForBooking: vi.fn(async (..._args: unknown[]) => undefined),
      updateEventScheduleForBooking: vi.fn(async (..._args: unknown[]) => undefined),
    });

    const journaled = (
      calendar: ReturnType<typeof legacyCalendar>,
      journal: OrdinaryCalendarJournalPort = new OrdinaryCalendarJournal(),
    ) => ({
      creation: new BookingCreationService(
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
        new PromoApplicationService(
          new PromoRepository(),
          new PromoUserUsageRepository(),
          new PromoRedemptionRepository(),
        ),
        calendar,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        journal,
      ),
      lifecycle: new BookingLifecycleService(
        bookingService,
        bookingRepository,
        businessRepository,
        reservationService,
        availabilityService,
        serviceRepository,
        staffRepository,
        paymentService,
        financialTransactionService,
        calendar,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        journal,
      ),
    });

    const bookWith = async (creation: BookingCreationService) => {
      const { owner, business, membership, service } = await setupBookableBusiness(10_000);
      const customer = await createCustomer("calendar");
      await saveCard(customer._id);
      await linkCustomerToBusiness(business._id, owner._id, customer._id);
      const result = await creation.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id),
      );
      return { owner, business, membership, service, customer, result };
    };

    const switches = (enabled: boolean, delivery = enabled) => {
      calendarAuthority.enabled = enabled;
      calendarAuthority.delivery = delivery;
    };

    beforeAll(async () => {
      await OrdinaryCalendarJournalModel.init();
    });
    afterEach(() => {
      switches(false);
      vi.restoreAllMocks();
    });

    it("with both switches off (the deployment default) a paid Booking writes no journal row and keeps legacy sync", async () => {
      const calendar = legacyCalendar();
      const services = journaled(calendar);
      const { owner, business, result } = await bookWith(services.creation);
      if (result.status !== "confirmed") throw new Error("expected confirmed");
      expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
      expect(calendar.createEventForBooking).toHaveBeenCalledTimes(1);
      expect((await BookingModel.findById(result.booking._id).lean())?.googleCalendarEventId).toBe(
        "legacy-event-1",
      );
      await services.lifecycle.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(result.booking._id),
        startAtFor("14:00"),
      );
      await services.lifecycle.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(result.booking._id),
        "Closed",
      );
      expect(calendar.updateEventScheduleForBooking).toHaveBeenCalledTimes(1);
      expect(calendar.deleteEventForBooking).toHaveBeenCalledTimes(1);
      expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
    });

    it("a declined or 3DS-pending payment produces no Booking intent and no external event", async () => {
      switches(true);
      const calendar = legacyCalendar();
      paymentGateway.queueNextChargeOutcome("failed");
      await expect(bookWith(journaled(calendar).creation)).rejects.toMatchObject({
        statusCode: 402,
      });
      paymentGateway.queueNextChargeOutcome("requires_action");
      const pending = await bookWith(journaled(calendar).creation);
      expect(pending.result.status).toBe("requires_action");
      expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
      expect(calendar.createEventForBooking).not.toHaveBeenCalled();
    });

    it("a journal-owned Booking supersedes its intent in each transaction and never runs a legacy mutation", async () => {
      switches(true);
      const calendar = legacyCalendar();
      const services = journaled(calendar);
      const { owner, business, result } = await bookWith(services.creation);
      if (result.status !== "confirmed") throw new Error("expected confirmed");
      const id = String(result.booking._id);

      const moved = await services.lifecycle.rescheduleByOwner(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        id,
        startAtFor("14:00"),
      );
      let row = await OrdinaryCalendarJournalModel.findOne({
        bookingId: result.booking._id,
      }).lean();
      expect(row?.latest).toMatchObject({
        sequence: 2,
        source: "RESCHEDULED",
        desired: { kind: "PRESENT", startAt: moved.schedule.startAt },
      });

      await services.lifecycle.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        id,
        "Closed",
      );
      row = await OrdinaryCalendarJournalModel.findOne({ bookingId: result.booking._id }).lean();
      expect(row?.latest).toMatchObject({
        sequence: 3,
        source: "CANCELLED",
        desired: { kind: "ABSENT" },
      });

      // A repeated management cancellation is the same logical mutation.
      await services.lifecycle.cancelByBusiness(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        id,
        "Closed",
      );
      expect(
        (await OrdinaryCalendarJournalModel.findOne({ bookingId: result.booking._id }).lean())
          ?.latest.sequence,
      ).toBe(3);
      expect(calendar.createEventForBooking).not.toHaveBeenCalled();
      expect(calendar.updateEventScheduleForBooking).not.toHaveBeenCalled();
      expect(calendar.deleteEventForBooking).not.toHaveBeenCalled();
    });

    it("a failed intent write aborts the cancellation itself", async () => {
      switches(true);
      const calendar = legacyCalendar();
      const journal = new OrdinaryCalendarJournal();
      const { owner, business, result } = await bookWith(journaled(calendar, journal).creation);
      if (result.status !== "confirmed") throw new Error("expected confirmed");
      vi.spyOn(journal, "recordMutationInTransaction").mockRejectedValue(
        new Error("journal unavailable"),
      );
      await expect(
        journaled(calendar, journal).lifecycle.cancelByBusiness(
          String(owner._id),
          "BUSINESS_OWNER",
          String(business._id),
          String(result.booking._id),
          "Closed",
        ),
      ).rejects.toThrow("journal unavailable");
      expect((await BookingModel.findById(result.booking._id).lean())?.status).toBe("UPCOMING");
      expect(
        (await OrdinaryCalendarJournalModel.findOne({ bookingId: result.booking._id }).lean())
          ?.latest.sequence,
      ).toBe(1);
      expect(calendar.deleteEventForBooking).not.toHaveBeenCalled();
    });

    it("an unprovisioned journal never becomes a Booking failure: the Booking stays legacy-owned", async () => {
      switches(true);
      const calendar = legacyCalendar();
      const unready = new OrdinaryCalendarJournal(undefined, { isReady: async () => false });
      const { result } = await bookWith(journaled(calendar, unready).creation);
      expect(result.status).toBe("confirmed");
      expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
      expect(calendar.createEventForBooking).toHaveBeenCalledTimes(1);
    });

    it("creation authority without delivery authority never creates an unwritable journal-owned Booking", async () => {
      switches(true, false);
      const calendar = legacyCalendar();
      const { result } = await bookWith(journaled(calendar).creation);
      if (result.status !== "confirmed") throw new Error("expected confirmed");
      expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
      expect(calendar.createEventForBooking).toHaveBeenCalledTimes(1);
    });

    it("ownership survives switch changes in both directions: no Booking ever gets two writers", async () => {
      const calendar = legacyCalendar();
      const services = journaled(calendar);
      const legacy = await bookWith(services.creation); // Switches off: legacy-owned.
      switches(true);
      const owned = await bookWith(services.creation); // Switches on: journal-owned.
      if (legacy.result.status !== "confirmed" || owned.result.status !== "confirmed")
        throw new Error("expected confirmed");
      expect(calendar.createEventForBooking).toHaveBeenCalledTimes(1);

      // Turning activation on later never adopts the legacy Booking...
      await services.lifecycle.cancelByBusiness(
        String(legacy.owner._id),
        "BUSINESS_OWNER",
        String(legacy.business._id),
        String(legacy.result.booking._id),
        "Closed",
      );
      expect(calendar.deleteEventForBooking).toHaveBeenCalledTimes(1);
      expect(
        await OrdinaryCalendarJournalModel.countDocuments({ bookingId: legacy.result.booking._id }),
      ).toBe(0);

      // ...and a rollback (both switches off) never hands the journal-owned Booking to legacy.
      switches(false);
      await services.lifecycle.cancelByBusiness(
        String(owned.owner._id),
        "BUSINESS_OWNER",
        String(owned.business._id),
        String(owned.result.booking._id),
        "Closed",
      );
      expect(calendar.deleteEventForBooking).toHaveBeenCalledTimes(1);
      expect(
        await OrdinaryCalendarJournalModel.findOne({ bookingId: owned.result.booking._id }).lean(),
      ).toMatchObject({ mode: "AUTHORITATIVE", latest: { desired: { kind: "ABSENT" } } });
    });
  });
});
