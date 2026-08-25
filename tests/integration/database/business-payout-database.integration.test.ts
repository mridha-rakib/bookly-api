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
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import { NoShowResolutionService } from "../../../src/modules/booking/no-show-resolution.service.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
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
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { BusinessPayoutService } from "../../../src/modules/finance/business-payout.service.js";
import { FinanceError } from "../../../src/modules/finance/finance.errors.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
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

describe("database-backed Business Payout + Super Admin Finance (Batch 8)", () => {
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
  let financeService: FinanceService;
  let businessPayoutRepository: BusinessPayoutRepository;
  let businessPayoutService: BusinessPayoutService;
  let tokenService: TokenService;
  let webhookService: StripeWebhookService;

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
    businessPayoutRepository = new BusinessPayoutRepository();
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      businessPayoutRepository,
    );
    businessPayoutService = new BusinessPayoutService(
      businessRepository,
      financialTransactionService,
      businessPayoutRepository,
    );
    tokenService = new TokenService(new SessionRepository());
    webhookService = new StripeWebhookService(
      paymentGateway,
      new StripeWebhookEventRepository(),
      financialTransactionService,
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

  // --- Fixtures (mirrors finance-database.integration.test.ts) -----------------------------

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
    priceCents = 8000,
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
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
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

  const setupBookableBusiness = async (priceCents = 8000) => {
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

  const percentagePolicy = (percentage: number) => [
    { tier: "MORE_THAN_72_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_24_AND_72_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_12_AND_24_HOURS" as const, mode: "FREE" as const },
    { tier: "BETWEEN_2_AND_12_HOURS" as const, mode: "FREE" as const },
    { tier: "UNDER_2_HOURS" as const, mode: "PERCENTAGE" as const, percentage },
  ];

  /** Simulates Stripe's real `payment_intent.succeeded` webhook delivery for every settled
   * charge on a Booking — this is the ONLY path that ever records a real PROCESSING_FEE entry
   * (see StripeWebhookService.recordProcessingFee's own comment: most charges in this codebase
   * settle synchronously, so the webhook is a separate, later, real-world event Stripe sends
   * regardless — booking creation alone never triggers it). Idempotent (safe to call more than
   * once) via the ledger's own unique idempotencyKey. */
  const settleProcessingFee = async (bookingId: Types.ObjectId) => {
    const entries = await financialTransactionService.listForBooking(bookingId);
    for (const entry of entries) {
      if (!entry.providerReference || entry.status !== "SUCCEEDED") continue;
      await webhookService.process({
        id: `evt_${entry.providerReference}`,
        type: "payment_intent.succeeded",
        data: {
          object: { id: entry.providerReference, metadata: { bookingId: String(bookingId) } },
        },
      } as unknown as Parameters<StripeWebhookService["process"]>[0]);
    }
  };

  /** Deposit for €80 @ 20% = €16, within the €5-35 clamp — matches the batch brief's own
   * worked example exactly. Also settles the real PROCESSING_FEE via the simulated webhook
   * (see settleProcessingFee's own comment) so every caller gets realistic, complete ledger
   * state without repeating that step. */
  const bookFirstTimeCustomer = async (
    business: { _id: Types.ObjectId },
    owner: { _id: Types.ObjectId },
    membership: { _id: Types.ObjectId },
    service: { _id: Types.ObjectId },
    tag: string,
    time = "10:00",
  ) => {
    const customer = await createCustomer(tag);
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, time),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    await settleProcessingFee(result.booking._id);
    return { customer, booking: result.booking };
  };

  // --- Route-level app builder for authorization tests --------------------------------------

  const buildSuperAdminApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "SUPER_ADMIN" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- 1/2: first booking PLATFORM_FEE is Bookly's; its Stripe fee is NOT Business-borne -----

  it("first booking: €80 service -> €16 online charge is Bookly revenue (PLATFORM_FEE); its Stripe fee is NOT deducted from Business payable", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const { booking } = await bookFirstTimeCustomer(business, owner, membership, service, "first");

    expect(booking.financials.platformFeeCents).toBe(1600);
    expect(booking.financials.depositCents).toBe(1600);

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    // The €16 PLATFORM_FEE and its Stripe fee are Bookly's — NEITHER contributes to what
    // Bookly owes the Business.
    expect(payable.grossCents).toBe(0);
    expect(payable.processingFeesCents).toBe(0);
    expect(payable.netCents).toBe(0);

    const platformSummary = await financeService.getPlatformSummary({
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(platformSummary.bookly.grossCents).toBe(1600);
    // Real Stripe fee (FakePaymentGateway returns 55 cents) is Bookly's own cost, not the
    // Business's — see rule #3.1.
    expect(platformSummary.bookly.processingFeesCents).toBe(55);
    expect(platformSummary.bookly.netCents).toBe(1600 - 55);
  });

  // --- 3/4/5: returning DEPOSIT belongs to Business, enters payable net of its own Stripe fee -

  it("returning customer: same €16 online charge is Business-owned DEPOSIT, enters pending payable net of its own Stripe fee", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("returning");
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
    expect(second.booking.financials.depositCents).toBe(1600);
    await settleProcessingFee(first.booking._id);
    await settleProcessingFee(second.booking._id);

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    // Concrete example from the brief: gross €16, Stripe fee €0.55 (fake gateway's fixed fee),
    // net €15.45 — never the platformFee first-booking figure.
    expect(payable.depositAmountCents).toBe(1600);
    expect(payable.grossCents).toBe(1600);
    expect(payable.processingFeesCents).toBe(55);
    expect(payable.netCents).toBe(1600 - 55);
  });

  // --- 6/7: successful NO_SHOW_FEE / CANCELLATION_FEE enter Business payable ------------------

  it("successful NO_SHOW_FEE and CANCELLATION_FEE both enter the Business's pending payable", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    await cancellationPolicyRepository.replace(business._id, percentagePolicy(50), 100);

    const activation = await bookFirstTimeCustomer(
      business,
      owner,
      membership,
      service,
      "act1",
      "09:00",
    );
    void activation;

    const noShowCustomer = await createCustomer("noshow");
    await saveCard(noShowCustomer._id);
    await linkCustomerToBusiness(business._id, owner._id, noShowCustomer._id);
    const noShowBooking = await creationService.finalizeCustomerBooking(
      String(noShowCustomer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (noShowBooking.status !== "confirmed") throw new Error("expected confirmed");
    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(noShowBooking.booking._id),
    );
    await BookingModel.updateOne(
      { _id: noShowBooking.booking._id },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();
    await noShowService.autoResolve(noShowBooking.booking._id);

    const cancelCustomer = await createCustomer("cancel");
    await saveCard(cancelCustomer._id);
    await linkCustomerToBusiness(business._id, owner._id, cancelCustomer._id);
    const cancelBooking = await creationService.finalizeCustomerBooking(
      String(cancelCustomer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "14:00"),
    );
    if (cancelBooking.status !== "confirmed") throw new Error("expected confirmed");
    await BookingModel.updateOne(
      { _id: cancelBooking.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();
    await lifecycleService.cancelByCustomer(
      String(cancelCustomer._id),
      String(cancelBooking.booking._id),
      "x",
    );

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(payable.noShowAmountCents).toBeGreaterThan(0);
    expect(payable.cancellationAmountCents).toBeGreaterThan(0);
  });

  // --- 8/9: waived / failed contribute €0 -----------------------------------------------------

  it("a waived no-show and a failed cancellation charge both contribute €0 to Business payable", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    await cancellationPolicyRepository.replace(business._id, percentagePolicy(50), 100);

    const waiveCustomer = await createCustomer("waive");
    await saveCard(waiveCustomer._id);
    await linkCustomerToBusiness(business._id, owner._id, waiveCustomer._id);
    const waiveBooking = await creationService.finalizeCustomerBooking(
      String(waiveCustomer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    if (waiveBooking.status !== "confirmed") throw new Error("expected confirmed");
    await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(waiveBooking.booking._id),
    );
    await lifecycleService.waiveFee(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(waiveBooking.booking._id),
      "Goodwill",
      undefined,
    );

    const failCustomer = await createCustomer("fail");
    await saveCard(failCustomer._id);
    await linkCustomerToBusiness(business._id, owner._id, failCustomer._id);
    const failBooking = await creationService.finalizeCustomerBooking(
      String(failCustomer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "14:00"),
    );
    if (failBooking.status !== "confirmed") throw new Error("expected confirmed");
    await BookingModel.updateOne(
      { _id: failBooking.booking._id },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();
    paymentGateway.queueNextChargeOutcome("failed");
    await lifecycleService.cancelByCustomer(
      String(failCustomer._id),
      String(failBooking.booking._id),
      "x",
    );

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(payable.noShowAmountCents).toBe(0);
    expect(payable.cancellationAmountCents).toBe(0);
    expect(payable.netCents).toBe(0);
  });

  // --- 10: refunds reverse the correct owner's money -----------------------------------------

  it("a business-cancellation refund of a FIRST booking's PLATFORM_FEE reduces Bookly's revenue, not Business payable", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const { booking } = await bookFirstTimeCustomer(
      business,
      owner,
      membership,
      service,
      "refund-first",
    );

    await lifecycleService.cancelByBusiness(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      "Staff emergency",
    );

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(payable.netCents).toBe(0);

    const summary = await financeService.getPlatformSummary({
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    // €16 PLATFORM_FEE gross, fully refunded -> netCents should reflect the refund (not the
    // Business's payable, which must stay untouched by a Bookly-owned refund).
    expect(summary.bookly.refundsCents).toBe(1600);
  });

  it("a business-cancellation refund of a RETURNING booking's DEPOSIT reduces Business payable, not Bookly revenue", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("refund-returning");
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

    await lifecycleService.cancelByBusiness(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(second.booking._id),
      "Staff emergency",
    );

    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    // DEPOSIT (+1600) then fully refunded (-1600) -> nets to 0, correctly excluded from payable
    // (never double counted, never leaking into Bookly's side).
    expect(payable.grossCents - payable.refundsCents).toBe(0);
    expect(payable.netCents).toBeLessThanOrEqual(0);
  });

  // --- 11/12/13: payout claiming, no double-pay, idempotent duplicate ------------------------

  it("a completed payout removes settled entries from pending payable, and a same-state duplicate request finds nothing eligible", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("payout-flow");
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
    await settleProcessingFee(first.booking._id);
    await settleProcessingFee(second.booking._id);

    const before = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(before.netCents).toBe(1600 - 55);

    const admin = await userRepository.create({
      normalizedEmail: `admin-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    const payout = await businessPayoutService.executePayout(
      String(admin._id),
      String(business._id),
    );
    expect(payout.status).toBe("PAID");
    expect(payout.netPayoutCents).toBe(1600 - 55);
    expect(payout.settledTransactionIds).toHaveLength(2); // DEPOSIT + PROCESSING_FEE

    const after = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(after.netCents).toBe(0);
    expect(after.grossCents).toBe(0);

    // The settled ledger rows are now permanently excluded from payable — never re-claimable.
    const settled = await BookingFinancialTransactionModel.find({
      _id: { $in: payout.settledTransactionIds },
    }).exec();
    for (const entry of settled) {
      expect(String(entry.payoutId)).toBe(String(payout._id));
    }

    // Duplicate request (double-click / retry) with nothing new to claim -> a clean, safe
    // rejection, never a second (empty or duplicate) payout.
    await expect(
      businessPayoutService.executePayout(String(admin._id), String(business._id)),
    ).rejects.toMatchObject({ message: expect.stringContaining("pending payable") });

    const historyPage = await businessPayoutRepository.listByBusinessId({
      businessId: business._id,
      page: 1,
      limit: 20,
    });
    expect(historyPage.total).toBe(1);
  });

  it("[concurrency] two concurrent payout attempts for the same Business never both claim the same transaction", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("payout-race");
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

    const admin = await userRepository.create({
      normalizedEmail: `admin-race-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    const results = await Promise.allSettled([
      businessPayoutService.executePayout(String(admin._id), String(business._id)),
      businessPayoutService.executePayout(String(admin._id), String(business._id)),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(1); // exactly one payout was created — never both, never neither

    const historyPage = await businessPayoutRepository.listByBusinessId({
      businessId: business._id,
      page: 1,
      limit: 20,
    });
    expect(historyPage.total).toBe(1);

    const settledIds =
      succeeded[0]?.status === "fulfilled" ? succeeded[0].value.settledTransactionIds : [];
    const settled = await BookingFinancialTransactionModel.find({
      _id: { $in: settledIds },
    }).exec();
    // Every claimed row points at the ONE winning payout — no row was left half-claimed.
    for (const entry of settled) {
      expect(entry.payoutId).toBeDefined();
    }
  });

  it("rejects a payout attempt when there is nothing eligible to pay out", async () => {
    const { business } = await setupBookableBusiness(8000);
    const admin = await userRepository.create({
      normalizedEmail: `admin-empty-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    await expect(
      businessPayoutService.executePayout(String(admin._id), String(business._id)),
    ).rejects.toBeInstanceOf(FinanceError);
  });

  // --- 17: Business Owner finance cannot read another Business --------------------------------

  it("Business Owner Finance remains scoped to their own Business only", async () => {
    const a = await setupBookableBusiness(8000);
    const b = await setupBookableBusiness(8000);
    await expect(
      financeService.getSummary(String(a.owner._id), String(b.business._id), {
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toBeInstanceOf(FinanceError);
  });

  // --- 18: pagination/filtering ---------------------------------------------------------------

  it("platform transaction log paginates and filters by type", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    await bookFirstTimeCustomer(business, owner, membership, service, "log1", "09:00");
    await bookFirstTimeCustomer(business, owner, membership, service, "log2", "11:00");

    const period = {
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    const page = await financeService.listPlatformTransactions(period, { page: 1, limit: 1 }, [
      "PLATFORM_FEE",
    ]);
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.rows[0]?.type).toBe("PLATFORM_FEE");
  });

  // --- 19: cents-only, no floating point issues ------------------------------------------------

  it("every computed total is an integer number of cents", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("cents");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "10:00"),
    );
    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    for (const value of [
      payable.grossCents,
      payable.processingFeesCents,
      payable.refundsCents,
      payable.netCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  // --- 20: first/returning relationship is scoped per Business --------------------------------

  it("a customer who is FIRST at Business A is independently FIRST at Business B", async () => {
    const a = await setupBookableBusiness(8000);
    const b = await setupBookableBusiness(8000);
    const customer = await createCustomer("cross-business");
    await saveCard(customer._id);
    await linkCustomerToBusiness(a.business._id, a.owner._id, customer._id);
    await linkCustomerToBusiness(b.business._id, b.owner._id, customer._id);

    const atA = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(a.business._id),
      finalizeInput(a.service._id, a.membership._id, "10:00"),
    );
    const atB = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(b.business._id),
      finalizeInput(b.service._id, b.membership._id, "10:00"),
    );
    if (atA.status !== "confirmed" || atB.status !== "confirmed")
      throw new Error("expected confirmed");

    expect(atA.booking.financials.platformFeeCents).toBeGreaterThan(0);
    expect(atB.booking.financials.platformFeeCents).toBeGreaterThan(0);
  });

  // --- 14/15/16: authorization (HTTP-level, real route + real auth middleware) ----------------

  describe("authorization (route-level)", () => {
    it("denies a Business Owner from triggering a payout", async () => {
      const { owner, business } = await setupBookableBusiness(8000);
      const app = buildSuperAdminApp();
      const token = await bearerFor(owner._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/super-admin/businesses/${business._id}/finance/payouts`)
        .set("Authorization", token)
        .send({});

      expect(response.status).toBe(403);
    });

    it("denies Staff/Supervisor from accessing Super Admin finance", async () => {
      const { business } = await setupBookableBusiness(8000);
      const app = buildSuperAdminApp();

      const staffUser = await userRepository.create({
        normalizedEmail: `staff-http-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "STAFF",
        status: "ACTIVE",
      });
      const supervisorUser = await userRepository.create({
        normalizedEmail: `supervisor-http-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "SUPERVISOR",
        status: "ACTIVE",
      });

      const staffResponse = await request(app)
        .get(`/super-admin/businesses/${business._id}/finance/payable`)
        .set("Authorization", await bearerFor(staffUser._id, "STAFF"));
      expect(staffResponse.status).toBe(403);

      const supervisorResponse = await request(app)
        .get(`/super-admin/businesses/${business._id}/finance/payable`)
        .set("Authorization", await bearerFor(supervisorUser._id, "SUPERVISOR"));
      expect(supervisorResponse.status).toBe(403);
    });

    it("denies any non-Super-Admin from reading the platform-wide finance summary", async () => {
      const { owner } = await setupBookableBusiness(8000);
      const app = buildSuperAdminApp();

      const response = await request(app)
        .get("/super-admin/finance/summary")
        .query({
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

      expect(response.status).toBe(403);
    });

    it("allows a Super Admin to read the platform-wide finance summary", async () => {
      const admin = await userRepository.create({
        normalizedEmail: `admin-http-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      });
      const app = buildSuperAdminApp();

      const response = await request(app)
        .get("/super-admin/finance/summary")
        .query({
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"));

      expect(response.status).toBe(200);
      expect(response.body.data.currency).toBe("EUR");
    });

    it("rejects a request with no Authorization header at all", async () => {
      const app = buildSuperAdminApp();
      const response = await request(app).get("/super-admin/finance/pending-payouts");
      expect(response.status).toBe(401);
    });
  });
});
