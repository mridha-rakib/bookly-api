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
import { CyprusTaxService } from "../../../src/modules/payment/tax.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { FakeTaxGateway } from "../../helpers/fake-tax-gateway.js";
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
  let promoRepository: PromoRepository;
  let promoRedemptionRepository: PromoRedemptionRepository;
  let tokenService: TokenService;
  let taxGateway: FakeTaxGateway;

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
    taxGateway = new FakeTaxGateway();
    const businessPayoutRepository = new BusinessPayoutRepository();
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      businessPayoutRepository,
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new CyprusTaxService(taxGateway),
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
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
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

  it("[26] [P2] FIRST booking: €80 service, €5 promo -> €75 price, FIRST upfront 20% of €75 = €15 charged in full as PLATFORM_FEE, Business-funded, no PROMO_SUBSIDY", async () => {
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

    // The promo lowers the booking PRICE first; the FIRST formula then runs on €75.
    expect(result.booking.financials).toMatchObject({
      servicesSubtotalCents: 8000,
      promoDiscountCents: 500,
      eligiblePlatformFeeBasisCents: 7500,
      totalCents: 7500,
      depositCents: 1500,
      platformFeeCents: 1500,
      balanceDueCents: 6000,
    });
    expect(result.booking.promo).toMatchObject({
      discountCents: 500,
      chargeCents: 1500,
      fundingOwner: "BUSINESS",
    });

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    const platformFeeEntry = ledger.find((e) => e.type === "PLATFORM_FEE");
    expect(platformFeeEntry?.amountCents).toBe(1500); // U, never U - P
    expect(ledger.find((e) => e.type === "PROMO_SUBSIDY")).toBeUndefined();

    const summary = await financeService.getPlatformSummary(around());
    expect(summary.bookly.grossCents).toBe(1500);
  });

  // --- Financial correctness: RETURNING booking (pre-P3 legacy deposit on the discounted price) --

  it("[27][28][29] [P2/P3] RETURNING booking: €5 promo lowers the price to €75, €0 online (no PI, no ledger), full €75 at the venue, no PROMO_SUBSIDY, Business bears the promo", async () => {
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

    // P2 still lowers the price first; P3 makes the RETURNING upfront €0, so the whole
    // discounted price is the venue balance.
    expect(second.booking.financials).toMatchObject({
      promoDiscountCents: 500,
      eligiblePlatformFeeBasisCents: 7500,
      totalCents: 7500,
      depositCents: 0,
      platformFeeCents: 0, // returning: never Bookly's
      balanceDueCents: 7500,
    });
    expect(second.booking.promo).toMatchObject({
      discountCents: 500,
      chargeCents: 0,
      fundingOwner: "BUSINESS",
    });
    expect(second.booking.financialContract).toMatchObject({
      version: 3,
      classification: "RETURNING",
      upfrontLedgerType: "DEPOSIT",
      requiredUpfrontCents: 0,
      onlineChargeCents: 0,
    });
    // Only the FIRST booking ever reached Stripe.
    expect(paymentGateway.paymentIntentInputs).toHaveLength(1);

    const ledger = await financialTransactionService.listForBooking(second.booking._id);
    expect(ledger).toHaveLength(0); // no DEPOSIT, no PLATFORM_FEE, no PROMO_SUBSIDY

    // The Business bears the promo: nothing was collected online for it (the €75 discounted
    // price is collected at the venue) — no Bookly top-up, nothing payable online.
    const payable = await financeService.getBusinessPayableForSuperAdmin(String(business._id));
    expect(payable.grossCents).toBe(0);
    expect(payable.netCents).toBe(0);
  });

  it("[9][33] [P2] service discount happens BEFORE the promo; the promo never rewrites Service pricing", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "HALF",
      type: "PERCENTAGE",
      value: 50,
      createdByUserId: superAdmin._id,
    });

    // €100 service, 10% service discount -> €90; 50% promo of €90 = €45 -> €45 price;
    // FIRST 20% of €45 = €9.
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

    expect(result.booking.financials).toMatchObject({
      serviceDiscountCents: 1000,
      promoDiscountCents: 4500,
      eligiblePlatformFeeBasisCents: 4500,
      totalCents: 4500,
      depositCents: 900,
    });
    expect(result.booking.financialContract).toMatchObject({
      promoEligibleBaseCents: 9000,
      promoDiscountCents: 4500,
      eligibleBasisCents: 4500,
    });
    expect(result.booking.promo?.chargeCents).toBe(900);
    // The Service's own snapshot is untouched by the promo.
    expect(result.booking.serviceLines[0]?.amountCents).toBe(10_000);
  });

  // --- FIXED-above-price and 100% edge cases ----------------------------------------------------

  it("[23][34] [P2] a FIXED promo larger than the booking price is capped at the price — €0 price, no PaymentIntent, no ledger, no credit", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "BIG",
      type: "FIXED",
      value: 10_000,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("fixed-above");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    const piBefore = paymentGateway.paymentIntentInputs.length;

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "BIG"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    expect(result.booking.promo?.discountCents).toBe(8000); // capped at the price, never €100
    expect(result.booking.promo?.chargeCents).toBe(0);
    expect(result.booking.financials).toMatchObject({
      eligiblePlatformFeeBasisCents: 0,
      totalCents: 0,
      depositCents: 0,
      balanceDueCents: 0,
    });
    expect(paymentGateway.paymentIntentInputs).toHaveLength(piBefore);

    const ledger = await financialTransactionService.listForBooking(result.booking._id);
    expect(ledger).toHaveLength(0);
  });

  it("[24][25] [P2] a 100% PERCENTAGE promo zeroes the FIRST price: €0 due, no PI, card still saved, booking real and UPCOMING", async () => {
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

    const preview = await creationService.previewCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FREE"),
    );
    expect(preview).toMatchObject({
      preTaxChargeCents: 0,
      taxCents: 0,
      dueNowCents: 0,
      balanceDueCents: 0,
    });
    expect(taxGateway.calls).toHaveLength(0);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "FREE"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    expect(result.booking.promo?.chargeCents).toBe(0);
    expect(result.booking.status).toBe("UPCOMING");
    expect(paymentGateway.paymentIntentInputs).toHaveLength(0);

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
      value: 25,
      totalUsageLimit: 5,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(10_000);
    const customer = await createCustomer("preview");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    for (let i = 0; i < 3; i++) {
      const preview = await creationService.previewCustomerBooking(
        String(customer._id),
        String(business._id),
        finalizeInput(service._id, membership._id, "PREVIEWONLY"),
      );
      // P2: 25% off the €100 price = €25 -> €75 price -> FIRST 20% of €75 = €15.
      expect(preview.promo?.promoEligibleBaseCents).toBe(10_000);
      expect(preview.promo?.discountCents).toBe(2_500);
      expect(preview.financials.totalCents).toBe(7_500);
      expect(preview.balanceDueCents).toBe(6_000);
      expect(preview.preTaxChargeCents).toBe(1_500);
      expect(preview.taxCents).toBe(285);
      expect(preview.dueNowCents).toBe(1_785);
      expect(taxGateway.calls.at(-1)?.amountCents).toBe(1_500);
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

  it("[30] [P2] the stored cancellation/no-show basis is the discounted price, and netting reads the real charged upfront", async () => {
    const superAdmin = await createSuperAdmin();
    await createPromo({
      code: "CANCELPROMO",
      type: "FIXED",
      value: 500,
      createdByUserId: superAdmin._id,
    });

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("cancel-promo");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "CANCELPROMO"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    // The field every cancellation/no-show percentage reads (P4/P5 operate on it later).
    expect(result.booking.financials.eligiblePlatformFeeBasisCents).toBe(7500); // €80 - €5
    expect(result.booking.promo?.chargeCents).toBe(1500); // 20% of €75

    const upfront = await financialTransactionService.findSucceededUpfrontPayment(
      result.booking._id,
    );
    expect(upfront?.amountCents).toBe(1500);
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
  ) => `Bearer ${await issueTestAccessToken(tokenService, { userId, role })}`;

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

  // --- P2.0: FIXED promo value is integer cents ---------------------------------------------------

  const promoBody = (overrides: Record<string, unknown>) => ({
    code: "UNITS",
    scope: "ALL_BOOKINGS",
    businessIds: [],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });

  it("[P2.0] create: FIXED integer cents is accepted and stored as-is", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    const response = await request(app)
      .post("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send(promoBody({ type: "FIXED", value: 500 }));

    expect(response.status).toBe(201);
    expect(response.body.data.value).toBe(500);
    const stored = await promoRepository.findByNormalizedCode("UNITS");
    expect(stored?.type).toBe("FIXED");
    expect(stored?.value).toBe(500);
  });

  it("[P2.0] create: FIXED fractional, zero or negative cents is rejected and nothing is stored", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();
    const auth = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    for (const value of [5.5, 0, -100]) {
      const response = await request(app)
        .post("/super-admin/promo-codes")
        .set("Authorization", auth)
        .send(promoBody({ type: "FIXED", value }));
      expect(response.status).toBe(400);
    }
    expect(await promoRepository.findByNormalizedCode("UNITS")).toBeNull();
  });

  it("[P2.0] create: a fractional PERCENTAGE value valid before P2.0 is still accepted", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    const response = await request(app)
      .post("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send(promoBody({ type: "PERCENTAGE", value: 12.5 }));

    expect(response.status).toBe(201);
    expect(response.body.data.value).toBe(12.5);
  });

  it("[P2.0] update: changing an existing FIXED promo's value to fractional cents is rejected", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "FIXEDFIVE",
      type: "FIXED",
      value: 500,
      createdByUserId: superAdmin._id,
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .patch(`/super-admin/promo-codes/${promo._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ value: 5.5 });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].code).toBe("PROMO_INVALID");
    expect((await promoRepository.findById(promo._id))?.value).toBe(500);
  });

  it("[P2.0] update: a type-only switch of a fractional PERCENTAGE promo to FIXED revalidates the effective value and is rejected", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "PCTFRACTION",
      type: "PERCENTAGE",
      value: 5.5,
      createdByUserId: superAdmin._id,
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .patch(`/super-admin/promo-codes/${promo._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ type: "FIXED" });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].code).toBe("PROMO_INVALID");
    const unchanged = await promoRepository.findById(promo._id);
    expect(unchanged?.type).toBe("PERCENTAGE");
    expect(unchanged?.value).toBe(5.5);
  });

  it("[P2.0] update: switching to FIXED with integer cents is accepted", async () => {
    const superAdmin = await createSuperAdmin();
    const promo = await createPromo({
      code: "PCTTOFIXED",
      type: "PERCENTAGE",
      value: 5.5,
      createdByUserId: superAdmin._id,
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .patch(`/super-admin/promo-codes/${promo._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ type: "FIXED", value: 750 });

    expect(response.status).toBe(200);
    const updated = await promoRepository.findById(promo._id);
    expect(updated?.type).toBe("FIXED");
    expect(updated?.value).toBe(750);
  });

  it("[P2.0] money contract: a €5 FIXED promo sent as 500 cents is stored as 500 and discounts exactly €5 off the €80 booking price", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    // What the admin UI sends after converting the €5 input to cents.
    const created = await request(app)
      .post("/super-admin/promo-codes")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send(promoBody({ code: "EUROFIVE", type: "FIXED", value: 500 }));
    expect(created.status).toBe(201);
    expect((await promoRepository.findByNormalizedCode("EUROFIVE"))?.value).toBe(500);

    const { owner, business, membership, service } = await setupBookableBusiness(8000);
    const customer = await createCustomer("eurofive");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
      String(business._id),
      finalizeInput(service._id, membership._id, "EUROFIVE"),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    expect(result.booking.promo?.type).toBe("FIXED");
    expect(result.booking.promo?.value).toBe(500);
    expect(result.booking.promo?.discountCents).toBe(500);
    expect(result.booking.financials.totalCents).toBe(7500);
    expect(result.booking.promo?.chargeCents).toBe(1500); // P2: FIRST 20% of €75
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
