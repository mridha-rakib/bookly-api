import { Types } from "mongoose";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import {
  packagePurchaseBodySchema,
  redeemPackageSessionBodySchema,
} from "../../../src/modules/booking/booking.schema.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import {
  BookingCreationService,
  type FinalizeBookingResult,
} from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
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
import {
  type BusinessClientDocument,
  BusinessClientModel,
} from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import {
  MoneyRecoveryService,
  STALE_FIRST_REQUIRES_ACTION_MS,
} from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { CyprusTaxService } from "../../../src/modules/payment/tax.service.js";
import { PromoCodeModel } from "../../../src/modules/promo/promo.model.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionModel } from "../../../src/modules/promo/promo-redemption.model.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageModel } from "../../../src/modules/promo/promo-user-usage.model.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { FakeTaxGateway } from "../../helpers/fake-tax-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20";

type Fixture = {
  owner: { _id: Types.ObjectId };
  business: { _id: Types.ObjectId };
  staffId: Types.ObjectId;
  fixedService: { _id: Types.ObjectId };
  packageService: { _id: Types.ObjectId };
};

/**
 * P2.1 — final promo economics + immutable Financial Contract V3, proven against the REAL
 * booking-creation / payment / relationship / ledger / recovery pipeline (fake Stripe and tax
 * gateways only). Approved rules: the promo discounts the NORMAL booking price (services +
 * add-ons − service discount, travel excluded) BEFORE the unchanged FIRST / legacy RETURNING
 * formula runs on the discounted price; the Business funds it (no PROMO_SUBSIDY); promo identity
 * and economics are frozen per operation; usage is consumed only inside persistence.
 */
