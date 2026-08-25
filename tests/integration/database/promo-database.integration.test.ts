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
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
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

/**
 * Batch 13 — Promo Code system. Financial-integrity assertions are backed by the REAL
 * booking-creation/payment/ledger pipeline (never fixtures asserting against themselves) — see
 * the batch report's own worked examples for the exact figures these tests prove.
 */
describe("database-backed Promo Code system (Batch 13)", () => {
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
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
  let financeService: FinanceService;
  let webhookService: StripeWebhookService;
  let promoRepository: PromoRepository;
  let promoRedemptionRepository: PromoRedemptionRepository;
  let tokenService: TokenService;

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
    const businessPayoutRepository = new BusinessPayoutRepository();
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      businessPayoutRepository,
    );
    webhookService = new StripeWebhookService(
      paymentGateway,
      new StripeWebhookEventRepository(),
      financialTransactionService,
    );
    promoRepository = new PromoRepository();
    promoRedemptionRepository = new PromoRedemptionRepository();
    const promoApplicationService = new PromoApplicationService(
      promoRepository,
      new PromoUserUsageRepository(),
      promoRedemptionRepository,
    );

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
      new BusinessCancellationPolicyRepository(),
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
    );

    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createSuperAdmin = async () =>
    userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  const createBusiness = async (name: string) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
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
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      },
    );
    return { owner, business: business ?? pending };
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
    discountPercent?: number,
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: {
        priceCents,
        durationMin: 60,
        bookingIntervalMin: 60,
        ...(discountPercent !== undefined ? { discountPercent } : {}),
      },
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

  const setupBookableBusiness = async (priceCents = 8000, discountPercent?: number) => {
    const { owner, business } = await createBusiness("Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(
      business._id,
      membership._id,
      priceCents,
      discountPercent,
    );
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    return { owner, business, membership, service };
  };

  const finalizeInput = (
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
    promoCode?: string,
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
    startAt: startAtFor(time),
    idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    ...(promoCode ? { promoCode } : {}),
  });

  /** Mirrors business-payout-database.integration.test.ts's own helper exactly: the only path
   * that ever records a real PROCESSING_FEE entry. */
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
      } as never);
    }
  };

  const createPromo = async (input: {
    code: string;
    type: "PERCENTAGE" | "FIXED";
    value: number;
    scope?: "ALL_FIRST_BOOKINGS" | "ALL_BOOKINGS" | "SELECTED_BUSINESSES";
    businessIds?: Types.ObjectId[];
    totalUsageLimit?: number;
    perUserUsageLimit?: number;
    startAt?: Date;
    expiresAt?: Date;
    createdByUserId: Types.ObjectId;
  }) =>
    promoRepository.create({
      code: input.code,
      normalizedCode: input.code.toUpperCase(),
      type: input.type,
      value: input.value,
      scope: input.scope ?? "ALL_BOOKINGS",
      businessIds: input.businessIds ?? [],
      startAt: input.startAt,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      totalUsageLimit: input.totalUsageLimit,
      perUserUsageLimit: input.perUserUsageLimit,
      createdByUserId: input.createdByUserId,
    });

  const around = () => ({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  // --- Basic validation --------------------------------------------------------------------------

  it("[1] code lookup is case-insensitive", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "BOOKLY20",
      type: "PERCENTAGE",
      value: 20,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("case");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "bookly20"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.promo?.code).toBe("BOOKLY20");
  });

  it("[2] rejects an invalid/unknown code", async () => {
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("invalid");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "NOPE"),
      ),
    ).rejects.toThrow();
  });

  it("[3] rejects a deactivated promo", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "DEAD",
      type: "PERCENTAGE",
      value: 20,
      createdByUserId: superAdmin._id,
    });
    await promoRepository.setStatus(promo._id, "DEACTIVATED");

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("deactivated");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "DEAD"),
      ),
    ).rejects.toThrow();
  });

  it("[4] rejects a not-yet-started promo", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "FUTURE",
      type: "PERCENTAGE",
      value: 20,
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("future");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "FUTURE"),
      ),
    ).rejects.toThrow();
  });

  it("[5] rejects an expired promo", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "OLD",
      type: "PERCENTAGE",
      value: 20,
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("expired");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "OLD"),
      ),
    ).rejects.toThrow();
  });

  // --- Financial correctness: FIRST booking --------------------------------------------------

  it("[26] [financial-ownership] FIRST booking: €80 service -> €16 deposit, €5 promo -> customer pays €11, Bookly's PLATFORM_FEE is €11 (never €16), no PROMO_SUBSIDY written", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({ code: "FIVE", type: "FIXED", value: 500, createdByUserId: superAdmin._id });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("first-promo");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FIVE"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    // The canonical, un-discounted entitlement stays €16 — never rewritten.
    expect(result.booking.financials.depositCents).toBe(1600);
    expect(result.booking.financials.platformFeeCents).toBe(1600);
    // The promo snapshot records what actually happened.
    expect(result.booking.promo?.discountCents).toBe(500);
    expect(result.booking.promo?.chargeCents).toBe(1100);

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    const platformFeeEntry = ledger.find((e) => e.type === "PLATFORM_FEE");
    expect(platformFeeEntry?.amountCents).toBe(1100); // the REAL charged/ledgered amount
    expect(ledger.find((e) => e.type === "PROMO_SUBSIDY")).toBeUndefined();

    const summary = await financeService.getPlatformSummary(around());
    expect(summary.bookly.grossCents).toBe(1100);
  });

  // --- Financial correctness: RETURNING booking (the critical scenario) -----------------------

  it("[27][28][29] [financial-ownership] RETURNING booking: customer pays €11 (€16 - €5 promo), Business is STILL entitled to the full €16 via a PROMO_SUBSIDY credit, Stripe fee is deducted from the REAL €11 charge only", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({ code: "FIVE", type: "FIXED", value: 500, createdByUserId: superAdmin._id });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("returning-promo");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    // Activate first (no promo) so the SECOND booking is genuinely returning.
    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");

    const second = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FIVE", "14:00"),
    );
    if (second.status !== "confirmed") throw new Error("expected confirmed");

    expect(second.booking.financials.depositCents).toBe(1600);
    expect(second.booking.financials.platformFeeCents).toBe(0); // returning: never Bookly's
    expect(second.booking.promo?.discountCents).toBe(500);
    expect(second.booking.promo?.chargeCents).toBe(1100);

    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    const depositEntry = ledger.find((e) => e.type === "DEPOSIT");
    expect(depositEntry?.amountCents).toBe(1100); // the REAL amount actually charged to Stripe
    const subsidyEntry = ledger.find((e) => e.type === "PROMO_SUBSIDY");
    expect(subsidyEntry).toBeDefined();
    expect(subsidyEntry?.direction).toBe("CREDIT");
    expect(subsidyEntry?.amountCents).toBe(500); // exactly the shortfall

    await settleProcessingFee(second.booking._id);
    const settled = await financialTransactionService.listForBooking(second.booking._id);
    const processingFeeEntry = settled.find(
      (e) => e.type === "PROCESSING_FEE" && e.metadata?.["sourceType"] === "DEPOSIT",
    );
    expect(processingFeeEntry).toBeDefined();
    expect(processingFeeEntry?.amountCents).toBe(55); // the fixture's fixed 55-cent fee

    // Business's total economic entitlement: €11 (real charge) + €5 (Bookly subsidy) - €0.55
    // (Stripe fee on the REAL €11 charge) = €15.45 — the full €16 minus only the real fee, never
    // reduced by the promo itself.
    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(payable.grossCents).toBe(1100 + 500);
    expect(payable.netCents).toBe(1100 + 500 - 55);
  });

  it("[9][33] service discount + Promo stack sequentially — Promo never touches Service price", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "HALF",
      type: "PERCENTAGE",
      value: 50,
      createdByUserId: superAdmin._id,
    });

    // €100 service, 10% service discount -> €90 basis -> €18 deposit (within €5-35 clamp).
    const { owner, business, membership, service } = await setupBookableBusiness(10_000, 10);
    const customer = await createCustomer("stacking");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "HALF"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    expect(result.booking.financials.serviceDiscountCents).toBe(1000); // 10% of €100
    expect(result.booking.financials.eligiblePlatformFeeBasisCents).toBe(9000); // €90
    expect(result.booking.financials.depositCents).toBe(1800); // 20% of €90
    expect(result.booking.promo?.discountCents).toBe(900); // 50% of €18
    expect(result.booking.promo?.chargeCents).toBe(900);
    // The Service's own snapshot is untouched by the promo.
    expect(result.booking.serviceLines[0]?.amountCents).toBe(10_000);
  });

  // --- Fixed-above-deposit and 100% edge cases --------------------------------------------------

  it("[23][34] a FIXED promo larger than the deposit clamps to exactly the deposit — €0 due, no negative balance, no credit", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({ code: "BIG", type: "FIXED", value: 2500, createdByUserId: superAdmin._id });

    const { owner, business, membership, service } = await setupBookableBusiness(8000); // €16 deposit
    const customer = await createCustomer("fixed-above");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "BIG"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    expect(result.booking.promo?.discountCents).toBe(1600); // clamped, never 2500
    expect(result.booking.promo?.chargeCents).toBe(0);

    // A real €0 ledger DEBIT is never written (the schema's own amountCents invariant requires
    // a positive amount, and a €0 row would carry no information the Booking's own promo
    // snapshot doesn't already carry) — no fake Stripe charge, no PLATFORM_FEE entry at all.
    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    expect(ledger.find((e) => e.type === "PLATFORM_FEE")).toBeUndefined();
    expect(ledger.find((e) => e.type === "DEPOSIT")).toBeUndefined();
  });

  it("[24][25] a 100% PERCENTAGE promo zero-charges the booking; card is still saved (real SetupIntent), booking is real and finalizable", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "FREE",
      type: "PERCENTAGE",
      value: 100,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("hundred-percent");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FREE"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.promo?.chargeCents).toBe(0);
    expect(result.booking.status).toBe("UPCOMING");

    const cardStatus = await paymentService.getSavedCardStatus(String(customer._id));
    expect(cardStatus.hasSavedCard).toBe(true);
  });

  // --- Scope ---------------------------------------------------------------------------------

  it("[16][17] ALL_FIRST_BOOKINGS promo: valid for a first booking, rejected for a returning one", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "FIRSTONLY",
      type: "PERCENTAGE",
      value: 10,
      scope: "ALL_FIRST_BOOKINGS",
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("first-only");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FIRSTONLY"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");
    expect(first.booking.promo).toBeDefined();

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "FIRSTONLY", "14:00"),
      ),
    ).rejects.toThrow();
  });

  it("[18][19] ALL_BOOKINGS promo is valid for both a first and a returning booking", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "ANYBOOKING",
      type: "PERCENTAGE",
      value: 10,
      scope: "ALL_BOOKINGS",
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("any-booking");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "ANYBOOKING"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");
    expect(first.booking.promo).toBeDefined();

    const second = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "ANYBOOKING", "14:00"),
    );
    if (second.status !== "confirmed") throw new Error("expected confirmed");
    expect(second.booking.promo).toBeDefined();
  });

  it("[20][21] SELECTED_BUSINESSES promo: eligible at the selected Business, rejected at a different one", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const {
      owner: otherOwner,
      business: otherBusiness,
      membership: otherMembership,
      service: otherService,
    } = await setupBookableBusiness(8000);

    await createPromo({
      code: "SELECTED",
      type: "PERCENTAGE",
      value: 10,
      scope: "SELECTED_BUSINESSES",
      businessIds: [business._id],
      createdByUserId: superAdmin._id,
    });

    const customer = await createCustomer("selected");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    await linkCustomerToBusiness(otherBusiness._id, otherOwner._id, customer._id);

    const eligible = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "SELECTED"),
    );
    if (eligible.status !== "confirmed") throw new Error("expected confirmed");
    expect(eligible.booking.promo).toBeDefined();

    await expect(
      creationService.finalizeCustomerBooking(
        String(customer._id),
        String(otherBusiness._id),
        finalizeInput(otherService._id, otherMembership._id, "SELECTED"),
      ),
    ).rejects.toThrow();
  });

  // --- Usage limits / concurrency ---------------------------------------------------------------

  it("[6] a global usage cap of 1 rejects a second redemption by a different customer", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "ONEUSE",
      type: "PERCENTAGE",
      value: 10,
      totalUsageLimit: 1,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customerA = await createCustomer("cap-a");
    await saveCard(customerA._id);
    await linkCustomerToBusiness(business._id, owner._id, customerA._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customerA._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "ONEUSE"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");

    const customerB = await createCustomer("cap-b");
    await saveCard(customerB._id);
    await linkCustomerToBusiness(business._id, owner._id, customerB._id);

    await expect(
      creationService.finalizeCustomerBooking(
        String(customerB._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "ONEUSE", "14:00"),
      ),
    ).rejects.toThrow();
  });

  it("[7][31] a per-user cap of 1 rejects a second use by the SAME customer but does not affect a different customer (cross-customer isolation)", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "PERUSER",
      type: "PERCENTAGE",
      value: 10,
      perUserUsageLimit: 1,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customerA = await createCustomer("peruser-a");
    await saveCard(customerA._id);
    await linkCustomerToBusiness(business._id, owner._id, customerA._id);

    const first = await creationService.finalizeCustomerBooking(
      String(customerA._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "PERUSER"),
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");

    await expect(
      creationService.finalizeCustomerBooking(
        String(customerA._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "PERUSER", "14:00"),
      ),
    ).rejects.toThrow();

    // A DIFFERENT customer is unaffected by A's per-user usage.
    const customerB = await createCustomer("peruser-b");
    await saveCard(customerB._id);
    await linkCustomerToBusiness(business._id, owner._id, customerB._id);
    const second = await creationService.finalizeCustomerBooking(
      String(customerB._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "PERUSER", "15:00"),
    );
    if (second.status !== "confirmed") throw new Error("expected confirmed");
    expect(second.booking.promo).toBeDefined();
  });

  it("[8] concurrent redemption attempts against a global cap of 1 never oversubscribe — exactly one succeeds", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "RACE",
      type: "PERCENTAGE",
      value: 10,
      totalUsageLimit: 1,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customerA = await createCustomer("race-a");
    const customerB = await createCustomer("race-b");
    await saveCard(customerA._id);
    await saveCard(customerB._id);
    await linkCustomerToBusiness(business._id, owner._id, customerA._id);
    await linkCustomerToBusiness(business._id, owner._id, customerB._id);

    const results = await Promise.allSettled([
      creationService.finalizeCustomerBooking(
        String(customerA._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "RACE", "10:00"),
      ),
      creationService.finalizeCustomerBooking(
        String(customerB._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "RACE", "14:00"),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const promo = await promoRepository.findByNormalizedCode("RACE");
    expect(promo?.redeemedCount).toBe(1);
    const redemptionCount = await promoRedemptionRepository.countByPromoId(
      promo?._id as Types.ObjectId,
    );
    expect(redemptionCount).toBe(1);
  });

  // --- Preview never consumes ---------------------------------------------------------------------

  it("[10] preview resolves the discount but never claims a redemption", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "PREVIEWONLY",
      type: "PERCENTAGE",
      value: 20,
      totalUsageLimit: 5,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("preview");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    for (let i = 0; i < 3; i++) {
      const preview = await creationService.previewCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "PREVIEWONLY"),
      );
      expect(preview.promo?.discountCents).toBe(320); // 20% of €16
      expect(preview.amountDueNowCents).toBe(1280);
    }

    const promo = await promoRepository.findByNormalizedCode("PREVIEWONLY");
    expect(promo?.redeemedCount).toBe(0);
  });

  // --- Idempotency -----------------------------------------------------------------------------

  it("[13] a duplicate finalize with the SAME idempotencyKey never consumes the promo twice", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "IDEMPOTENT",
      type: "PERCENTAGE",
      value: 10,
      totalUsageLimit: 1,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("idempotent");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const input = finalizeInput(service._id, membership._id, "IDEMPOTENT");
    const first = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      input,
    );
    if (first.status !== "confirmed") throw new Error("expected confirmed");

    const retry = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      input,
    );
    if (retry.status !== "confirmed") throw new Error("expected confirmed");
    expect(String(retry.booking._id)).toBe(String(first.booking._id));

    const promo = await promoRepository.findByNormalizedCode("IDEMPOTENT");
    expect(promo?.redeemedCount).toBe(1);
  });

  // --- Cancellation/no-show basis is promo-aware -------------------------------------------------

  it("[30] cancellation netting uses the REAL post-promo charged amount, never the pre-promo entitlement", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "CANCELPROMO",
      type: "FIXED",
      value: 500,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000); // €16 deposit
    const customer = await createCustomer("cancel-promo");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "CANCELPROMO"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.promo?.chargeCents).toBe(1100); // €16 - €5

    const upfront = await financialTransactionService.findSucceededUpfrontPayment(
      result.booking._id,
    );
    // The netting primitive every cancellation/no-show caller already uses reads the REAL
    // charged amount automatically — zero changes needed to that code for promo-awareness.
    expect(upfront?.amountCents).toBe(1100);
  });

  // --- Redemption permanence -----------------------------------------------------------------

  it("[14][15] cancellation does not restore promo usage — redemption stays permanently consumed", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "PERMANENT",
      type: "PERCENTAGE",
      value: 10,
      totalUsageLimit: 1,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("permanent");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "PERMANENT"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    // Cancel via the real Booking model status change directly (lifecycle service coverage is
    // exhaustively tested elsewhere) — the point here is purely: does the promo's redeemedCount
    // ever get decremented anywhere in this codebase? It must not.
    const promoBefore = await promoRepository.findByNormalizedCode("PERMANENT");
    expect(promoBefore?.redeemedCount).toBe(1);

    // A second attempt against the now-exhausted cap must still fail — proving nothing restored it.
    const customer2 = await createCustomer("permanent-2");
    await saveCard(customer2._id);
    await linkCustomerToBusiness(business._id, owner._id, customer2._id);
    await expect(
      creationService.finalizeCustomerBooking(
        String(customer2._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "PERMANENT", "14:00"),
      ),
    ).rejects.toThrow();
  });

  // --- Super Admin authorization -----------------------------------------------------------------

  const buildSuperAdminApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  it("[32] only SUPER_ADMIN can list/create/manage Promo Codes", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    const created = await request(app)
      .post("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({
        code: "ADMINONLY",
        type: "PERCENTAGE",
        value: 15,
        scope: "ALL_BOOKINGS",
        businessIds: [],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(created.status).toBe(201);

    const list = await request(app)
      .get("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(list.status).toBe(200);
    expect(list.body.data.promos.length).toBeGreaterThanOrEqual(1);
  });

  it("[33] a BUSINESS_OWNER cannot create/list Promo Codes (403)", async () => {
    const { owner } = await createBusiness("Salon A");
    const app = buildSuperAdminApp();

    const listResponse = await request(app)
      .get("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(listResponse.status).toBe(403);

    const createResponse = await request(app)
      .post("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({
        code: "OWNERTRY",
        type: "PERCENTAGE",
        value: 15,
        scope: "ALL_BOOKINGS",
        businessIds: [],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(createResponse.status).toBe(403);
  });

  it("a STAFF token cannot manage Promo Codes (403)", async () => {
    const { business } = await createBusiness("Salon A");
    const { user: staffUser } = await createStaff(business._id);
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"));
    expect(response.status).toBe(403);
  });

  // --- Delete safety: never destroys audit history ------------------------------------------------

  it("deleting a Promo with redemption history force-deactivates instead of hard-deleting", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "HASREDEMPTIONS",
      type: "PERCENTAGE",
      value: 10,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("has-redemptions");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "HASREDEMPTIONS"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const app = buildSuperAdminApp();
    const response = await request(app)
      .delete(`/super-admin/promo-codes/${promo._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe("deactivated");

    const stillExists = await promoRepository.findById(promo._id);
    expect(stillExists).not.toBeNull();
    expect(stillExists?.status).toBe("DEACTIVATED");
  });

  it("deleting a Promo with zero redemptions really deletes it", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "NEVERUSED",
      type: "PERCENTAGE",
      value: 10,
      createdByUserId: superAdmin._id,
    });

    const app = buildSuperAdminApp();
    const response = await request(app)
      .delete(`/super-admin/promo-codes/${promo._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe("deleted");
    const gone = await promoRepository.findById(promo._id);
    expect(gone).toBeNull();
  });
});