describe("P2.1 — business-funded booking-price promos + Financial Contract V3", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let bookingService: BookingService;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
  let businessTravelSettingsRepository: BusinessTravelSettingsRepository;
  let paymentGateway: FakePaymentGateway;
  let taxGateway: FakeTaxGateway;
  let paymentService: PaymentService;
  let promoRepository: PromoRepository;
  let creationService: BookingCreationService;
  let webhookService: StripeWebhookService;
  let recoveryService: MoneyRecoveryService;

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
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    bookingRepository = new BookingRepository();
    const claimRepository = new BookingCreationClaimRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
    const packageProgressRepository = new PackageProgressRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);

    paymentGateway = new FakePaymentGateway();
    taxGateway = new FakeTaxGateway();
    const paymentAttemptRepository = new PaymentAttemptRepository();
    const refundOperationRepository = new RefundOperationRepository();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
      paymentAttemptRepository,
      refundOperationRepository,
    );
    const financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const relationshipService = new FinancialRelationshipService(
      new FinancialRelationshipRepository(),
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
      claimRepository,
      clientRepository,
    );
    const availabilityService = new AvailabilityService(
      businessRepository,
      serviceRepository,
      staffRepository,
      staffScheduleRepository,
      new StaffTimeOffRepository(),
      businessHoursRepository,
      new BusinessBookingSettingsRepository(),
      businessTravelSettingsRepository,
      reservationRepository,
    );
    bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      addonRepository,
      addonServiceAssignmentRepository,
      clientRepository,
      bookingRepository,
      packageProgressRepository,
    );
    promoRepository = new PromoRepository();

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      businessTravelSettingsRepository,
      new BusinessCancellationPolicyRepository(),
      bookingRepository,
      claimRepository,
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      new PromoApplicationService(
        promoRepository,
        new PromoUserUsageRepository(),
        new PromoRedemptionRepository(),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      packageProgressRepository,
      new CyprusTaxService(taxGateway),
      relationshipService,
    );
    webhookService = new StripeWebhookService(
      paymentGateway,
      new StripeWebhookEventRepository(),
      financialTransactionService,
      undefined,
      paymentAttemptRepository,
      refundOperationRepository,
      packageProgressRepository,
      bookingRepository,
      relationshipService,
    );
    recoveryService = new MoneyRecoveryService(
      paymentService,
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
      financialTransactionService,
      webhookService,
      packageProgressRepository,
      relationshipService,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ------------------------------------------------------------------------------

  const allDays = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ] as const;

  const setupFixture = async (
    options: {
      fixedPriceCents?: number;
      discountPercent?: number;
      bundlePriceCents?: number;
      travel?: { feeCents: number };
    } = {},
  ): Promise<Fixture> => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Salon P2",
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: options.travel ? "TRAVEL_TO_CUSTOMER" : "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Wellness & Beauty",
      subcategories: ["Massage"],
    } as Parameters<typeof businessRepository.create>[0]);
    const staffUser = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: staffUser._id,
      businessId: business._id,
      role: "STAFF",
      createdByUserId: staffUser._id,
    });
    const servedCities = options.travel ? ["Larnaca"] : [];
    const fixedService = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Wellness & Beauty",
      name: "Massage",
      pricingMode: "FIXED",
      fixedPricing: {
        priceCents: options.fixedPriceCents ?? 10_000,
        durationMin: 60,
        bookingIntervalMin: 60,
        ...(options.discountPercent !== undefined
          ? { discountPercent: options.discountPercent }
          : {}),
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities,
      assignedStaffMembershipIds: [membership._id],
    } as Parameters<typeof serviceRepository.create>[0]);
    const packageService = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: true,
      category: "Wellness & Beauty",
      name: "3 Session Pack",
      packageServicesName: "Deep Tissue Massage",
      packagePricing: {
        durationMin: 60,
        bookingIntervalMin: 60,
        sessionsInPackage: 3,
        bundlePriceCents: options.bundlePriceCents ?? 10_000,
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities,
      assignedStaffMembershipIds: [membership._id],
    } as Parameters<typeof serviceRepository.create>[0]);
    await businessHoursService.putOpeningHours(
      String(owner._id),
      String(business._id),
      allDays.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    await staffScheduleRepository.replace(
      membership._id,
      business._id,
      allDays.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    if (options.travel) {
      await businessTravelSettingsRepository.upsertByBusinessId(business._id, [
        { city: "Larnaca", active: true, feeCents: options.travel.feeCents },
      ]);
    }
    return { owner, business, staffId: membership._id, fixedService, packageService };
  };

  let phoneCounter = 0;
  const createLinkedCustomer = async (fixture: Fixture, tag: string) => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const setupIntent = await paymentService.createSetupIntent(String(customer._id));
    await paymentService.confirmSavedPaymentMethod(String(customer._id), setupIntent.setupIntentId);
    phoneCounter += 1;
    const nationalNumber = String(97_000_000 + phoneCounter);
    const client = await clientRepository.create({
      businessId: fixture.business._id,
      createdByUserId: fixture.owner._id,
      firstName: "Test",
      lastName: "Customer",
      normalizedEmail: customer.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    return { customer, client };
  };

  const createPromo = async (input: {
    code: string;
    type: "PERCENTAGE" | "FIXED";
    value: number;
    totalUsageLimit?: number;
    perUserUsageLimit?: number;
  }) => {
    const superAdmin = await userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });
    return promoRepository.create({
      code: input.code,
      normalizedCode: input.code.toUpperCase(),
      type: input.type,
      value: input.value,
      scope: "ALL_BOOKINGS",
      businessIds: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      totalUsageLimit: input.totalUsageLimit,
      perUserUsageLimit: input.perUserUsageLimit,
      createdByUserId: superAdmin._id,
    });
  };

  const travelFields = {
    customerCity: "Larnaca" as const,
    travelAddress: {
      city: "Larnaca" as const,
      propertyType: "House" as const,
      area: "Center",
      streetName: "Main",
      streetNumber: "1",
    },
  };

  const normalInput = (
    fixture: Fixture,
    time = "10:00",
    extra: { promoCode?: string; addonIds?: string[]; travel?: boolean } = {},
  ) => ({
    serviceLines: [
      {
        serviceId: String(fixture.fixedService._id),
        staffMembershipId: String(fixture.staffId),
        addonIds: extra.addonIds ?? [],
        pricingInput: {},
      },
    ],
    startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
    idempotencyKey: `normal-${new Types.ObjectId().toString()}`,
    ...(extra.travel ? travelFields : {}),
    ...(extra.promoCode ? { promoCode: extra.promoCode } : {}),
  });

  const packageInput = (fixture: Fixture, time = "14:00") => ({
    serviceLines: [
      {
        serviceId: String(fixture.packageService._id),
        staffMembershipId: String(fixture.staffId),
        addonIds: [],
        pricingInput: {},
      },
    ],
    startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
    idempotencyKey: `package-${new Types.ObjectId().toString()}`,
  });

  const finalize = (
    fixture: Fixture,
    customerId: Types.ObjectId,
    input: ReturnType<typeof normalInput>,
  ) =>
    creationService.finalizeCustomerBooking(
      String(customerId),
      String(fixture.business._id),
      input,
    );

  const preview = (
    fixture: Fixture,
    customerId: Types.ObjectId,
    input: ReturnType<typeof normalInput>,
  ) =>
    creationService.previewCustomerBooking(String(customerId), String(fixture.business._id), input);

  const confirmed = (result: FinalizeBookingResult) => {
    if (result.status !== "confirmed") throw new Error(`expected confirmed, got ${result.status}`);
    return result.booking;
  };

  const requiresAction = (result: FinalizeBookingResult) => {
    if (result.status !== "requires_action") {
      throw new Error(`expected requires_action, got ${result.status}`);
    }
    return result;
  };

  const relationshipOf = async (clientId: Types.ObjectId) =>
    (await BusinessClientModel.findById(clientId).orFail().lean().exec()) as BusinessClientDocument;

  const ledgerFor = (bookingId: Types.ObjectId) =>
    BookingFinancialTransactionModel.find({ bookingId }).lean().exec();

  const promoState = async (promoId: Types.ObjectId) => ({
    redeemedCount: (await PromoCodeModel.findById(promoId).orFail().exec()).redeemedCount,
    redemptions: await PromoRedemptionModel.countDocuments({ promoId }).exec(),
  });

  /** Makes this customer RETURNING at the fixture's business with a no-promo booking. */
  const consumeFirst = async (fixture: Fixture, customerId: Types.ObjectId, time = "09:00") =>
    confirmed(await finalize(fixture, customerId, normalInput(fixture, time)));

  const ageSuccess = async (attemptId: Types.ObjectId, ageMs = 10 * 60_000) => {
    const past = new Date(Date.now() - ageMs);
    await PaymentAttemptModel.collection.updateOne(
      { _id: attemptId },
      { $set: { providerSucceededAt: past, createdAt: past } },
    );
  };

  const expectCode = (code: string, statusCode?: number) =>
    expect.objectContaining({
      ...(statusCode ? { statusCode } : {}),
      details: [expect.objectContaining({ code })],
    });

  // --- A + B: calculation + FIRST -------------------------------------------------------------

  describe("normal FIRST", () => {
    it("spec example: €100 base, 20% promo -> €80, FIRST €16, travel €15 undiscounted -> total €95, balance €79; PLATFORM_FEE €16, Business-funded, V3 contract", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 10_000, travel: { feeCents: 1_500 } });
      const { customer, client } = await createLinkedCustomer(fixture, "spec");
      const promo = await createPromo({ code: "TWENTY", type: "PERCENTAGE", value: 20 });
      const input = normalInput(fixture, "10:00", { promoCode: "twenty", travel: true });

      const quote = await preview(fixture, customer._id, input);
      expect(quote).toMatchObject({
        preTaxChargeCents: 1_600,
        balanceDueCents: 7_900,
        promo: { promoEligibleBaseCents: 10_000, discountCents: 2_000 },
      });
      expect(quote.financials).toMatchObject({ totalCents: 9_500, travelFeeCents: 1_500 });

      const booking = confirmed(await finalize(fixture, customer._id, input));

      expect(booking.financials).toMatchObject({
        servicesSubtotalCents: 10_000,
        serviceDiscountCents: 0,
        promoDiscountCents: 2_000,
        eligiblePlatformFeeBasisCents: 8_000,
        travelFeeCents: 1_500,
        totalCents: 9_500,
        depositCents: 1_600,
        platformFeeCents: 1_600,
        balanceDueCents: 7_900,
      });
      expect(booking.financialContract).toMatchObject({
        version: 3,
        productKind: "NORMAL_BOOKING",
        classification: "FIRST",
        promoEligibleBaseCents: 10_000,
        promoDiscountCents: 2_000,
        eligibleBasisCents: 8_000,
        requiredUpfrontCents: 1_600,
        onlineChargeCents: 1_600,
        travelFeeCents: 1_500,
        bookingTotalCents: 9_500,
        upfrontLedgerType: "PLATFORM_FEE",
        promo: {
          normalizedCode: "TWENTY",
          type: "PERCENTAGE",
          value: 20,
          fundingOwner: "BUSINESS",
        },
      });
      expect(String(booking.financialContract?.promo?.promoId)).toBe(String(promo._id));
      expect(booking.promo).toMatchObject({
        discountCents: 2_000,
        chargeCents: 1_600,
        fundingOwner: "BUSINESS",
      });
      expect(paymentGateway.paymentIntentInputs.at(-1)?.amountCents).toBe(1_600);

      const ledger = await ledgerFor(booking._id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "PLATFORM_FEE", amountCents: 1_600 });
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "PROMO_SUBSIDY" })).toBe(
        0,
      );

      const redemption = await PromoRedemptionModel.findOne({ bookingId: booking._id })
        .orFail()
        .lean()
        .exec();
      expect(redemption).toMatchObject({
        fundingOwner: "BUSINESS",
        promoEligibleBaseCents: 10_000,
        promoDiscountCents: 2_000,
        customerChargeNowCents: 1_600,
        isFirstBooking: true,
      });
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });

      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(attempt.financialContractVersion).toBe(3);
      expect(paymentGateway.paymentIntentInputs.at(-1)?.metadata).toMatchObject({
        financialContractVersion: "3",
      });
    });

    it("add-ons are promo-eligible: €100 service + €20 add-on, 10% promo -> €108, FIRST €21.60", async () => {
      const fixture = await setupFixture();
      const addon = await addonRepository.create({
        businessId: fixture.business._id,
        status: "ACTIVE",
        name: "Hot stones",
        priceCents: 2_000,
      });
      await addonServiceAssignmentRepository.insertMany([
        {
          businessId: fixture.business._id,
          addonId: addon._id,
          serviceId: fixture.fixedService._id,
        },
      ]);
      const { customer } = await createLinkedCustomer(fixture, "addon");
      await createPromo({ code: "TEN", type: "PERCENTAGE", value: 10 });

      const booking = confirmed(
        await finalize(
          fixture,
          customer._id,
          normalInput(fixture, "10:00", { promoCode: "TEN", addonIds: [String(addon._id)] }),
        ),
      );
      expect(booking.financials).toMatchObject({
        addonsSubtotalCents: 2_000,
        promoDiscountCents: 1_200,
        eligiblePlatformFeeBasisCents: 10_800,
        depositCents: 2_160,
        totalCents: 10_800,
      });
    });

    it("fractional percentage keeps the current rounding: 12.5% of €33.33 = €4.17 (round half up of 416.625)", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 3_333 });
      const { customer } = await createLinkedCustomer(fixture, "fraction");
      await createPromo({ code: "EIGHTH", type: "PERCENTAGE", value: 12.5 });
      const booking = confirmed(
        await finalize(
          fixture,
          customer._id,
          normalInput(fixture, "10:00", { promoCode: "EIGHTH" }),
        ),
      );
      expect(booking.financials.promoDiscountCents).toBe(417);
      expect(booking.financials.eligiblePlatformFeeBasisCents).toBe(2_916);
      expect(booking.financials.depositCents).toBe(583); // FIRST: 20% of €29.16
    });

    it("100% promo with travel: price €0, FIRST upfront €0 — no PI, no PLATFORM_FEE, travel-only balance, booking persists and consumes FIRST once", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 10_000, travel: { feeCents: 1_500 } });
      const { customer, client } = await createLinkedCustomer(fixture, "free");
      const promo = await createPromo({ code: "FREE", type: "PERCENTAGE", value: 100 });

      const booking = confirmed(
        await finalize(
          fixture,
          customer._id,
          normalInput(fixture, "10:00", { promoCode: "FREE", travel: true }),
        ),
      );

      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(booking.status).toBe("UPCOMING");
      expect(booking.financials).toMatchObject({
        promoDiscountCents: 10_000,
        eligiblePlatformFeeBasisCents: 0,
        travelFeeCents: 1_500,
        totalCents: 1_500,
        depositCents: 0,
        platformFeeCents: 0,
        balanceDueCents: 1_500, // travel only — never charged as FIRST
      });
      expect(booking.financialContract).toMatchObject({
        classification: "FIRST",
        eligibleBasisCents: 0,
        requiredUpfrontCents: 0,
        onlineChargeCents: 0,
      });
      expect(await ledgerFor(booking._id)).toHaveLength(0);
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
    });

    it("no-promo FIRST is unchanged: €100 -> €20 PLATFORM_FEE; V3 with promoEligibleBase == basis and no promo", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "no-promo");
      const booking = confirmed(await finalize(fixture, customer._id, normalInput(fixture)));
      expect(booking.financials).toMatchObject({
        eligiblePlatformFeeBasisCents: 10_000,
        totalCents: 10_000,
        depositCents: 2_000,
        platformFeeCents: 2_000,
      });
      expect(booking.financials.promoDiscountCents).toBeUndefined();
      expect(booking.promo).toBeUndefined();
      expect(booking.financialContract).toMatchObject({
        version: 3,
        promoEligibleBaseCents: 10_000,
        promoDiscountCents: 0,
        eligibleBasisCents: 10_000,
        onlineChargeCents: 2_000,
      });
      expect(booking.financialContract?.promo).toBeUndefined();
    });
  });

  // --- C: RETURNING ----------------------------------------------------------------------------

  describe("normal RETURNING (legacy deposit until P3, on the discounted price)", () => {
    it("20% promo on €100 -> €80; legacy deposit 20% of €80 = €16 as DEPOSIT; no PROMO_SUBSIDY; balance €64", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "returning");
      await consumeFirst(fixture, customer._id);
      await createPromo({ code: "TWENTY", type: "PERCENTAGE", value: 20 });

      const booking = confirmed(
        await finalize(
          fixture,
          customer._id,
          normalInput(fixture, "11:00", { promoCode: "TWENTY" }),
        ),
      );
      expect(bookingService.calculateBookingDepositCents(8_000)).toBe(1_600); // formula unchanged
      expect(booking.financials).toMatchObject({
        promoDiscountCents: 2_000,
        eligiblePlatformFeeBasisCents: 8_000,
        totalCents: 8_000,
        depositCents: 1_600,
        platformFeeCents: 0,
        balanceDueCents: 6_400,
      });
      expect(booking.financialContract).toMatchObject({
        version: 3,
        classification: "RETURNING",
        upfrontLedgerType: "DEPOSIT",
        requiredUpfrontCents: 1_600,
        onlineChargeCents: 1_600,
      });
      const ledger = await ledgerFor(booking._id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "DEPOSIT", amountCents: 1_600 });
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "PROMO_SUBSIDY" })).toBe(
        0,
      );
      expect(booking.promo?.fundingOwner).toBe("BUSINESS");
    });

    it("no-promo RETURNING is unchanged: €100 -> legacy €20 DEPOSIT", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "returning-plain");
      await consumeFirst(fixture, customer._id);
      const booking = confirmed(
        await finalize(fixture, customer._id, normalInput(fixture, "11:00")),
      );
      expect(booking.financials).toMatchObject({ depositCents: 2_000, totalCents: 10_000 });
      const ledger = await ledgerFor(booking._id);
      expect(ledger[0]).toMatchObject({ type: "DEPOSIT", amountCents: 2_000 });
    });

    it("low-value guard: a promo that lowers a RETURNING price below the legacy €5 deposit is rejected BEFORE any provider call, consumes nothing, and the customer can retry without it", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 1_000 });
      const { customer } = await createLinkedCustomer(fixture, "low-value");
      await consumeFirst(fixture, customer._id);
      const promo = await createPromo({ code: "EIGHT", type: "FIXED", value: 800 });
      const piBefore = paymentGateway.paymentIntentInputs.length;
      const taxBefore = taxGateway.calls.length;
      const input = normalInput(fixture, "11:00", { promoCode: "EIGHT" });

      // €10 - €8 = €2 price, but the legacy RETURNING floor is €5 > €2.
      await expect(preview(fixture, customer._id, input)).rejects.toEqual(
        expectCode("PROMO_BELOW_MINIMUM_DEPOSIT", 400),
      );
      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expectCode("PROMO_BELOW_MINIMUM_DEPOSIT", 400),
      );

      expect(paymentGateway.paymentIntentInputs).toHaveLength(piBefore);
      expect(taxGateway.calls).toHaveLength(taxBefore);
      expect(
        await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: input.idempotencyKey }),
      ).toBe(0);
      expect(
        await BookingCreationClaimModel.countDocuments({ idempotencyKey: input.idempotencyKey }),
      ).toBe(0);
      expect(await BookingModel.countDocuments({ promo: { $exists: true } })).toBe(0);
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 0, redemptions: 0 });

      // Changing the terms (dropping the promo) is a clean retry under the SAME key.
      const { promoCode: _dropped, ...withoutPromo } = input;
      const booking = confirmed(await finalize(fixture, customer._id, withoutPromo));
      expect(booking.financials).toMatchObject({ depositCents: 500, totalCents: 1_000 });
    });
  });

  // --- D/F: contract immutability across 3DS ----------------------------------------------------

  describe("Financial Contract V3 immutability across requires_action", () => {
    const startWithPromo = async (promoCode = "FIVE") => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "3ds");
      const promo = await createPromo({ code: "FIVE", type: "FIXED", value: 500 });
      const input = normalInput(fixture, "10:00", { promoCode });
      paymentGateway.queueNextChargeOutcome("requires_action");
      const first = requiresAction(await finalize(fixture, customer._id, input));
      const claim = await BookingCreationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .lean()
        .exec();
      return { fixture, customer, client, promo, input, first, contract: claim.financialContract };
    };

    const expectNoPersistence = async (
      promoId: Types.ObjectId,
      contractBefore: unknown,
      key: string,
    ) => {
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await promoState(promoId)).toEqual({ redeemedCount: 0, redemptions: 0 });
      const claim = await BookingCreationClaimModel.findOne({ idempotencyKey: key })
        .orFail()
        .lean()
        .exec();
      expect(claim.financialContract).toEqual(contractBefore); // never mutated
    };

    it("freezes promo identity and every money term before the charge", async () => {
      const { promo, contract } = await startWithPromo();
      expect(contract).toMatchObject({
        version: 3,
        promoEligibleBaseCents: 10_000,
        promoDiscountCents: 500,
        eligibleBasisCents: 9_500,
        requiredUpfrontCents: 1_900,
        onlineChargeCents: 1_900,
        promo: { normalizedCode: "FIVE", type: "FIXED", value: 500, fundingOwner: "BUSINESS" },
      });
      expect(String(contract?.promo?.promoId)).toBe(String(promo._id));
      expect(paymentGateway.paymentIntentInputs[0]?.amountCents).toBe(1_900);
    });

    it("unchanged promo: the same operation resumes the same PI and persists normally, consuming once", async () => {
      const { fixture, customer, client, promo, input, first } = await startWithPromo();
      paymentGateway.succeedPaymentIntent(first.paymentIntentId);
      const booking = confirmed(await finalize(fixture, customer._id, input));
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(booking.financials.depositCents).toBe(1_900);
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("CONSUMED");
    });

    it("a different code with the SAME numeric discount cannot replace the frozen promo", async () => {
      const { fixture, customer, promo, input, contract } = await startWithPromo();
      await createPromo({ code: "OTHERFIVE", type: "FIXED", value: 500 });
      await expect(
        finalize(fixture, customer._id, { ...input, promoCode: "OTHERFIVE" }),
      ).rejects.toEqual(expectCode("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409));
      await expectNoPersistence(promo._id, contract, input.idempotencyKey);
    });

    it("an edited promo fails closed — even when the edit leaves the discount amount identical", async () => {
      const { fixture, customer, promo, input, contract } = await startWithPromo();
      // FIXED 500 -> 499: a different discount.
      await PromoCodeModel.updateOne({ _id: promo._id }, { $set: { value: 499 } }).exec();
      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expectCode("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409),
      );
      // Type/value edit that still yields €5 (5% of €100): amount-only equality is not enough.
      await PromoCodeModel.updateOne(
        { _id: promo._id },
        { $set: { type: "PERCENTAGE", value: 5 } },
      ).exec();
      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expectCode("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409),
      );
      await expectNoPersistence(promo._id, contract, input.idempotencyKey);
    });

    it.each([
      ["expired", { expiresAt: new Date(Date.now() - 1_000) }, "PROMO_EXPIRED"],
      ["deactivated", { status: "DEACTIVATED" }, "PROMO_DEACTIVATED"],
      ["exhausted", { totalUsageLimit: 1, redeemedCount: 1 }, "PROMO_USAGE_LIMIT_REACHED"],
    ] as const)("a promo %s during 3DS fails the resume closed", async (_label, change, code) => {
      const { fixture, customer, promo, input, contract } = await startWithPromo();
      await PromoCodeModel.collection.updateOne({ _id: promo._id }, { $set: change });
      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expect.objectContaining({ details: [expect.objectContaining({ code })] }),
      );
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PromoRedemptionModel.countDocuments()).toBe(0);
      const claim = await BookingCreationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .lean()
        .exec();
      expect(claim.financialContract).toEqual(contract);
    });

    it("captured 3DS success + promo deactivated before resume: fails closed, P0 compensates exactly once, FIRST restored, usage never consumed", async () => {
      const { fixture, customer, client, promo, input, first } = await startWithPromo();
      paymentGateway.succeedPaymentIntent(first.paymentIntentId);
      await PromoCodeModel.updateOne(
        { _id: promo._id },
        { $set: { status: "DEACTIVATED" } },
      ).exec();

      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expectCode("PROMO_DEACTIVATED"),
      );
      expect(await BookingModel.countDocuments()).toBe(0);

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      // P1.1 stale-FIRST pass observes the provider success; the P0 grace starts from it.
      await PaymentAttemptModel.collection.updateOne(
        { _id: attempt._id },
        { $set: { createdAt: new Date(Date.now() - STALE_FIRST_REQUIRES_ACTION_MS - 60_000) } },
      );
      await recoveryService.runOnce();
      expect(
        (await PaymentAttemptModel.findById(attempt._id).orFail().exec()).compensationStatus,
      ).toBe("NOT_REQUIRED");
      await ageSuccess(attempt._id, STALE_FIRST_REQUIRES_ACTION_MS);
      await recoveryService.runOnce();
      await recoveryService.runOnce(); // a duplicate pass must not refund twice

      const refreshed = await PaymentAttemptModel.findById(attempt._id).orFail().exec();
      expect(refreshed.compensationStatus).toBe("REFUNDED");
      expect(
        await RefundOperationModel.countDocuments({ sourcePaymentAttemptId: attempt._id }),
      ).toBe(1);
      expect(paymentGateway.refundInputs).toHaveLength(1);
      expect(paymentGateway.refundInputs[0]?.amountCents).toBe(1_900);
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          type: { $in: ["PLATFORM_FEE", "DEPOSIT", "PROMO_SUBSIDY"] },
        }),
      ).toBe(0);
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 0, redemptions: 0 });
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
    });
  });

  // --- D38: V2 compatibility ----------------------------------------------------------------------

  describe("V2 compatibility", () => {
    /** An in-flight normal operation recorded by the pre-P2 code: rewrite the claim's contract
     * and the attempt's correlation to their exact V2 shape (no P2 fields). */
    const downgradeToV2 = async (key: string, legacyPromoDiscountCents = 0) => {
      const claim = await BookingCreationClaimModel.findOne({ idempotencyKey: key })
        .orFail()
        .lean()
        .exec();
      const contract = { ...(claim.financialContract as Record<string, unknown>) };
      delete contract["promoEligibleBaseCents"];
      delete contract["promo"];
      contract["version"] = 2;
      contract["promoDiscountCents"] = legacyPromoDiscountCents;
      contract["onlineChargeCents"] =
        (contract["requiredUpfrontCents"] as number) - legacyPromoDiscountCents;
      await BookingCreationClaimModel.collection.updateOne(
        { idempotencyKey: key },
        { $set: { financialContract: contract } },
      );
      await PaymentAttemptModel.collection.updateOne(
        { logicalIdempotencyKey: key },
        { $set: { financialContractVersion: 2 } },
      );
    };

    it("a V2 no-promo operation in flight resumes and persists under its V2 contract", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "v2");
      const input = normalInput(fixture);
      paymentGateway.queueNextChargeOutcome("requires_action");
      const first = requiresAction(await finalize(fixture, customer._id, input));
      await downgradeToV2(input.idempotencyKey);

      paymentGateway.succeedPaymentIntent(first.paymentIntentId);
      const booking = confirmed(await finalize(fixture, customer._id, input));
      expect(booking.financialContract).toMatchObject({
        version: 2,
        eligibleBasisCents: 10_000,
        requiredUpfrontCents: 2_000,
        onlineChargeCents: 2_000,
      });
      expect(booking.financialContract?.promoEligibleBaseCents).toBeUndefined();
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("CONSUMED");
    });

    it("a V2 promo operation cannot be reproduced under P2 economics — it fails closed", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "v2-promo");
      await createPromo({ code: "FIVE", type: "FIXED", value: 500 });
      const input = normalInput(fixture, "10:00", { promoCode: "FIVE" });
      paymentGateway.queueNextChargeOutcome("requires_action");
      requiresAction(await finalize(fixture, customer._id, input));
      await downgradeToV2(input.idempotencyKey, 500);

      await expect(finalize(fixture, customer._id, input)).rejects.toEqual(
        expectCode("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409),
      );
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(await BookingModel.countDocuments()).toBe(0);
    });
  });

  // --- E: usage / concurrency -------------------------------------------------------------------

  describe("usage consumption (no reservation; atomic claims inside persistence)", () => {
    it("duplicate finalize and duplicate success webhooks consume once", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "dupes");
      const promo = await createPromo({ code: "ONCE", type: "PERCENTAGE", value: 10 });
      const input = normalInput(fixture, "10:00", { promoCode: "ONCE" });
      const booking = confirmed(await finalize(fixture, customer._id, input));
      const again = confirmed(await finalize(fixture, customer._id, input));
      expect(String(again._id)).toBe(String(booking._id));

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      const event = {
        id: `evt_${new Types.ObjectId().toString()}`,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: attempt.providerPaymentIntentId,
            amount: attempt.expectedAmountCents,
            currency: "eur",
            customer: attempt.providerCustomerId,
            metadata: paymentGateway.paymentIntentInputs[0]?.metadata ?? {},
          },
        },
      } as unknown as Stripe.Event;
      await webhookService.process(event);
      await webhookService.process(event);
      await webhookService.process({ ...event, id: `evt_${new Types.ObjectId().toString()}` });

      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "PLATFORM_FEE" })).toBe(
        1,
      );
    });

    it("a persistence rollback after the charge consumes nothing and is compensated by P0", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "rollback");
      const promo = await createPromo({ code: "ROLLBACK", type: "PERCENTAGE", value: 10 });
      const original = bookingRepository.create.bind(bookingRepository);
      bookingRepository.create = async () => {
        bookingRepository.create = original;
        throw new Error("injected booking persistence failure");
      };

      await expect(
        finalize(fixture, customer._id, normalInput(fixture, "10:00", { promoCode: "ROLLBACK" })),
      ).rejects.toThrow("injected booking persistence failure");

      expect(await promoState(promo._id)).toEqual({ redeemedCount: 0, redemptions: 0 });
      expect(
        await PromoUserUsageModel.countDocuments({ promoId: promo._id, count: { $gt: 0 } }),
      ).toBe(0);
      expect(await RefundOperationModel.countDocuments()).toBe(1);
      expect(paymentGateway.refundInputs[0]?.amountCents).toBe(1_800); // 20% of €90
    });

    it("two customers racing for the last global unit: exactly one consumes; the loser's charge is compensated", async () => {
      const fixture = await setupFixture();
      const a = await createLinkedCustomer(fixture, "race-a");
      const b = await createLinkedCustomer(fixture, "race-b");
      const promo = await createPromo({
        code: "LAST",
        type: "PERCENTAGE",
        value: 10,
        totalUsageLimit: 1,
      });

      const results = await Promise.allSettled([
        finalize(fixture, a.customer._id, normalInput(fixture, "10:00", { promoCode: "LAST" })),
        finalize(fixture, b.customer._id, normalInput(fixture, "12:00", { promoCode: "LAST" })),
      ]);

      const winners = results.filter((r) => r.status === "fulfilled");
      const losers = results.filter((r) => r.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as PromiseRejectedResult).reason).toEqual(
        expectCode("PROMO_USAGE_LIMIT_REACHED"),
      );
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });
      expect(await BookingModel.countDocuments()).toBe(1);
      // Both validated before payment, so the loser may have been charged — never kept.
      const charged = paymentGateway.paymentIntentInputs.length;
      expect(await RefundOperationModel.countDocuments()).toBe(charged - 1);
    });

    it("two tabs of the same customer cannot exceed the per-user limit", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "tabs");
      await consumeFirst(fixture, customer._id); // RETURNING: no FIRST claim serializes the tabs
      const promo = await createPromo({
        code: "MINE",
        type: "PERCENTAGE",
        value: 10,
        perUserUsageLimit: 1,
      });

      const results = await Promise.allSettled([
        finalize(fixture, customer._id, normalInput(fixture, "11:00", { promoCode: "MINE" })),
        finalize(fixture, customer._id, normalInput(fixture, "13:00", { promoCode: "MINE" })),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toEqual(expectCode("PROMO_PER_USER_LIMIT_REACHED"));
      expect(await promoState(promo._id)).toEqual({ redeemedCount: 1, redemptions: 1 });
      expect(
        await PromoUserUsageModel.findOne({ promoId: promo._id }).orFail().exec(),
      ).toMatchObject({
        count: 1,
      });
    });
  });

  // --- G: package / Session 2+ -------------------------------------------------------------------

  describe("package purchase / redemption stay promo-free", () => {
    it("the package purchase and redemption request schemas reject a promoCode", () => {
      const base = {
        serviceLines: [
          {
            serviceId: new Types.ObjectId().toString(),
            staffMembershipId: new Types.ObjectId().toString(),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: "2030-08-20T07:00:00.000Z",
        idempotencyKey: "pkg-key",
      };
      expect(packagePurchaseBodySchema.safeParse(base).success).toBe(true);
      expect(packagePurchaseBodySchema.safeParse({ ...base, promoCode: "FIVE" }).success).toBe(
        false,
      );
      const redemption = {
        startAt: "2030-08-20T07:00:00.000Z",
        staffMembershipId: new Types.ObjectId().toString(),
        idempotencyKey: "redeem-key",
      };
      expect(redeemPackageSessionBodySchema.safeParse(redemption).success).toBe(true);
      expect(
        redeemPackageSessionBodySchema.safeParse({ ...redemption, promoCode: "FIVE" }).success,
      ).toBe(false);
    });

    it("package FIRST keeps the bundle-price basis under a V2 contract with no promo terms", async () => {
      const fixture = await setupFixture({ bundlePriceCents: 10_000 });
      const { customer } = await createLinkedCustomer(fixture, "package");
      const booking = confirmed(
        await creationService.finalizePackagePurchase(
          String(customer._id),
          String(fixture.business._id),
          packageInput(fixture),
        ),
      );
      expect(booking.financialContract).toMatchObject({
        version: 2,
        productKind: "PACKAGE_PURCHASE",
        eligibleBasisCents: 10_000,
        packageBundlePriceCents: 10_000,
        promoDiscountCents: 0,
        requiredUpfrontCents: 2_000,
      });
      expect(booking.financialContract?.promoEligibleBaseCents).toBeUndefined();
      expect(booking.financialContract?.promo).toBeUndefined();
      expect(booking.financials.promoDiscountCents).toBeUndefined();
      expect(booking.promo).toBeUndefined();
      const attempt = await PaymentAttemptModel.findOne({ productKind: "PACKAGE_PURCHASE" })
        .orFail()
        .exec();
      expect(attempt.financialContractVersion).toBe(2);
    });
  });
});
