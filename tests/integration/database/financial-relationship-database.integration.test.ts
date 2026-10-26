import mongoose, { Types } from "mongoose";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import {
  BookingCreationService,
  type FinalizeBookingResult,
} from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { BusinessTravelSettingsService } from "../../../src/modules/business-travel-settings/business-travel-settings.service.js";
import {
  type BusinessClientDocument,
  BusinessClientModel,
} from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { computePackageBalanceSettlement } from "../../../src/modules/package-progress/package-progress.rules.js";
import { CustomerPaymentProfileModel } from "../../../src/modules/payment/customer-payment-profile.model.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import {
  MoneyRecoveryService,
  STALE_FIRST_REQUIRES_ACTION_MS,
  STALE_FIRST_UNSENT_MS,
} from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentError } from "../../../src/modules/payment/payment.errors.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import {
  PaymentAttemptModel,
  PROVIDER_NOT_CREATED,
} from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { buildPaymentIntentMetadata } from "../../../src/modules/payment/payment-intent-metadata.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { CyprusTaxService } from "../../../src/modules/payment/tax.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionModel } from "../../../src/modules/promo/promo-redemption.model.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageModel } from "../../../src/modules/promo/promo-user-usage.model.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventModel } from "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { FakeTaxGateway } from "../../helpers/fake-tax-gateway.js";
import { legacyReturningDepositCents } from "../../helpers/legacy-returning-deposit.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20";
const DATE_2 = "2030-08-21";

type Fixture = {
  owner: { _id: Types.ObjectId };
  business: { _id: Types.ObjectId };
  staffId: Types.ObjectId;
  fixedService: { _id: Types.ObjectId };
  packageService: { _id: Types.ObjectId };
};

describe("P1 — universal customer↔business financial relationship + Financial Contract V2", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let availabilityService: AvailabilityService;
  let reservationService: BookingSlotReservationService;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let claimRepository: BookingCreationClaimRepository;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
  let businessTravelSettingsRepository: BusinessTravelSettingsRepository;
  let packageProgressRepository: PackageProgressRepository;
  let paymentGateway: FakePaymentGateway;
  let taxGateway: FakeTaxGateway;
  let paymentAttemptRepository: PaymentAttemptRepository;
  let refundOperationRepository: RefundOperationRepository;
  let paymentService: PaymentService;
  let financialTransactionService: BookingFinancialTransactionService;
  let relationshipRepository: FinancialRelationshipRepository;
  let relationshipService: FinancialRelationshipService;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let webhookService: StripeWebhookService;
  let recoveryService: MoneyRecoveryService;

  beforeAll(async () => {
    const database = await connectIsolatedDatabase();
    expect(mongoose.connection.host).toBe("127.0.0.1");
    expect(database).toMatch(new RegExp(`^bookly_auth_${process.pid}_[a-f0-9]{32}$`));
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.db
          ?.collection("a1_transaction_preflight")
          .insertOne({ verified: true }, { session });
      });
      expect(
        await mongoose.connection.db
          ?.collection("a1_transaction_preflight")
          .findOne({ verified: true }),
      ).toBeTruthy();
      process.stdout.write(`A1 owned transaction preflight PASS: ${database}\n`);
    } finally {
      await session.endSession();
    }
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
    claimRepository = new BookingCreationClaimRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
    packageProgressRepository = new PackageProgressRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    reservationService = new BookingSlotReservationService(reservationRepository);
    const cancellationPolicyRepository = new BusinessCancellationPolicyRepository();

    paymentGateway = new FakePaymentGateway();
    taxGateway = new FakeTaxGateway();
    paymentAttemptRepository = new PaymentAttemptRepository();
    refundOperationRepository = new RefundOperationRepository();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
      paymentAttemptRepository,
      refundOperationRepository,
    );
    financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    relationshipRepository = new FinancialRelationshipRepository();
    relationshipService = new FinancialRelationshipService(
      relationshipRepository,
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
      claimRepository,
      clientRepository,
    );

    availabilityService = new AvailabilityService(
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
    const bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      addonRepository,
      addonServiceAssignmentRepository,
      clientRepository,
      bookingRepository,
      packageProgressRepository,
    );

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      businessTravelSettingsRepository,
      cancellationPolicyRepository,
      bookingRepository,
      claimRepository,
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      new PromoApplicationService(
        new PromoRepository(),
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      packageProgressRepository,
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
      name: "Salon P1",
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
    await businessRepository.casUpdateStatus(business._id, ["PENDING"], "APPROVED", {
      fromStatus: "PENDING",
      actorUserId: business.ownerUserId,
      changedAt: new Date(),
    });
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
    const nationalNumber = String(98_000_000 + phoneCounter);
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

  const startAtFor = (time: string, date = DATE) =>
    businessLocalToUtc(TIMEZONE, date, time).toISOString();

  const normalInput = (
    fixture: Fixture,
    time = "10:00",
    extra: { addonIds?: string[]; travel?: boolean } = {},
  ) => ({
    serviceLines: [
      {
        serviceId: String(fixture.fixedService._id),
        staffMembershipId: String(fixture.staffId),
        addonIds: extra.addonIds ?? [],
        pricingInput: {},
      },
    ],
    startAt: startAtFor(time),
    idempotencyKey: `normal-${new Types.ObjectId().toString()}`,
    ...(extra.travel ? travelFields : {}),
  });

  const packageInput = (
    fixture: Fixture,
    time = "14:00",
    extra: { addonIds?: string[]; travel?: boolean } = {},
  ) => ({
    serviceLines: [
      {
        serviceId: String(fixture.packageService._id),
        staffMembershipId: String(fixture.staffId),
        addonIds: extra.addonIds ?? [],
        pricingInput: {},
      },
    ],
    startAt: startAtFor(time),
    idempotencyKey: `package-${new Types.ObjectId().toString()}`,
    ...(extra.travel ? travelFields : {}),
  });

  const createAddon = async (fixture: Fixture, serviceId: Types.ObjectId, priceCents: number) => {
    const addon = await addonRepository.create({
      businessId: fixture.business._id,
      status: "ACTIVE",
      name: `Addon ${priceCents}`,
      priceCents,
    });
    await addonServiceAssignmentRepository.insertMany([
      { businessId: fixture.business._id, addonId: addon._id, serviceId },
    ]);
    return addon;
  };

  const finalizeNormal = (
    fixture: Fixture,
    customerId: Types.ObjectId,
    input: ReturnType<typeof normalInput>,
  ) =>
    creationService.finalizeCustomerBooking(
      String(customerId),
      String(fixture.business._id),
      input,
    );

  const finalizePackage = (
    fixture: Fixture,
    customerId: Types.ObjectId,
    input: ReturnType<typeof packageInput>,
  ) =>
    creationService.finalizePackagePurchase(
      String(customerId),
      String(fixture.business._id),
      input,
    );

  const confirmed = (result: FinalizeBookingResult) => {
    if (result.status !== "confirmed") throw new Error(`expected confirmed, got ${result.status}`);
    return result.booking;
  };

  const relationshipOf = async (clientId: Types.ObjectId) =>
    (await BusinessClientModel.findById(clientId).orFail().lean().exec()) as BusinessClientDocument;

  const ledgerFor = (bookingId: Types.ObjectId) =>
    BookingFinancialTransactionModel.find({ bookingId }).lean().exec();

  /** Holds every provider PaymentIntent creation until released, so a winner is provably
   * unresolved (FIRST_PENDING, mid-charge) while the competing operation runs to completion. */
  const holdProvider = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const original = paymentGateway.createAndConfirmPaymentIntent.bind(paymentGateway);
    paymentGateway.createAndConfirmPaymentIntent = async (input) => {
      signalEntered();
      await gate;
      return original(input);
    };
    return { release, entered };
  };

  /** Runs two finalize operations truly concurrently. The winner is held inside the provider
   * call; the loser must settle while the winner is still unresolved. */
  const raceWithHeldWinner = async (
    clientId: Types.ObjectId,
    operations: [() => Promise<FinalizeBookingResult>, () => Promise<FinalizeBookingResult>],
  ) => {
    const barrier = holdProvider();
    const promises = operations.map((operation) => operation());
    const firstSettledIndex = await Promise.race(
      promises.map((promise, index) =>
        promise.then(
          () => index,
          () => index,
        ),
      ),
    );
    await barrier.entered;
    const whileHeld = await relationshipOf(clientId);
    const attemptsWhileHeld = await PaymentAttemptModel.countDocuments().exec();
    barrier.release();
    const results = await Promise.allSettled(promises);
    return { results, firstSettledIndex, whileHeld, attemptsWhileHeld };
  };

  const expectFirstInProgress = (reason: unknown) =>
    expect(reason).toMatchObject({
      statusCode: 409,
      details: [{ code: "BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS" }],
    });

  /** Moves an attempt's provider success (and creation) into the past, so the P0 orphan grace —
   * measured from the recorded success since P1.1.1 — has genuinely elapsed. */
  const ageSuccess = async (attemptId: Types.ObjectId, ageMs = 10 * 60_000) => {
    const past = new Date(Date.now() - ageMs);
    await PaymentAttemptModel.collection.updateOne(
      { _id: attemptId },
      { $set: { providerSucceededAt: past, createdAt: past } },
    );
  };

  const injectBookingPersistenceFailureOnce = () => {
    const original = bookingRepository.create.bind(bookingRepository);
    bookingRepository.create = async () => {
      bookingRepository.create = original;
      throw new Error("injected booking persistence failure");
    };
  };

  // --- Atomic first claim / concurrency --------------------------------------------------------

  describe("atomic first claim (concurrency)", () => {
    it("database level: N simultaneous ELIGIBLE -> FIRST_PENDING claims have exactly one winner", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "db-race");
      await relationshipRepository.ensureInitialized(client._id);

      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          relationshipRepository.claimFirst(client._id, {
            idempotencyKey: `db-race-${index}`,
            bookingId: new Types.ObjectId(),
            customerUserId: customer._id,
            productKind: index % 2 === 0 ? "NORMAL_BOOKING" : "PACKAGE_PURCHASE",
          }),
        ),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(1);
    });

    it.each([
      ["normal vs normal", "normal", "normal"],
      ["package vs package", "package", "package"],
      ["normal vs package", "normal", "package"],
    ] as const)(
      "%s: exactly one FIRST winner; the loser gets FIRST_RELATIONSHIP_IN_PROGRESS with no PI and no ledger",
      async (_label, kindA, kindB) => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, "race");
        const inputs = [
          kindA === "normal" ? normalInput(fixture, "10:00") : packageInput(fixture, "10:00"),
          kindB === "normal" ? normalInput(fixture, "14:00") : packageInput(fixture, "14:00"),
        ];
        const run = (kind: "normal" | "package", input: (typeof inputs)[number]) => () =>
          kind === "normal"
            ? finalizeNormal(fixture, customer._id, input as ReturnType<typeof normalInput>)
            : finalizePackage(fixture, customer._id, input as ReturnType<typeof packageInput>);

        const { results, firstSettledIndex, whileHeld, attemptsWhileHeld } =
          await raceWithHeldWinner(client._id, [
            run(kindA, inputs[0] as (typeof inputs)[number]),
            run(kindB, inputs[1] as (typeof inputs)[number]),
          ]);

        // The loser settled while the winner was still unresolved (held mid-charge).
        const loser = results[firstSettledIndex];
        const winner = results[1 - firstSettledIndex];
        expect(loser?.status).toBe("rejected");
        expectFirstInProgress((loser as PromiseRejectedResult).reason);
        expect(whileHeld.financialRelationship?.state).toBe("FIRST_PENDING");
        expect(whileHeld.financialRelationship?.pending?.idempotencyKey).toBe(
          inputs[1 - firstSettledIndex]?.idempotencyKey,
        );
        expect(whileHeld.financialRelationship?.pending?.paymentAttemptId).toBeDefined();
        expect(attemptsWhileHeld).toBe(1);

        // The loser created no PaymentAttempt, no PI, no ledger, and released its booking claim.
        const loserKey = inputs[firstSettledIndex]?.idempotencyKey as string;
        expect(await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: loserKey })).toBe(
          0,
        );
        expect(await BookingCreationClaimModel.countDocuments({ idempotencyKey: loserKey })).toBe(
          0,
        );
        expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
        expect(paymentGateway.paymentIntentInputs[0]?.metadata["relationshipClassification"]).toBe(
          "FIRST",
        );

        // Winner is FIRST, PLATFORM_FEE-ledgered, and consumed the one shared relationship.
        expect(winner?.status).toBe("fulfilled");
        const booking = confirmed((winner as PromiseFulfilledResult<FinalizeBookingResult>).value);
        expect(booking.financialContract?.classification).toBe("FIRST");
        const ledger = await BookingFinancialTransactionModel.find({}).lean().exec();
        expect(ledger.map((entry) => entry.type)).toEqual(["PLATFORM_FEE"]);
        const after = await relationshipOf(client._id);
        expect(after.financialRelationship?.state).toBe("CONSUMED");
        expect(String(after.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));

        // After the winner is CONSUMED, the loser's retry (a new logical action) is RETURNING.
        const loserKind = firstSettledIndex === 0 ? kindA : kindB;
        const retry = confirmed(
          await (loserKind === "normal"
            ? finalizeNormal(fixture, customer._id, normalInput(fixture, "16:00"))
            : finalizePackage(fixture, customer._id, packageInput(fixture, "16:00"))),
        );
        expect(retry.financialContract?.classification).toBe("RETURNING");
        expect(retry.financials.platformFeeCents).toBe(0);
      },
    );
  });

  // --- Same / different logical operation while FIRST_PENDING ---------------------------------

  describe("requires_action / same-operation retry / different operation", () => {
    it("requires_action keeps FIRST_PENDING; a different operation is rejected without a PI; the same operation resumes the same PI and consumes", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "3ds");
      const input = normalInput(fixture, "10:00");
      paymentGateway.queueNextChargeOutcome("requires_action");

      const first = await finalizeNormal(fixture, customer._id, input);
      expect(first.status).toBe("requires_action");
      if (first.status !== "requires_action") throw new Error("expected requires_action");

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(attempt.relationshipClassification).toBe("FIRST");
      expect(attempt.financialContractVersion).toBe(3); // P2: every new normal booking is V3
      let row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(String(row.financialRelationship?.pending?.paymentAttemptId)).toBe(
        String(attempt._id),
      );
      const revisionWhilePending = row.financialRelationship?.revision;

      // A different logical operation (package purchase) while the first is unresolved.
      const other = packageInput(fixture, "14:00");
      await expect(finalizePackage(fixture, customer._id, other)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS" }],
      });
      expect(
        await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: other.idempotencyKey }),
      ).toBe(0);
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revisionWhilePending);

      // Same logical operation after 3DS completes: same claim, same attempt, same PI.
      paymentGateway.succeedPaymentIntent(first.paymentIntentId);
      const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      const claim = await BookingCreationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(String(booking._id)).toBe(String(claim.bookingId));
      expect(
        await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: input.idempotencyKey }),
      ).toBe(1);
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
      expect(booking.financialContract?.classification).toBe("FIRST");
    });

    it("fails closed when the same operation would resume with different money terms (no new PI, claim stays protected)", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "immutable");
      const input = normalInput(fixture, "10:00");
      paymentGateway.queueNextChargeOutcome("requires_action");
      const first = await finalizeNormal(fixture, customer._id, input);
      expect(first.status).toBe("requires_action");

      await ServiceModel.updateOne(
        { _id: fixture.fixedService._id },
        { $set: { "fixedPricing.priceCents": 12_000 } },
      ).exec();

      await expect(finalizeNormal(fixture, customer._id, input)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }],
      });
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      // The REQUIRES_ACTION charge may still complete — the claim must remain protected.
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(await BookingModel.countDocuments()).toBe(0);
    });

    it("a payment_intent.payment_failed webhook for the pending FIRST attempt releases the claim", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "3ds-fail");
      const input = normalInput(fixture, "10:00");
      paymentGateway.queueNextChargeOutcome("requires_action");
      const first = await finalizeNormal(fixture, customer._id, input);
      if (first.status !== "requires_action") throw new Error("expected requires_action");
      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();

      await webhookService.process({
        id: `evt_${new Types.ObjectId().toString()}`,
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: first.paymentIntentId,
            amount: attempt.expectedAmountCents,
            currency: "eur",
            customer: attempt.providerCustomerId,
            metadata: {},
          },
        },
      } as unknown as Stripe.Event);

      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PRE_MONEY_FAILURE");
      expect(String(row.financialRelationship?.lastRelease?.paymentAttemptId)).toBe(
        String(attempt._id),
      );
    });
  });

  // --- FIRST success: normal + package ---------------------------------------------------------

  describe("FIRST success", () => {
    it("normal FIRST: claimed before the provider call, PLATFORM_FEE ledger, consumed atomically with full correlation", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "first-normal");
      const input = normalInput(fixture, "10:00");

      let stateAtProvider: BusinessClientDocument | undefined;
      const original = paymentGateway.createAndConfirmPaymentIntent.bind(paymentGateway);
      paymentGateway.createAndConfirmPaymentIntent = async (charge) => {
        stateAtProvider = await relationshipOf(client._id);
        return original(charge);
      };

      const booking = confirmed(await finalizeNormal(fixture, customer._id, input));

      expect(stateAtProvider?.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(stateAtProvider?.financialRelationship?.pending?.paymentAttemptId).toBeDefined();
      expect(booking.financials).toMatchObject({ depositCents: 2_000, platformFeeCents: 2_000 });
      expect(booking.financialContract).toMatchObject({
        version: 3,
        productKind: "NORMAL_BOOKING",
        classification: "FIRST",
        eligibleBasisCents: 10_000,
        requiredUpfrontCents: 2_000,
        onlineChargeCents: 2_000,
        upfrontLedgerType: "PLATFORM_FEE",
      });

      const ledger = await ledgerFor(booking._id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "PLATFORM_FEE", amountCents: 2_000 });

      const row = await relationshipOf(client._id);
      expect(row.financialRelationship).toMatchObject({
        version: 2,
        state: "CONSUMED",
        initializedFrom: "LEGACY_UNACTIVATED",
      });
      expect(row.financialRelationship?.pending).toBeUndefined();
      expect(row.financialRelationship?.consumed).toMatchObject({
        idempotencyKey: input.idempotencyKey,
        productKind: "NORMAL_BOOKING",
      });
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
      expect(String(row.financialRelationship?.consumed?.financialTransactionId)).toBe(
        String(ledger[0]?._id),
      );
      // Legacy compatibility marker is still stamped (never read for money anymore).
      expect(String(row.activatedByBookingId)).toBe(String(booking._id));

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(attempt).toMatchObject({
        persistenceStatus: "COMPLETED",
        relationshipClassification: "FIRST",
        financialContractVersion: 3,
      });
      const metadata = paymentGateway.paymentIntentInputs[0]?.metadata ?? {};
      expect(metadata).toMatchObject({
        financialContractVersion: "3",
        relationshipClassification: "FIRST",
        productKind: "NORMAL_BOOKING",
        businessClientId: String(client._id),
        booklyPaymentAttemptId: String(attempt._id),
        taxMode: "PRE_ACTIVATION",
      });
    });

    it("package FIRST (spec example): bundle €300 + add-ons €40 + travel €25 -> upfront €35 on the bundle only; PackageProgress committed atomically", async () => {
      const fixture = await setupFixture({ bundlePriceCents: 30_000, travel: { feeCents: 2_500 } });
      const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
      const { customer, client } = await createLinkedCustomer(fixture, "first-package");
      const input = packageInput(fixture, "10:00", {
        addonIds: [String(addon._id)],
        travel: true,
      });

      const booking = confirmed(await finalizePackage(fixture, customer._id, input));

      expect(booking.financialContract).toMatchObject({
        productKind: "PACKAGE_PURCHASE",
        classification: "FIRST",
        eligibleBasisCents: 30_000,
        packageBundlePriceCents: 30_000,
        travelFeeCents: 2_500,
        requiredUpfrontCents: 3_500,
        upfrontLedgerType: "PLATFORM_FEE",
      });
      // Add-ons/travel stay in the Business-collected balance.
      expect(booking.financials).toMatchObject({
        addonsSubtotalCents: 4_000,
        travelFeeCents: 2_500,
        totalCents: 36_500,
        depositCents: 3_500,
        platformFeeCents: 3_500,
        balanceDueCents: 33_000,
      });
      expect(paymentGateway.paymentIntentInputs.at(-1)?.amountCents).toBe(3_500);
      const ledger = await ledgerFor(booking._id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "PLATFORM_FEE", amountCents: 3_500 });
      const progress = await PackageProgressModel.findOne({ originBookingId: booking._id })
        .orFail()
        .exec();
      expect(progress.remainingSessions).toBe(2);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(row.financialRelationship?.consumed?.productKind).toBe("PACKAGE_PURCHASE");
    });

    it("package FIRST basis excludes add-ons where the cap does not mask it: bundle €100 + add-on €40 -> €20 (not €28)", async () => {
      const fixture = await setupFixture({ bundlePriceCents: 10_000 });
      const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
      const { customer } = await createLinkedCustomer(fixture, "first-package-small");

      const booking = confirmed(
        await finalizePackage(
          fixture,
          customer._id,
          packageInput(fixture, "10:00", { addonIds: [String(addon._id)] }),
        ),
      );

      expect(booking.financialContract?.eligibleBasisCents).toBe(10_000);
      expect(booking.financials.depositCents).toBe(2_000);
      expect(booking.financials.eligiblePlatformFeeBasisCents).toBe(14_000);
      expect(booking.financials.balanceDueCents).toBe(12_000);
    });

    it("cap-to-basis: a €3 FIRST basis charges €3 (never the €5 minimum)", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 300 });
      const { customer } = await createLinkedCustomer(fixture, "tiny");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      expect(booking.financials).toMatchObject({
        depositCents: 300,
        platformFeeCents: 300,
        balanceDueCents: 0,
      });
      expect(paymentGateway.paymentIntentInputs.at(-1)?.amountCents).toBe(300);
      const ledger = await ledgerFor(booking._id);
      expect(ledger[0]).toMatchObject({ type: "PLATFORM_FEE", amountCents: 300 });
    });

    it("zero-upfront FIRST: no PI, no fake PLATFORM_FEE row, booking persists and consumes FIRST", async () => {
      const fixture = await setupFixture({ fixedPriceCents: 0 });
      const { customer, client } = await createLinkedCustomer(fixture, "zero");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));

      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(booking.financials).toMatchObject({ depositCents: 0, platformFeeCents: 0 });
      expect(booking.financialContract).toMatchObject({
        classification: "FIRST",
        requiredUpfrontCents: 0,
        onlineChargeCents: 0,
      });
      expect(await ledgerFor(booking._id)).toHaveLength(0);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
    });
  });

  // --- Pre-money failure ----------------------------------------------------------------------

  describe("definitive pre-money failure", () => {
    it("a declined FIRST charge releases to ELIGIBLE; another operation then wins FIRST; the failed operation can never consume", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "declined");
      const failedInput = normalInput(fixture, "10:00");
      paymentGateway.queueNextChargeOutcome("failed");

      await expect(finalizeNormal(fixture, customer._id, failedInput)).rejects.toMatchObject({
        statusCode: 402,
      });
      const failedAttempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: failedInput.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(failedAttempt.providerStatus).toBe("FAILED");
      let row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PRE_MONEY_FAILURE");

      const winner = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture, "14:00")),
      );
      expect(winner.financialContract?.classification).toBe("FIRST");

      const piCount = paymentGateway.paymentIntentInputs.length;
      await expect(finalizeNormal(fixture, customer._id, failedInput)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }],
      });
      expect(paymentGateway.paymentIntentInputs).toHaveLength(piCount);
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(winner._id));
    });

    it("a Stripe Tax failure before any charge releases the claim and the booking claim", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "tax-fail");
      const input = normalInput(fixture);
      taxGateway.queueNextFailure(new Error("tax down"));

      await expect(finalizeNormal(fixture, customer._id, input)).rejects.toBeDefined();
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
      expect(
        await BookingCreationClaimModel.countDocuments({ idempotencyKey: input.idempotencyKey }),
      ).toBe(0);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
    });
  });

  // --- Provider success + persistence failure -> RESTORATION_PENDING ------------------------------

  describe("failed first persistence after money moved", () => {
    const failFirstPersistence = async (
      refundOutcome: "succeeded" | "pending" | "failed",
      kind: "normal" | "package" = "normal",
    ) => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, `persist-${kind}`);
      const input = kind === "normal" ? normalInput(fixture, "10:00") : packageInput(fixture);
      paymentGateway.queueNextRefundOutcome(refundOutcome);
      injectBookingPersistenceFailureOnce();

      await expect(
        kind === "normal"
          ? finalizeNormal(fixture, customer._id, input as ReturnType<typeof normalInput>)
          : finalizePackage(fixture, customer._id, input as ReturnType<typeof packageInput>),
      ).rejects.toThrow("injected booking persistence failure");

      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      const refund = await RefundOperationModel.findOne({
        sourcePaymentAttemptId: attempt._id,
      })
        .orFail()
        .exec();
      return { fixture, customer, client, input, attempt, refund };
    };

    it("never CONSUMED: becomes RESTORATION_PENDING with the P0 RefundOperation; another first cannot start while the refund is pending", async () => {
      const { fixture, customer, client, attempt, refund } = await failFirstPersistence("pending");

      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PackageProgressModel.countDocuments()).toBe(0);
      expect(refund).toMatchObject({
        reason: "BOOKING_PERSISTENCE_COMPENSATION",
        providerStatus: "PROVIDER_PENDING",
        expectedRefundAmountCents: attempt.expectedAmountCents,
      });
      let row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("RESTORATION_PENDING");
      expect(String(row.financialRelationship?.pending?.paymentAttemptId)).toBe(
        String(attempt._id),
      );
      expect(String(row.financialRelationship?.pending?.restorationRefundOperationId)).toBe(
        String(refund._id),
      );
      expect(row.activatedAt).toBeUndefined();

      const piCount = paymentGateway.paymentIntentInputs.length;
      await expect(
        finalizePackage(fixture, customer._id, packageInput(fixture, "14:00")),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS" }],
      });
      expect(paymentGateway.paymentIntentInputs).toHaveLength(piCount);

      // Still pending at the provider -> recovery leaves it protected.
      await recoveryService.runOnce();
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("RESTORATION_PENDING");

      // Provider confirms the exact full refund -> recovery converges to ELIGIBLE.
      paymentGateway.succeedRefund(refund.providerRefundId as string);
      await recoveryService.runOnce();
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease).toMatchObject({
        reason: "COMPENSATION_REFUNDED",
      });
      expect(String(row.financialRelationship?.lastRelease?.refundOperationId)).toBe(
        String(refund._id),
      );

      // ...and the customer can now genuinely be FIRST again.
      const next = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture, "16:00")),
      );
      expect(next.financialContract?.classification).toBe("FIRST");
    });

    it("a synchronously-succeeded compensation refund restores ELIGIBLE immediately (package purchase)", async () => {
      const { client } = await failFirstPersistence("succeeded", "package");
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
    });

    it("the charge.refunded webhook restores ELIGIBLE for the exact compensation refund", async () => {
      const { client, attempt, refund } = await failFirstPersistence("pending");
      await webhookService.process({
        id: `evt_${new Types.ObjectId().toString()}`,
        type: "charge.refunded",
        data: {
          object: {
            id: `ch_${new Types.ObjectId().toString()}`,
            payment_intent: attempt.providerPaymentIntentId,
            metadata: {},
            refunds: {
              data: [
                {
                  id: refund.providerRefundId,
                  amount: refund.expectedRefundAmountCents,
                  currency: "eur",
                  status: "succeeded",
                  metadata: { booklyRefundOperationId: String(refund._id) },
                },
              ],
            },
          },
        },
      } as unknown as Stripe.Event);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
    });

    it("a failed compensation refund keeps RESTORATION_PENDING", async () => {
      const { client } = await failFirstPersistence("failed");
      await relationshipService.reconcile(client._id);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("RESTORATION_PENDING");
    });

    it("partial, mismatched or wrongly-correlated refunds never restore eligibility", async () => {
      const { client, attempt, refund } = await failFirstPersistence("pending");
      await PaymentAttemptModel.updateOne(
        { _id: attempt._id },
        { $set: { compensationStatus: "REFUNDED" } },
      ).exec();
      const exact = {
        providerStatus: "SUCCEEDED",
        expectedRefundAmountCents: refund.expectedRefundAmountCents,
        sourcePaymentAttemptId: attempt._id,
        sourcePaymentIntentId: refund.sourcePaymentIntentId,
        reason: "BOOKING_PERSISTENCE_COMPENSATION",
      };
      const variants: Array<Record<string, unknown>> = [
        { expectedRefundAmountCents: refund.expectedRefundAmountCents - 100 },
        { sourcePaymentAttemptId: new Types.ObjectId() },
        { sourcePaymentIntentId: "pi_some_other_intent" },
        { reason: "BUSINESS_CANCELLATION" },
        { providerStatus: "RECONCILIATION_REQUIRED" },
      ];
      for (const variant of variants) {
        await RefundOperationModel.collection.updateOne(
          { _id: refund._id },
          { $set: { ...exact, ...variant } },
        );
        await relationshipService.reconcile(client._id);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state, JSON.stringify(variant)).toBe(
          "RESTORATION_PENDING",
        );
      }

      await RefundOperationModel.collection.updateOne({ _id: refund._id }, { $set: exact });
      await relationshipService.reconcile(client._id);
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");
    });
  });

  // --- Crash recovery --------------------------------------------------------------------------

  describe("recovery after a crash between provider success and persistence", () => {
    const crashAfterCharge = async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "crash");
      const input = normalInput(fixture, "10:00");
      const original = paymentService.claimPaymentPersistence.bind(paymentService);
      paymentService.claimPaymentPersistence = async () => {
        paymentService.claimPaymentPersistence = original;
        throw new Error("simulated process crash");
      };
      await expect(finalizeNormal(fixture, customer._id, input)).rejects.toThrow(
        "simulated process crash",
      );
      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      expect(attempt).toMatchObject({
        providerStatus: "SUCCEEDED",
        persistenceStatus: "NOT_STARTED",
      });
      return { fixture, customer, client, input, attempt };
    };

    it("does not unlock merely because the Booking is absent; the same operation completes consumption", async () => {
      const { fixture, customer, client, input } = await crashAfterCharge();

      await relationshipService.reconcile(client._id);
      await recoveryService.runOnce();
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("FIRST_PENDING");

      const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
    });

    it("an orphaned succeeded charge is compensated by the worker and only then restored to ELIGIBLE", async () => {
      const { client, attempt } = await crashAfterCharge();
      // An old attempt alone is not an orphan: the grace runs from the recorded success.
      await PaymentAttemptModel.collection.updateOne(
        { _id: attempt._id },
        { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } },
      );
      await recoveryService.runOnce();
      expect(
        (await PaymentAttemptModel.findById(attempt._id).orFail().exec()).compensationStatus,
      ).toBe("NOT_REQUIRED");
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("FIRST_PENDING");

      await ageSuccess(attempt._id);
      await recoveryService.runOnce();

      const refreshed = await PaymentAttemptModel.findById(attempt._id).orFail().exec();
      expect(refreshed.compensationStatus).toBe("REFUNDED");
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
      expect(await BookingModel.countDocuments()).toBe(0);
    });
  });

  // --- Fencing / no blind unlock -----------------------------------------------------------------

  describe("fencing", () => {
    it("an unbound claim is released only after its pre-dispatch lease, and the abandoned owner can then never dispatch", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "lease");
      await relationshipRepository.ensureInitialized(client._id);
      const bookingId = new Types.ObjectId();
      await relationshipRepository.claimFirst(client._id, {
        idempotencyKey: "abandoned-op",
        bookingId,
        customerUserId: customer._id,
        productKind: "NORMAL_BOOKING",
      });

      await relationshipService.reconcilePending();
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("FIRST_PENDING");

      await BusinessClientModel.updateOne(
        { _id: client._id },
        { $set: { "financialRelationship.pending.claimLeaseExpiresAt": new Date(Date.now() - 1) } },
      ).exec();
      await relationshipService.reconcilePending();
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PRE_DISPATCH_ABANDONED");

      await expect(
        paymentService.chargeBookingDeposit({
          userId: customer._id,
          amountCents: 2_000,
          idempotencyKey: "abandoned-op",
          metadata: {
            bookingId: String(bookingId),
            businessId: String(fixture.business._id),
            businessClientId: String(client._id),
            purpose: "BOOKING_DEPOSIT",
          },
          financialContract: {
            version: 2,
            classification: "FIRST",
            productKind: "NORMAL_BOOKING",
            businessClientId: client._id,
          },
          beforeProviderDispatch: (attempt) =>
            relationshipService.bindPaymentAttempt(client._id, "abandoned-op", attempt._id),
        }),
      ).rejects.toMatchObject({ details: [{ code: "BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS" }] });
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
    });

    it("the recovery scan rotates past claims that cannot resolve yet instead of starving newer ones", async () => {
      const fixture = await setupFixture();
      const stuck = await createLinkedCustomer(fixture, "stuck");
      const fresh = await createLinkedCustomer(fixture, "fresh");
      for (const [index, { customer, client }] of [stuck, fresh].entries()) {
        await relationshipRepository.ensureInitialized(client._id);
        await relationshipRepository.claimFirst(client._id, {
          idempotencyKey: `rotate-${index}`,
          bookingId: new Types.ObjectId(),
          customerUserId: customer._id,
          productKind: "NORMAL_BOOKING",
        });
      }

      const firstPass = await relationshipRepository.listPending(1);
      await relationshipService.reconcilePending(1);
      const secondPass = await relationshipRepository.listPending(1);
      expect(String(secondPass[0]?._id)).not.toBe(String(firstPass[0]?._id));
      // Still unresolved (lease not expired) — rotation never changes state.
      for (const { client } of [stuck, fresh]) {
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe(
          "FIRST_PENDING",
        );
      }
    });

    it("stale/wrong-owner transitions are no-ops; CONSUMED can never be released", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "fence");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      const consumed = await relationshipOf(client._id);
      const revision = consumed.financialRelationship?.revision as number;

      const attemptId = new Types.ObjectId();
      expect(
        await relationshipRepository.releaseFirstClaim(client._id, {
          idempotencyKey: consumed.financialRelationship?.consumed?.idempotencyKey as string,
          reason: "PRE_MONEY_FAILURE",
          unbound: true,
        }),
      ).toBe(false);
      expect(
        await relationshipRepository.restoreAfterCompensation(client._id, {
          idempotencyKey: consumed.financialRelationship?.consumed?.idempotencyKey as string,
          paymentAttemptId: attemptId,
          refundOperationId: new Types.ObjectId(),
          expectedRevision: revision,
        }),
      ).toBe(false);
      expect(
        await relationshipRepository.markRestorationPending(client._id, {
          idempotencyKey: "other",
          paymentAttemptId: attemptId,
          expectedRevision: revision,
        }),
      ).toBe(false);
      await relationshipService.reconcilePending();
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
      expect(after.financialRelationship?.revision).toBe(revision);
      expect(String(after.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
    });
  });

  // --- P1.1: first-payment lifecycle --------------------------------------------------------------

  describe("P1.1 — first-payment lifecycle (abandoned 3DS, cancellation, re-confirmable failure)", () => {
    const startFirstRequiresAction = async (tag: string, kind: "normal" | "package" = "normal") => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, tag);
      const input = kind === "normal" ? normalInput(fixture, "10:00") : packageInput(fixture);
      paymentGateway.queueNextChargeOutcome("requires_action");
      const result =
        kind === "normal"
          ? await finalizeNormal(fixture, customer._id, input)
          : await finalizePackage(fixture, customer._id, input);
      if (result.status !== "requires_action") throw new Error("expected requires_action");
      expect(result.clientSecret).toEqual(expect.any(String));
      const attempt = await PaymentAttemptModel.findOne({
        logicalIdempotencyKey: input.idempotencyKey,
      })
        .orFail()
        .exec();
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(String(row.financialRelationship?.pending?.paymentAttemptId)).toBe(
        String(attempt._id),
      );
      return {
        fixture,
        customer,
        client,
        input,
        attempt,
        paymentIntentId: result.paymentIntentId,
        revision: row.financialRelationship?.revision as number,
      };
    };

    const makeStale = async (attemptId: Types.ObjectId) => {
      await PaymentAttemptModel.collection.updateOne(
        { _id: attemptId },
        { $set: { createdAt: new Date(Date.now() - STALE_FIRST_REQUIRES_ACTION_MS - 60_000) } },
      );
    };

    const piEvent = (
      type:
        | "payment_intent.succeeded"
        | "payment_intent.payment_failed"
        | "payment_intent.canceled",
      attempt: { expectedAmountCents: number; providerCustomerId: string },
      paymentIntentId: string,
      options: { metadata?: Record<string, string>; eventId?: string } = {},
    ) =>
      ({
        id: options.eventId ?? `evt_${new Types.ObjectId().toString()}`,
        type,
        data: {
          object: {
            id: paymentIntentId,
            amount: attempt.expectedAmountCents,
            currency: "eur",
            customer: attempt.providerCustomerId,
            metadata: options.metadata ?? {},
            ...(type === "payment_intent.canceled" ? { cancellation_reason: "abandoned" } : {}),
          },
        },
      }) as unknown as Stripe.Event;

    /** The attempt's PaymentIntent metadata, exactly as Stripe would echo it on its events. */
    const piMetadata = (attemptId: Types.ObjectId) =>
      paymentGateway.paymentIntentInputs.find(
        (entry) => entry.metadata["booklyPaymentAttemptId"] === String(attemptId),
      )?.metadata as Record<string, string>;

    const attemptOf = (id: Types.ObjectId) => PaymentAttemptModel.findById(id).orFail().exec();
    const ledgerCount = (filter: Record<string, unknown> = {}) =>
      BookingFinancialTransactionModel.countDocuments(filter).exec();

    it("generic cleanup never releases a bound requires_action claim, even after its pre-dispatch lease expired", async () => {
      const { client, attempt, revision } = await startFirstRequiresAction("abandoned");
      await BusinessClientModel.updateOne(
        { _id: client._id },
        { $set: { "financialRelationship.pending.claimLeaseExpiresAt": new Date(Date.now() - 1) } },
      ).exec();

      expect(
        await relationshipRepository.releaseFirstClaim(client._id, {
          idempotencyKey: attempt.logicalIdempotencyKey,
          reason: "PRE_DISPATCH_ABANDONED",
          unbound: true,
          requireLeaseExpiredBefore: new Date(),
        }),
      ).toBe(false);
      await relationshipService.reconcilePending();
      await relationshipService.releaseAfterPreMoneyFailure(
        client._id,
        attempt.logicalIdempotencyKey,
      );
      await recoveryService.runOnce();

      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revision);
      expect((await attemptOf(attempt._id)).providerStatus).toBe("REQUIRES_ACTION");
      // Not stale yet: the dedicated pass does not even read the provider.
      expect(paymentGateway.retrievedPaymentIntentIds).toHaveLength(0);
    });

    it("stale + Stripe still requires_action: stays reserved, no ledger, no consumption, backed off", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("still-3ds");
      await makeStale(attempt._id);

      const counts = await recoveryService.runOnce();

      expect(counts).toMatchObject({ staleFirstRequiresAction: 1, errors: 0 });
      expect(paymentGateway.retrievedPaymentIntentIds).toEqual([paymentIntentId]);
      const refreshed = await attemptOf(attempt._id);
      expect(refreshed.providerStatus).toBe("REQUIRES_ACTION");
      expect(refreshed.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revision);
      expect(await ledgerCount()).toBe(0);
      expect(await BookingModel.countDocuments()).toBe(0);

      // Backed off: the next pass does not hammer the provider.
      await recoveryService.runOnce();
      expect(paymentGateway.retrievedPaymentIntentIds).toHaveLength(1);
    });

    it("stale + Stripe canceled: attempt terminal CANCELED, FIRST released exactly once, customer can be FIRST again", async () => {
      const { fixture, customer, client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("stale-canceled");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "canceled");
      await makeStale(attempt._id);

      await recoveryService.runOnce();

      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "CANCELED",
        lastErrorCode: "PROVIDER_CANCELED",
        lastErrorMessage: "Stripe cancellation_reason: abandoned",
      });
      let row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect(row.financialRelationship?.lastRelease).toMatchObject({
        reason: "PROVIDER_CANCELED",
        idempotencyKey: attempt.logicalIdempotencyKey,
      });
      expect(String(row.financialRelationship?.lastRelease?.paymentAttemptId)).toBe(
        String(attempt._id),
      );

      await recoveryService.runOnce();
      await relationshipService.reconcilePending();
      await relationshipService.reconcileForPaymentAttempt(attempt._id);
      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect(await ledgerCount()).toBe(0);

      const next = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture, "14:00")),
      );
      expect(next.financialContract?.classification).toBe("FIRST");
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("CONSUMED");
    });

    it("stale + Stripe succeeded, the customer's same-key finalize wins: FIRST consumed exactly once, one PLATFORM_FEE, no refund", async () => {
      const { fixture, customer, client, input, attempt, paymentIntentId } =
        await startFirstRequiresAction("stale-succeeded");
      paymentGateway.succeedPaymentIntent(paymentIntentId);
      await makeStale(attempt._id);

      // Deterministic interleaving: the customer's post-3DS finalize lands right after the stale
      // pass recorded the provider success and before the P0 orphan pass looks at it.
      let booking: Awaited<ReturnType<typeof finalizeNormal>> | undefined;
      const original = relationshipService.reconcileForPaymentAttempt.bind(relationshipService);
      relationshipService.reconcileForPaymentAttempt = async (id) => {
        relationshipService.reconcileForPaymentAttempt = original;
        expect((await attemptOf(attempt._id)).providerStatus).toBe("SUCCEEDED");
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe(
          "FIRST_PENDING",
        );
        booking = await finalizeNormal(fixture, customer._id, input);
        return original(id);
      };

      await recoveryService.runOnce();

      const persisted = confirmed(booking as Awaited<ReturnType<typeof finalizeNormal>>);
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(paymentGateway.refundInputs).toHaveLength(0);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("CONSUMED");
      expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(persisted._id));
      expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(1);
      expect(await ledgerCount({ type: "REFUND" })).toBe(0);
      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "SUCCEEDED",
        persistenceStatus: "COMPLETED",
        compensationStatus: "NOT_REQUIRED",
      });
    });

    it("stale + Stripe succeeded with no finalize: never released early, P0 compensates once, FIRST never consumed", async () => {
      const { client, attempt, paymentIntentId } = await startFirstRequiresAction("stale-orphan");
      paymentGateway.succeedPaymentIntent(paymentIntentId);
      await makeStale(attempt._id);

      // Success just observed by the stale pass: the grace starts now, not at attempt creation.
      await recoveryService.runOnce();
      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "SUCCEEDED",
        compensationStatus: "NOT_REQUIRED",
      });
      expect(paymentGateway.refundInputs).toHaveLength(0);
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("FIRST_PENDING");

      await ageSuccess(attempt._id, STALE_FIRST_REQUIRES_ACTION_MS);
      await recoveryService.runOnce();
      await recoveryService.runOnce();

      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "SUCCEEDED",
        compensationStatus: "REFUNDED",
      });
      expect(paymentGateway.refundInputs).toHaveLength(1);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      // Released only by the exact compensation refund — never as a pre-money failure.
      expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
      expect(row.financialRelationship?.consumed).toBeUndefined();
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(0);
    });

    it("stale + Stripe processing: stays protected", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("stale-processing");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "processing");
      await makeStale(attempt._id);

      await recoveryService.runOnce();

      expect((await attemptOf(attempt._id)).providerStatus).toBe("PROCESSING");
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revision);
      expect(await ledgerCount()).toBe(0);
    });

    it("transient provider error: nothing released, retried later", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("stripe-down");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "canceled");
      paymentGateway.failNextRetrieve(new Error("stripe temporarily unavailable"));
      await makeStale(attempt._id);

      const counts = await recoveryService.runOnce();

      expect(counts.errors).toBeGreaterThanOrEqual(1);
      const refreshed = await attemptOf(attempt._id);
      expect(refreshed.providerStatus).toBe("REQUIRES_ACTION");
      expect(refreshed.lastErrorMessage).toBe("stripe temporarily unavailable");
      expect(refreshed.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revision);

      // Once due again, the authoritative answer (canceled) converges it.
      await PaymentAttemptModel.updateOne(
        { _id: attempt._id },
        { $set: { nextRecoveryAt: new Date(Date.now() - 1) } },
      ).exec();
      await recoveryService.runOnce();
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");
    });

    it("mismatched relationship/attempt ownership: safe no-op, no provider read", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("mismatch");
      await BusinessClientModel.updateOne(
        { _id: client._id },
        { $set: { "financialRelationship.pending.paymentAttemptId": new Types.ObjectId() } },
      ).exec();
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "canceled");
      await makeStale(attempt._id);

      await recoveryService.runOnce();

      expect(paymentGateway.retrievedPaymentIntentIds).not.toContain(paymentIntentId);
      const refreshed = await attemptOf(attempt._id);
      expect(refreshed.providerStatus).toBe("REQUIRES_ACTION");
      expect(refreshed.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
      expect(row.financialRelationship?.revision).toBe(revision);
    });

    it("payment_intent.canceled webhook releases a bound FIRST once; duplicates and late failures are no-ops", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("webhook-canceled");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "canceled");
      const event = piEvent("payment_intent.canceled", attempt, paymentIntentId);

      expect(await webhookService.process(event)).toBe(true);

      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "CANCELED",
        lastErrorCode: "PROVIDER_CANCELED",
        lastErrorMessage: "Stripe cancellation_reason: abandoned",
      });
      let row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PROVIDER_CANCELED");
      expect(
        (await StripeWebhookEventModel.findOne({ eventId: event.id }).orFail().exec()).status,
      ).toBe("PROCESSED");

      // Same event redelivered, a distinct duplicate event, and a late payment_failed.
      expect(await webhookService.process(event)).toBe(false);
      expect(
        await webhookService.process(piEvent("payment_intent.canceled", attempt, paymentIntentId)),
      ).toBe(true);
      await webhookService.process(
        piEvent("payment_intent.payment_failed", attempt, paymentIntentId),
      );
      await recoveryService.runOnce();

      row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect((await attemptOf(attempt._id)).providerStatus).toBe("CANCELED");
      expect(await ledgerCount()).toBe(0);
    });

    it("payment_intent.canceled releases a package-purchase FIRST with the same semantics", async () => {
      const { client, attempt, paymentIntentId, revision } = await startFirstRequiresAction(
        "package-canceled",
        "package",
      );
      expect(attempt.productKind).toBe("PACKAGE_PURCHASE");

      await webhookService.process(piEvent("payment_intent.canceled", attempt, paymentIntentId));

      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PROVIDER_CANCELED");
      expect(await PackageProgressModel.countDocuments()).toBe(0);
      expect(await ledgerCount()).toBe(0);
    });

    it("a canceled event after a legitimate success never reverses it (retained for investigation)", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "success-then-cancel");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      const before = await relationshipOf(client._id);
      const attempt = await PaymentAttemptModel.findOne({ bookingId: booking._id }).orFail().exec();
      const ledgerBefore = await ledgerCount();
      const event = piEvent(
        "payment_intent.canceled",
        attempt,
        attempt.providerPaymentIntentId as string,
      );

      await webhookService.process(event);

      expect(
        (await StripeWebhookEventModel.findOne({ eventId: event.id }).orFail().exec()).status,
      ).toBe("FAILED");
      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "SUCCEEDED",
        persistenceStatus: "COMPLETED",
      });
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
      expect(after.financialRelationship?.revision).toBe(before.financialRelationship?.revision);
      expect(await BookingModel.countDocuments({ _id: booking._id })).toBe(1);
      expect(await ledgerCount()).toBe(ledgerBefore);
    });

    it("requires_payment_method after client_secret exposure is not a seal: a re-confirmed success re-claims and consumes exactly once", async () => {
      const { fixture, customer, client, input, attempt, paymentIntentId } =
        await startFirstRequiresAction("reconfirm");
      expect(
        (await PaymentAttemptModel.findById(attempt._id).select("+clientSecret").orFail())
          .clientSecret,
      ).toEqual(expect.any(String));

      // 3DS fails -> requires_payment_method. P1 behaviour kept: the customer may retry.
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "failed");
      await webhookService.process(
        piEvent("payment_intent.payment_failed", attempt, paymentIntentId),
      );
      expect((await attemptOf(attempt._id)).providerStatus).toBe("FAILED");
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");

      // The exposed client_secret is re-confirmed and succeeds: the success is accepted (not an
      // investigation), and only waits for the source ledger row like any early webhook.
      paymentGateway.succeedPaymentIntent(paymentIntentId);
      const metadata = piMetadata(attempt._id);
      const succeeded = piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
        metadata,
      });
      await expect(webhookService.process(succeeded)).rejects.toThrow(/not persisted yet/);
      expect((await attemptOf(attempt._id)).providerStatus).toBe("SUCCEEDED");
      expect(
        (await StripeWebhookEventModel.findOne({ eventId: succeeded.id }).orFail().exec()).status,
      ).toBe("RETRYABLE");

      // Same logical operation resumes: same PI, re-claims FIRST, consumes once.
      const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      const consumed = await relationshipOf(client._id);
      expect(consumed.financialRelationship?.state).toBe("CONSUMED");
      expect(String(consumed.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));

      // Duplicate / redelivered succeeded events: no second consumption, no duplicate ledger.
      for (let index = 0; index < 2; index += 1) {
        await webhookService.process(
          piEvent("payment_intent.succeeded", attempt, paymentIntentId, { metadata }),
        );
      }
      await recoveryService.runOnce();
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.revision).toBe(consumed.financialRelationship?.revision);
      expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(1);
      expect(await ledgerCount({ type: "PROCESSING_FEE" })).toBe(1);
      expect(paymentGateway.refundInputs).toHaveLength(0);
    });

    it("a late re-confirmed success after another operation consumed FIRST is refunded by P0, never double-consumed", async () => {
      const { fixture, customer, client, attempt, paymentIntentId } =
        await startFirstRequiresAction("late-success");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "failed");
      await webhookService.process(
        piEvent("payment_intent.payment_failed", attempt, paymentIntentId),
      );

      // The customer retries under a NEW key (as the frontend does after a 402) and wins FIRST.
      const winner = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture, "14:00")),
      );
      const consumed = await relationshipOf(client._id);
      expect(consumed.financialRelationship?.state).toBe("CONSUMED");

      paymentGateway.succeedPaymentIntent(paymentIntentId);
      await expect(
        webhookService.process(
          piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
            metadata: piMetadata(attempt._id),
          }),
        ),
      ).rejects.toThrow(/not persisted yet/);
      await ageSuccess(attempt._id);
      await recoveryService.runOnce();

      expect(await attemptOf(attempt._id)).toMatchObject({
        providerStatus: "SUCCEEDED",
        compensationStatus: "REFUNDED",
      });
      expect(paymentGateway.refundInputs.map((refund) => refund.amountCents)).toEqual([
        attempt.expectedAmountCents,
      ]);
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
      expect(after.financialRelationship?.revision).toBe(consumed.financialRelationship?.revision);
      expect(String(after.financialRelationship?.consumed?.bookingId)).toBe(String(winner._id));
    });

    it("race: stale recovery and the canceled webhook converge to one release", async () => {
      const { client, attempt, paymentIntentId, revision } =
        await startFirstRequiresAction("race-cancel");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "canceled");
      await makeStale(attempt._id);

      await Promise.all([
        recoveryService.runOnce(),
        webhookService.process(piEvent("payment_intent.canceled", attempt, paymentIntentId)),
        relationshipService.reconcilePending(),
      ]);

      expect((await attemptOf(attempt._id)).providerStatus).toBe("CANCELED");
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship?.state).toBe("ELIGIBLE");
      expect(row.financialRelationship?.revision).toBe(revision + 1);
      expect(row.financialRelationship?.lastRelease?.reason).toBe("PROVIDER_CANCELED");
    });

    it("race: a stale provider read never overwrites a newer success or releases on it", async () => {
      const { client, attempt, paymentIntentId } = await startFirstRequiresAction("race-stale");
      paymentGateway.setPaymentIntentStatus(paymentIntentId, "failed");
      await makeStale(attempt._id);

      // The recovery worker's provider read observes requires_payment_method; before it records
      // that, the customer re-confirms and the success webhook lands first.
      const originalRetrieve = paymentGateway.retrievePaymentIntent.bind(paymentGateway);
      paymentGateway.retrievePaymentIntent = async (id) => {
        paymentGateway.retrievePaymentIntent = originalRetrieve;
        const staleSnapshot = await originalRetrieve(id);
        paymentGateway.succeedPaymentIntent(paymentIntentId);
        await webhookService
          .process(
            piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
              metadata: piMetadata(attempt._id),
            }),
          )
          .catch(() => undefined);
        return staleSnapshot;
      };

      await recoveryService.runOnce();

      // The stale FAILED read lost: the success stands and is never released as a failure.
      let refreshed = await attemptOf(attempt._id);
      expect(refreshed.providerStatus).toBe("SUCCEEDED");
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("FIRST_PENDING");

      // No finalize ever arrives: once the success itself outlives the grace, P0 compensates.
      await ageSuccess(attempt._id, STALE_FIRST_REQUIRES_ACTION_MS);
      await recoveryService.runOnce();
      refreshed = await attemptOf(attempt._id);
      const row = await relationshipOf(client._id);
      // Converged through P0 compensation of the orphaned success — never a pre-money release.
      expect(row.financialRelationship?.lastRelease?.reason).not.toBe("PRE_MONEY_FAILURE");
      expect(["RESTORATION_PENDING", "ELIGIBLE"]).toContain(row.financialRelationship?.state);
      expect(refreshed.compensationStatus).toBe("REFUNDED");
      expect(paymentGateway.refundInputs).toHaveLength(1);
    });

    it("(pre-P3 in-flight) RETURNING requires_action attempts are never scanned by the FIRST-only pass and the relationship is never touched", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "returning-3ds");
      confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "10:00")));
      const consumed = await relationshipOf(client._id);

      // P3: a new RETURNING purchase is €0 online and never creates an attempt. A RETURNING
      // requires_action attempt can only be pre-P3 history, so create exactly that shape through
      // the real payment service (RETURNING correlation, real PaymentIntent).
      const idempotencyKey = `legacy-returning-3ds-${new Types.ObjectId().toString()}`;
      paymentGateway.queueNextChargeOutcome("requires_action");
      const result = await paymentService.chargeBookingDeposit({
        userId: customer._id,
        amountCents: 2_000,
        idempotencyKey,
        metadata: buildPaymentIntentMetadata({
          bookingId: new Types.ObjectId().toString(),
          businessId: String(fixture.business._id),
          businessClientId: String(client._id),
          purpose: "BOOKING_DEPOSIT",
          preTaxChargeCents: 2_000,
          taxCents: 0,
          chargedAmountCents: 2_000,
          taxMode: "PRE_ACTIVATION",
          financialContract: {
            version: 3,
            classification: "RETURNING",
            productKind: "NORMAL_BOOKING",
          },
        }),
        financialContract: {
          version: 3,
          classification: "RETURNING",
          productKind: "NORMAL_BOOKING",
          businessClientId: client._id,
        },
      });
      if (result.status !== "requires_action") throw new Error("expected requires_action");
      const attempt = await PaymentAttemptModel.findOne({ logicalIdempotencyKey: idempotencyKey })
        .orFail()
        .exec();
      expect(attempt.relationshipClassification).toBe("RETURNING");
      paymentGateway.setPaymentIntentStatus(result.paymentIntentId, "canceled");
      await makeStale(attempt._id);

      await recoveryService.runOnce();
      expect(paymentGateway.retrievedPaymentIntentIds).not.toContain(result.paymentIntentId);
      expect((await attemptOf(attempt._id)).providerStatus).toBe("REQUIRES_ACTION");

      // The canceled webhook is still recorded on the attempt, but RETURNING never mutates
      // the (already CONSUMED) relationship.
      await webhookService.process(
        piEvent("payment_intent.canceled", attempt, result.paymentIntentId),
      );
      expect((await attemptOf(attempt._id)).providerStatus).toBe("CANCELED");
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
      expect(after.financialRelationship?.revision).toBe(consumed.financialRelationship?.revision);
    });

    // --- P1.1.1 Gap 2: bound FIRST attempt with no recorded PaymentIntent ---------------------

    describe("P1.1.1 — bound FIRST attempt with no recorded PaymentIntent", () => {
      /**
       * Fails the FIRST charge at the provider boundary, after the claim was bound:
       *  - `pi: false` — the request never produced a PaymentIntent (rejected / never reached
       *    Stripe); `pi: true` — Stripe created it (with `outcome`) but the response was lost;
       *  - `crash: true` — the process died before even recording UNKNOWN (stays NOT_CREATED).
       * Stripe search is then made to lag, so only the strongly consistent list can see a PI.
       */
      const startFirstUnsent = async (
        tag: string,
        options: {
          pi: boolean;
          crash?: boolean;
          outcome?: "succeeded" | "requires_action" | "failed";
          kind?: "normal" | "package";
        },
      ) => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, tag);
        const input =
          options.kind === "package" ? packageInput(fixture) : normalInput(fixture, "10:00");
        if (options.outcome) paymentGateway.queueNextChargeOutcome(options.outcome);
        const originalCreate = paymentGateway.createAndConfirmPaymentIntent.bind(paymentGateway);
        paymentGateway.createAndConfirmPaymentIntent = async (request) => {
          paymentGateway.createAndConfirmPaymentIntent = originalCreate;
          if (options.pi) await originalCreate(request);
          throw new PaymentError("PAYMENT_FAILED", 402);
        };
        if (options.crash) {
          const originalMark =
            paymentAttemptRepository.markProviderUnknown.bind(paymentAttemptRepository);
          paymentAttemptRepository.markProviderUnknown = async () => {
            paymentAttemptRepository.markProviderUnknown = originalMark;
            throw new Error("simulated process crash");
          };
        }

        await expect(
          options.kind === "package"
            ? finalizePackage(fixture, customer._id, input)
            : finalizeNormal(fixture, customer._id, input),
        ).rejects.toBeDefined();
        paymentGateway.searchLagging = true;

        const attempt = await PaymentAttemptModel.findOne({
          logicalIdempotencyKey: input.idempotencyKey,
        })
          .orFail()
          .exec();
        expect(attempt.providerStatus).toBe(options.crash ? "NOT_CREATED" : "UNKNOWN");
        expect(attempt.providerPaymentIntentId).toBeUndefined();
        const row = await relationshipOf(client._id);
        // The pre-P1.1.1 dead end: bound, so no unbound cleanup or failure path can release it.
        expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
        expect(String(row.financialRelationship?.pending?.paymentAttemptId)).toBe(
          String(attempt._id),
        );
        return {
          fixture,
          customer,
          client,
          input,
          attempt,
          revision: row.financialRelationship?.revision as number,
        };
      };

      const makeUnsentStale = async (attemptId: Types.ObjectId) => {
        await PaymentAttemptModel.collection.updateOne(
          { _id: attemptId },
          { $set: { createdAt: new Date(Date.now() - STALE_FIRST_UNSENT_MS - 60_000) } },
        );
      };

      /** The PaymentIntent the fake provider holds for an attempt (bypasses the call counter). */
      const providerPaymentIntentIdOf = async (attempt: {
        _id: Types.ObjectId;
        providerCustomerId: string;
      }) => {
        const lookup = await paymentGateway.findCustomerPaymentIntentByAttempt({
          stripeCustomerId: attempt.providerCustomerId,
          paymentAttemptId: String(attempt._id),
          createdSince: new Date(0),
        });
        paymentGateway.customerListCalls = 0;
        if (lookup.outcome !== "FOUND_ONE") throw new Error("expected a provider PaymentIntent");
        return lookup.value.paymentIntentId;
      };

      const expectUntouched = async (
        client: { _id: Types.ObjectId },
        attemptId: Types.ObjectId,
        revision: number,
        providerStatus: string,
      ) => {
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("FIRST_PENDING");
        expect(row.financialRelationship?.revision).toBe(revision);
        expect((await attemptOf(attemptId)).providerStatus).toBe(providerStatus);
      };

      it("NOT_CREATED crash with no PI: proven absent, closed, FIRST released once; same key fails closed; a new key claims FIRST", async () => {
        const { fixture, customer, client, input, attempt, revision } = await startFirstUnsent(
          "unsent-crash",
          { pi: false, crash: true },
        );
        await makeUnsentStale(attempt._id);

        const counts = await recoveryService.runOnce();

        expect(counts).toMatchObject({ staleFirstUnsent: 1 });
        expect(paymentGateway.customerListCalls).toBe(1);
        const closed = await attemptOf(attempt._id);
        expect(closed).toMatchObject({
          providerStatus: "FAILED",
          lastErrorCode: PROVIDER_NOT_CREATED,
        });
        expect(closed.providerPaymentIntentId).toBeUndefined();
        let row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.revision).toBe(revision + 1);
        expect(row.financialRelationship?.lastRelease).toMatchObject({
          reason: "PRE_MONEY_FAILURE",
          idempotencyKey: input.idempotencyKey,
        });
        expect(String(row.financialRelationship?.lastRelease?.paymentAttemptId)).toBe(
          String(attempt._id),
        );

        await recoveryService.runOnce();
        await relationshipService.reconcilePending();
        row = await relationshipOf(client._id);
        expect(row.financialRelationship?.revision).toBe(revision + 1);

        // The closed operation can never dispatch: existing 402 semantics, no PaymentIntent.
        await expect(finalizeNormal(fixture, customer._id, input)).rejects.toMatchObject({
          statusCode: 402,
          details: [{ code: "PAYMENT_FAILED" }],
        });
        expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");
        expect(await attemptOf(attempt._id)).toMatchObject({
          providerStatus: "FAILED",
          lastErrorCode: PROVIDER_NOT_CREATED,
        });

        // The customer's retry under a NEW key is FIRST as normal.
        paymentGateway.searchLagging = false;
        const booking = confirmed(
          await finalizeNormal(fixture, customer._id, normalInput(fixture, "12:00")),
        );
        expect(booking.financialContract?.classification).toBe("FIRST");
        row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("CONSUMED");
        expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
        expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(1);
      });

      it("UNKNOWN with no PI (rejected / never reached Stripe): proven absent and released safely", async () => {
        const { client, attempt, revision } = await startFirstUnsent("unsent-unknown", {
          pi: false,
        });
        await makeUnsentStale(attempt._id);

        await recoveryService.runOnce();

        expect(await attemptOf(attempt._id)).toMatchObject({
          providerStatus: "FAILED",
          lastErrorCode: PROVIDER_NOT_CREATED,
        });
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.revision).toBe(revision + 1);
        expect(await ledgerCount()).toBe(0);
      });

      it("package FIRST with no PI resolves with the same semantics", async () => {
        const { client, attempt, revision } = await startFirstUnsent("unsent-package", {
          pi: false,
          kind: "package",
        });
        expect(attempt.productKind).toBe("PACKAGE_PURCHASE");
        await makeUnsentStale(attempt._id);

        await recoveryService.runOnce();

        expect((await attemptOf(attempt._id)).lastErrorCode).toBe(PROVIDER_NOT_CREATED);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.revision).toBe(revision + 1);
        expect(await PackageProgressModel.countDocuments()).toBe(0);
      });

      it("NOT_CREATED, search misses but the list finds a requires_action PI: recorded, never released, no duplicate PI", async () => {
        const { fixture, customer, client, input, attempt, revision } = await startFirstUnsent(
          "lost-3ds",
          { pi: true, crash: true, outcome: "requires_action" },
        );
        await makeUnsentStale(attempt._id);

        await recoveryService.runOnce();

        expect(paymentGateway.customerListCalls).toBe(1);
        const recorded = await attemptOf(attempt._id);
        expect(recorded.providerStatus).toBe("REQUIRES_ACTION");
        expect(recorded.providerPaymentIntentId).toEqual(expect.any(String));
        expect(recorded.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
        await expectUntouched(client, attempt._id, revision, "REQUIRES_ACTION");

        // The same operation resumes the SAME PaymentIntent — never a second one.
        const resumed = await finalizeNormal(fixture, customer._id, input);
        expect(resumed.status).toBe("requires_action");
        expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      });

      it("UNKNOWN, search misses but the list finds a succeeded PI: recorded, not released, not compensated; same-key finalize consumes once", async () => {
        const { fixture, customer, client, input, attempt, revision } = await startFirstUnsent(
          "lost-success",
          { pi: true, outcome: "succeeded" },
        );
        await makeUnsentStale(attempt._id);
        const before = Date.now();

        await recoveryService.runOnce();

        const recorded = await attemptOf(attempt._id);
        expect(recorded).toMatchObject({
          providerStatus: "SUCCEEDED",
          compensationStatus: "NOT_REQUIRED",
        });
        expect(recorded.providerSucceededAt?.getTime()).toBeGreaterThanOrEqual(before);
        expect(paymentGateway.refundInputs).toHaveLength(0);
        await expectUntouched(client, attempt._id, revision, "SUCCEEDED");

        const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
        expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("CONSUMED");
        expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
        expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(1);
      });

      it("the list finds a processing PI: kept reserved", async () => {
        const { client, attempt, revision } = await startFirstUnsent("lost-processing", {
          pi: true,
          outcome: "requires_action",
        });
        paymentGateway.setPaymentIntentStatus(
          await providerPaymentIntentIdOf(attempt),
          "processing",
        );
        await makeUnsentStale(attempt._id);

        await recoveryService.runOnce();

        await expectUntouched(client, attempt._id, revision, "PROCESSING");
      });

      it("the list finds a canceled PI: the existing canceled flow releases", async () => {
        const { client, attempt, revision } = await startFirstUnsent("lost-canceled", {
          pi: true,
          outcome: "requires_action",
        });
        paymentGateway.setPaymentIntentStatus(await providerPaymentIntentIdOf(attempt), "canceled");
        await makeUnsentStale(attempt._id);

        await recoveryService.runOnce();

        expect(await attemptOf(attempt._id)).toMatchObject({
          providerStatus: "CANCELED",
          lastErrorCode: "PROVIDER_CANCELED",
        });
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.revision).toBe(revision + 1);
        expect(row.financialRelationship?.lastRelease?.reason).toBe("PROVIDER_CANCELED");
      });

      it("provider lookup error: nothing released, backed off", async () => {
        const { client, attempt, revision } = await startFirstUnsent("lookup-error", {
          pi: false,
        });
        await makeUnsentStale(attempt._id);
        paymentGateway.failNextCustomerList(new Error("stripe list unavailable"));

        const counts = await recoveryService.runOnce();

        expect(counts.errors).toBeGreaterThanOrEqual(1);
        await expectUntouched(client, attempt._id, revision, "UNKNOWN");
        const refreshed = await attemptOf(attempt._id);
        expect(refreshed.lastErrorMessage).toBe("stripe list unavailable");
        expect(refreshed.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
      });

      it("never resolves when the attempt does not own the claim, the relationship is consumed, persistence/compensation started, or it is too young", async () => {
        const variants: Array<{
          name: string;
          prepare: (ctx: {
            client: { _id: Types.ObjectId };
            attempt: { _id: Types.ObjectId };
          }) => Promise<void>;
          expectFirstPending: boolean;
        }> = [
          {
            name: "not owner",
            expectFirstPending: true,
            prepare: async ({ client }) => {
              await BusinessClientModel.updateOne(
                { _id: client._id },
                {
                  $set: { "financialRelationship.pending.paymentAttemptId": new Types.ObjectId() },
                },
              ).exec();
            },
          },
          {
            name: "relationship consumed",
            expectFirstPending: false,
            prepare: async ({ client }) => {
              await BusinessClientModel.updateOne(
                { _id: client._id },
                {
                  $set: { "financialRelationship.state": "CONSUMED" },
                  $unset: { "financialRelationship.pending": 1 },
                },
              ).exec();
            },
          },
          {
            name: "persistence started",
            expectFirstPending: true,
            prepare: async ({ attempt }) => {
              await PaymentAttemptModel.collection.updateOne(
                { _id: attempt._id },
                { $set: { persistenceStatus: "PERSISTING" } },
              );
            },
          },
          {
            name: "compensation started",
            expectFirstPending: true,
            prepare: async ({ attempt }) => {
              await PaymentAttemptModel.collection.updateOne(
                { _id: attempt._id },
                { $set: { compensationStatus: "REQUIRED" } },
              );
            },
          },
        ];
        for (const variant of variants) {
          const { client, attempt } = await startFirstUnsent(`guard-${variant.name}`, {
            pi: false,
          });
          await makeUnsentStale(attempt._id);
          await variant.prepare({ client, attempt });
          const revision = (await relationshipOf(client._id)).financialRelationship
            ?.revision as number;
          paymentGateway.customerListCalls = 0;

          await recoveryService.runOnce();

          expect(paymentGateway.customerListCalls, variant.name).toBe(0);
          const row = await relationshipOf(client._id);
          expect(row.financialRelationship?.state, variant.name).toBe(
            variant.expectFirstPending ? "FIRST_PENDING" : "CONSUMED",
          );
          expect(row.financialRelationship?.revision, variant.name).toBe(revision);
          expect((await attemptOf(attempt._id)).providerStatus, variant.name).toBe("UNKNOWN");
        }

        // Too young: not resolved even though no PaymentIntent exists.
        const young = await startFirstUnsent("guard-young", { pi: false });
        paymentGateway.customerListCalls = 0;
        await recoveryService.runOnce();
        expect(paymentGateway.customerListCalls).toBe(0);
        await expectUntouched(young.client, young.attempt._id, young.revision, "UNKNOWN");
      });

      it("duplicate concurrent workers: one terminalization, one release", async () => {
        const { client, attempt, revision } = await startFirstUnsent("dup-workers", {
          pi: false,
        });
        await makeUnsentStale(attempt._id);

        await Promise.all([recoveryService.runOnce(), recoveryService.runOnce()]);

        expect((await attemptOf(attempt._id)).lastErrorCode).toBe(PROVIDER_NOT_CREATED);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.revision).toBe(revision + 1);
      });

      it("race: a success webhook recorded during the lookup wins — never closed or released, even on a wrong NOT_FOUND", async () => {
        const { fixture, customer, client, input, attempt, revision } = await startFirstUnsent(
          "lookup-race",
          { pi: true, outcome: "succeeded" },
        );
        const paymentIntentId = await providerPaymentIntentIdOf(attempt);
        await makeUnsentStale(attempt._id);

        // Deliberately wrong lookup answer, with the webhook landing first: only the CAS on
        // "still no PaymentIntent recorded" stands between this and a wrong release.
        paymentGateway.findCustomerPaymentIntentByAttempt = async () => {
          await webhookService
            .process(
              piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
                metadata: piMetadata(attempt._id),
              }),
            )
            .catch(() => undefined);
          return { outcome: "NOT_FOUND" };
        };

        await recoveryService.runOnce();

        const recorded = await attemptOf(attempt._id);
        expect(recorded.providerStatus).toBe("SUCCEEDED");
        expect(recorded.providerPaymentIntentId).toBe(paymentIntentId);
        expect(recorded.lastErrorCode).not.toBe(PROVIDER_NOT_CREATED);
        await expectUntouched(client, attempt._id, revision, "SUCCEEDED");
        expect(paymentGateway.refundInputs).toHaveLength(0);

        const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
        expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
        expect(
          String((await relationshipOf(client._id)).financialRelationship?.consumed?.bookingId),
        ).toBe(String(booking._id));
      });

      it("generic recovery backs off NOT_FOUND without changing provider meaning (non-FIRST)", async () => {
        const old = new Date(Date.now() - STALE_FIRST_UNSENT_MS - 60_000);
        const { insertedId } = await PaymentAttemptModel.collection.insertOne({
          logicalIdempotencyKey: `returning-unsent-${new Types.ObjectId().toString()}`,
          customerUserId: new Types.ObjectId(),
          purpose: "BOOKING_DEPOSIT",
          productKind: "NORMAL_BOOKING",
          financialContractVersion: 2,
          relationshipClassification: "RETURNING",
          currency: "EUR",
          expectedAmountCents: 2_000,
          provider: "STRIPE",
          providerCustomerId: "cus_returning_unsent",
          providerStatus: "NOT_CREATED",
          persistenceStatus: "NOT_STARTED",
          compensationStatus: "NOT_REQUIRED",
          recoveryAttemptCount: 0,
          createdAt: old,
          updatedAt: old,
        } as never);
        const id = insertedId as unknown as Types.ObjectId;

        await recoveryService.runOnce();

        const refreshed = await attemptOf(id);
        expect(refreshed.providerStatus).toBe("NOT_CREATED");
        expect(refreshed.lastErrorCode).toBeUndefined();
        expect(refreshed.recoveryAttemptCount).toBe(1);
        expect(refreshed.nextRecoveryAt?.getTime()).toBeGreaterThan(Date.now());
        expect(paymentGateway.customerListCalls).toBe(0);
      });

      it("more than a full batch of NOT_FOUND rows cannot starve a SUCCEEDED orphan's compensation", async () => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, "starved-orphan");
        const original = paymentService.claimPaymentPersistence.bind(paymentService);
        paymentService.claimPaymentPersistence = async () => {
          paymentService.claimPaymentPersistence = original;
          throw new Error("simulated process crash");
        };
        const input = normalInput(fixture, "10:00");
        await expect(finalizeNormal(fixture, customer._id, input)).rejects.toThrow(
          "simulated process crash",
        );
        const orphan = await PaymentAttemptModel.findOne({
          logicalIdempotencyKey: input.idempotencyKey,
        })
          .orFail()
          .exec();
        await ageSuccess(orphan._id);

        const old = new Date(Date.now() - 24 * 60 * 60_000);
        await PaymentAttemptModel.collection.insertMany(
          Array.from({ length: 55 }, (_, index) => ({
            logicalIdempotencyKey: `stuck-${index}-${new Types.ObjectId().toString()}`,
            customerUserId: new Types.ObjectId(),
            purpose: "BOOKING_DEPOSIT",
            currency: "EUR",
            expectedAmountCents: 2_000,
            provider: "STRIPE",
            providerCustomerId: `cus_stuck_${index}`,
            providerStatus: index % 2 === 0 ? "NOT_CREATED" : "UNKNOWN",
            persistenceStatus: "NOT_STARTED",
            compensationStatus: "NOT_REQUIRED",
            recoveryAttemptCount: 0,
            createdAt: old,
            updatedAt: old,
          })) as never[],
        );

        // First pass: the batch is entirely the older NOT_FOUND rows (proving saturation)...
        await recoveryService.runOnce();
        expect((await attemptOf(orphan._id)).compensationStatus).toBe("NOT_REQUIRED");
        // ...which now rotate out, so the next pass reaches the orphan.
        await recoveryService.runOnce();

        expect((await attemptOf(orphan._id)).compensationStatus).toBe("REFUNDED");
        expect(paymentGateway.refundInputs).toHaveLength(1);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
      });
    });

    // --- P1.1.1 Gap 3: orphan grace runs from the recorded provider success -------------------

    describe("P1.1.1 — success-based orphan grace", () => {
      const slowThreeDsSuccess = async (tag: string) => {
        const started = await startFirstRequiresAction(tag);
        // The customer spent 6 minutes in 3DS: older than the 5-minute grace, younger than the
        // 30-minute stale pass.
        await PaymentAttemptModel.collection.updateOne(
          { _id: started.attempt._id },
          { $set: { createdAt: new Date(Date.now() - 6 * 60_000) } },
        );
        paymentGateway.succeedPaymentIntent(started.paymentIntentId);
        const before = Date.now();
        await expect(
          webhookService.process(
            piEvent("payment_intent.succeeded", started.attempt, started.paymentIntentId, {
              metadata: piMetadata(started.attempt._id),
            }),
          ),
        ).rejects.toThrow(/not persisted yet/);
        const succeeded = await attemptOf(started.attempt._id);
        expect(succeeded.providerStatus).toBe("SUCCEEDED");
        expect(succeeded.providerSucceededAt?.getTime()).toBeGreaterThanOrEqual(before);
        return { ...started, succeededAt: succeeded.providerSucceededAt as Date };
      };

      it("slow 3DS: success just recorded on a 6-minute-old attempt is not compensated; duplicates keep the timestamp; finalize persists", async () => {
        const { fixture, customer, client, input, attempt, paymentIntentId, succeededAt } =
          await slowThreeDsSuccess("slow-3ds");

        // Duplicate success webhook: the success clock is set once.
        await expect(
          webhookService.process(
            piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
              metadata: piMetadata(attempt._id),
            }),
          ),
        ).rejects.toThrow(/not persisted yet/);
        expect((await attemptOf(attempt._id)).providerSucceededAt?.getTime()).toBe(
          succeededAt.getTime(),
        );

        await recoveryService.runOnce();
        expect((await attemptOf(attempt._id)).compensationStatus).toBe("NOT_REQUIRED");
        expect(paymentGateway.refundInputs).toHaveLength(0);

        const booking = confirmed(await finalizeNormal(fixture, customer._id, input));
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("CONSUMED");
        expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(String(booking._id));
        expect(paymentGateway.refundInputs).toHaveLength(0);
        expect(await ledgerCount({ type: "PLATFORM_FEE" })).toBe(1);
        expect((await attemptOf(attempt._id)).providerSucceededAt?.getTime()).toBe(
          succeededAt.getTime(),
        );
      });

      it("no finalize ever arrives: compensated once the success outlives the grace, with exact refund/restoration", async () => {
        const { client, attempt } = await slowThreeDsSuccess("slow-3ds-orphan");
        await recoveryService.runOnce();
        expect((await attemptOf(attempt._id)).compensationStatus).toBe("NOT_REQUIRED");

        await ageSuccess(attempt._id, 6 * 60_000);
        await recoveryService.runOnce();

        expect((await attemptOf(attempt._id)).compensationStatus).toBe("REFUNDED");
        expect(paymentGateway.refundInputs.map((refund) => refund.amountCents)).toEqual([
          attempt.expectedAmountCents,
        ]);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("ELIGIBLE");
        expect(row.financialRelationship?.lastRelease?.reason).toBe("COMPENSATION_REFUNDED");
        expect(row.financialRelationship?.consumed).toBeUndefined();
      });

      it("recovery-discovered success establishes the same set-once success clock", async () => {
        const { attempt, paymentIntentId } = await startFirstRequiresAction("discovered");
        paymentGateway.succeedPaymentIntent(paymentIntentId);
        await makeStale(attempt._id);
        const before = Date.now();

        await recoveryService.runOnce();

        const discovered = await attemptOf(attempt._id);
        expect(discovered.providerStatus).toBe("SUCCEEDED");
        const succeededAt = discovered.providerSucceededAt?.getTime() as number;
        expect(succeededAt).toBeGreaterThanOrEqual(before);
        expect(discovered.compensationStatus).toBe("NOT_REQUIRED");

        await expect(
          webhookService.process(
            piEvent("payment_intent.succeeded", attempt, paymentIntentId, {
              metadata: piMetadata(attempt._id),
            }),
          ),
        ).rejects.toThrow(/not persisted yet/);
        await recoveryService.runOnce();
        expect((await attemptOf(attempt._id)).providerSucceededAt?.getTime()).toBe(succeededAt);
      });

      it("legacy SUCCEEDED row without a success timestamp falls back to attempt creation", async () => {
        const fixture = await setupFixture();
        const { customer } = await createLinkedCustomer(fixture, "legacy-orphan");
        const original = paymentService.claimPaymentPersistence.bind(paymentService);
        paymentService.claimPaymentPersistence = async () => {
          paymentService.claimPaymentPersistence = original;
          throw new Error("simulated process crash");
        };
        const input = normalInput(fixture, "10:00");
        await expect(finalizeNormal(fixture, customer._id, input)).rejects.toThrow(
          "simulated process crash",
        );
        const legacy = await PaymentAttemptModel.findOne({
          logicalIdempotencyKey: input.idempotencyKey,
        })
          .orFail()
          .exec();
        await PaymentAttemptModel.collection.updateOne(
          { _id: legacy._id },
          {
            $set: { createdAt: new Date(Date.now() - 10 * 60_000) },
            $unset: { providerSucceededAt: "" },
          },
        );

        await recoveryService.runOnce();

        expect((await attemptOf(legacy._id)).compensationStatus).toBe("REFUNDED");
      });
    });
  });

  // --- Non-consumers ------------------------------------------------------------------------------

  describe("non-consumers", () => {
    it("a MANUAL Owner booking never claims, consumes or changes the relationship", async () => {
      const fixture = await setupFixture();
      const { client } = await createLinkedCustomer(fixture, "manual");
      await relationshipRepository.ensureInitialized(client._id);
      const before = await relationshipOf(client._id);

      const manual = await creationService.createManualBooking(
        String(fixture.owner._id),
        "BUSINESS_OWNER",
        String(fixture.business._id),
        {
          serviceLines: [
            {
              serviceId: String(fixture.fixedService._id),
              staffMembershipId: String(fixture.staffId),
              addonIds: [],
              pricingInput: {},
            },
          ],
          startAt: startAtFor("10:00"),
          businessClientId: String(client._id),
          idempotencyKey: `manual-${new Types.ObjectId().toString()}`,
        },
      );

      expect(manual.financials).toMatchObject({ depositCents: 0, platformFeeCents: 0 });
      expect(manual.financialContract).toBeUndefined();
      expect(await ledgerFor(manual._id)).toHaveLength(0);
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship).toMatchObject({
        state: "ELIGIBLE",
        revision: before.financialRelationship?.revision,
      });
      expect(after.activatedAt).toBeUndefined();
    });

    it("package Session 2+ redemption never claims/consumes/resets the relationship and keeps its current extras charge", async () => {
      const fixture = await setupFixture();
      const extra = await createAddon(fixture, fixture.packageService._id, 2_000);
      const { customer, client } = await createLinkedCustomer(fixture, "session2");
      const purchase = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture)),
      );
      await lifecycleService.completeBooking(
        String(fixture.owner._id),
        "BUSINESS_OWNER",
        String(fixture.business._id),
        String(purchase._id),
        { settlement: "FULL" },
      );
      const progress = await PackageProgressModel.findOne({ originBookingId: purchase._id })
        .orFail()
        .exec();
      const before = await relationshipOf(client._id);

      const redemption = await creationService.redeemPackageSession(
        String(customer._id),
        String(fixture.business._id),
        String(progress._id),
        {
          staffMembershipId: String(fixture.staffId),
          startAt: startAtFor("10:00", DATE_2),
          addonIds: [String(extra._id)],
          idempotencyKey: `redeem-${new Types.ObjectId().toString()}`,
        },
      );
      const session2 = confirmed(redemption);

      // Unchanged P1 Session 2+ behaviour: the €20 add-on goes through the legacy deposit
      // (€5 floor) as a Business-owned DEPOSIT — never PLATFORM_FEE.
      expect(session2.financials).toMatchObject({ depositCents: 500, platformFeeCents: 0 });
      expect(session2.financialContract).toBeUndefined();
      const ledger = await ledgerFor(session2._id);
      expect(ledger.map((entry) => entry.type)).toEqual(["DEPOSIT"]);
      const attempt = await PaymentAttemptModel.findOne({ bookingId: session2._id })
        .orFail()
        .exec();
      expect(attempt.relationshipClassification).toBeUndefined();

      const after = await relationshipOf(client._id);
      expect(after.financialRelationship).toEqual(before.financialRelationship);
    });
  });

  // --- P3: RETURNING is €0 online for BOTH purchase kinds --------------------------------------

  describe("P3 — RETURNING is €0 online for normal bookings AND package purchases", () => {
    it("normal and package RETURNING charge nothing online (no PI, no attempt, no ledger), keep the full total as the venue balance, and never mutate the relationship", async () => {
      const fixture = await setupFixture({ bundlePriceCents: 10_000 });
      const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
      const { customer, client } = await createLinkedCustomer(fixture, "returning");
      confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
      const consumed = await relationshipOf(client._id);

      const piAfterFirst = paymentGateway.paymentIntentInputs.length;
      const attemptsAfterFirst = await PaymentAttemptModel.countDocuments().exec();

      const normal = confirmed(
        await finalizeNormal(fixture, customer._id, normalInput(fixture, "11:00")),
      );
      expect(normal.financials).toMatchObject({
        depositCents: 0,
        platformFeeCents: 0,
        totalCents: 10_000,
        balanceDueCents: 10_000,
      });
      expect(normal.financialContract).toMatchObject({
        version: 3,
        classification: "RETURNING",
        upfrontLedgerType: "DEPOSIT",
        requiredUpfrontCents: 0,
        onlineChargeCents: 0,
      });
      expect(await ledgerFor(normal._id)).toHaveLength(0);

      // Package RETURNING is €0 online too — the full bundle + add-ons total (€140) stays the
      // venue balance; the V2 package contract still records the bundle + add-ons basis.
      const pkg = confirmed(
        await finalizePackage(
          fixture,
          customer._id,
          packageInput(fixture, "14:00", { addonIds: [String(addon._id)] }),
        ),
      );
      expect(pkg.financials).toMatchObject({
        depositCents: 0,
        platformFeeCents: 0,
        totalCents: 14_000,
        balanceDueCents: 14_000,
      });
      expect(pkg.financialContract).toMatchObject({
        version: 2,
        classification: "RETURNING",
        eligibleBasisCents: 14_000,
        packageBundlePriceCents: 10_000,
        upfrontLedgerType: "DEPOSIT",
        requiredUpfrontCents: 0,
        onlineChargeCents: 0,
      });
      expect(await ledgerFor(pkg._id)).toHaveLength(0);
      expect(await PackageProgressModel.countDocuments({ originBookingId: pkg._id })).toBe(1);

      // No provider money and no durable attempt for either RETURNING purchase.
      expect(paymentGateway.paymentIntentInputs).toHaveLength(piAfterFirst);
      expect(await PaymentAttemptModel.countDocuments().exec()).toBe(attemptsAfterFirst);

      const after = await relationshipOf(client._id);
      expect(after.financialRelationship).toEqual(consumed.financialRelationship);
    });
  });

  // --- Legacy compatibility ------------------------------------------------------------------------

  describe("legacy activatedAt compatibility", () => {
    it("a legacy activated pair (no v2 state) stays RETURNING and initializes CONSUMED", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "legacy-activated");
      const legacyBookingId = new Types.ObjectId();
      await BusinessClientModel.collection.updateOne(
        { _id: client._id },
        { $set: { activatedAt: new Date("2025-01-01"), activatedByBookingId: legacyBookingId } },
      );

      const preview = await creationService.previewCustomerBooking(
        String(customer._id),
        String(fixture.business._id),
        normalInput(fixture),
      );
      expect(preview.isFirstBooking).toBe(false);

      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      expect(booking.financialContract?.classification).toBe("RETURNING");
      expect(booking.financials.platformFeeCents).toBe(0);
      const row = await relationshipOf(client._id);
      expect(row.financialRelationship).toMatchObject({
        state: "CONSUMED",
        initializedFrom: "LEGACY_ACTIVATED",
        revision: 0,
      });
      expect(String(row.activatedByBookingId)).toBe(String(legacyBookingId));
    });

    it("a legacy unactivated pair is FIRST", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "legacy-new");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      expect(booking.financialContract?.classification).toBe("FIRST");
      expect((await relationshipOf(client._id)).financialRelationship?.initializedFrom).toBe(
        "LEGACY_UNACTIVATED",
      );
    });

    it("v2 state is authoritative over activatedAt in preview AND finalize (no split-brain)", async () => {
      const fixture = await setupFixture();
      const eligible = await createLinkedCustomer(fixture, "v2-eligible");
      const consumed = await createLinkedCustomer(fixture, "v2-consumed");
      const v2 = (state: "ELIGIBLE" | "CONSUMED") => ({
        version: 2,
        state,
        revision: 3,
        initializedFrom: "LEGACY_UNACTIVATED",
        stateChangedAt: new Date(),
      });
      // e.g. a restored relationship keeps its historical activatedAt — v2 still says ELIGIBLE.
      await BusinessClientModel.collection.updateOne(
        { _id: eligible.client._id },
        { $set: { activatedAt: new Date("2025-01-01"), financialRelationship: v2("ELIGIBLE") } },
      );
      await BusinessClientModel.collection.updateOne(
        { _id: consumed.client._id },
        { $set: { financialRelationship: v2("CONSUMED") } },
      );

      const previewEligible = await creationService.previewCustomerBooking(
        String(eligible.customer._id),
        String(fixture.business._id),
        normalInput(fixture, "10:00"),
      );
      const previewConsumed = await creationService.previewCustomerBooking(
        String(consumed.customer._id),
        String(fixture.business._id),
        normalInput(fixture, "14:00"),
      );
      expect(previewEligible.isFirstBooking).toBe(true);
      expect(previewConsumed.isFirstBooking).toBe(false);

      const first = confirmed(
        await finalizeNormal(fixture, eligible.customer._id, normalInput(fixture, "10:00")),
      );
      const returning = confirmed(
        await finalizeNormal(fixture, consumed.customer._id, normalInput(fixture, "14:00")),
      );
      expect(first.financialContract?.classification).toBe("FIRST");
      expect(returning.financialContract?.classification).toBe("RETURNING");
    });

    it("mixed old/new bookings: a legacy booking (no contract) is left untouched and the next booking is RETURNING", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "mixed");
      const legacy = confirmed(
        await finalizeNormal(fixture, customer._id, normalInput(fixture, "10:00")),
      );
      // Rewind to a pre-P1 shape: no contract on the booking, no v2 relationship, activatedAt set.
      await BookingModel.collection.updateOne(
        { _id: legacy._id },
        { $unset: { financialContract: "" } },
      );
      await BusinessClientModel.collection.updateOne(
        { _id: client._id },
        { $unset: { financialRelationship: "" } },
      );
      const legacyBefore = await BookingModel.findById(legacy._id).lean().exec();

      const next = confirmed(
        await finalizeNormal(fixture, customer._id, normalInput(fixture, "14:00")),
      );
      expect(next.financialContract?.classification).toBe("RETURNING");
      const legacyAfter = await BookingModel.findById(legacy._id).lean().exec();
      expect(legacyAfter).toEqual(legacyBefore);
    });
  });

  // --- Phase-boundary regressions (P4 not implemented) ------------------------------------------

  describe("phase boundaries", () => {
    it("P4 business cancellation restores a consumed FIRST only after succeeded refund accounting", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "biz-cancel");
      const booking = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
      const before = await relationshipOf(client._id);

      const cancelled = await lifecycleService.cancelByBusiness(
        String(fixture.owner._id),
        "BUSINESS_OWNER",
        String(fixture.business._id),
        String(booking._id),
        "Staff emergency",
      );
      expect(cancelled.status).toBe("CANCELLED_BY_BUSINESS");
      expect(await RefundOperationModel.countDocuments({ reason: "BUSINESS_CANCELLATION" })).toBe(
        1,
      );

      await recoveryService.runOnce();
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.consumed).toEqual(before.financialRelationship?.consumed);
      expect(after.financialRelationship?.state).toBe("ELIGIBLE");
    });

    it("customer whole-package void of a FIRST package refunds but the relationship stays CONSUMED", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "void");
      const purchase = confirmed(
        await finalizePackage(fixture, customer._id, packageInput(fixture)),
      );
      const progress = await PackageProgressModel.findOne({ originBookingId: purchase._id })
        .orFail()
        .exec();

      const voided = await lifecycleService.voidUnusedPackage(
        String(customer._id),
        String(fixture.business._id),
        String(progress._id),
        "Changed my mind",
      );
      expect(voided.voidedAt).toBeTruthy();

      await recoveryService.runOnce();
      const after = await relationshipOf(client._id);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
      expect(String(after.financialRelationship?.consumed?.bookingId)).toBe(String(purchase._id));
    });
  });
  // --- P3: shared RETURNING €0 across product kinds ---------------------------------------------

  describe("P3 — shared customer↔business relationship; RETURNING €0 online for both product kinds", () => {
    const noMoneyFor = async (bookingId: Types.ObjectId) => {
      expect(await ledgerFor(bookingId)).toHaveLength(0);
      expect(await PaymentAttemptModel.countDocuments({ bookingId }).exec()).toBe(0);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (input) => input.metadata["bookingId"] === String(bookingId),
        ),
      ).toHaveLength(0);
    };

    const redeemInput = (fixture: Fixture, time: string, addonIds: string[] = []) => ({
      staffMembershipId: String(fixture.staffId),
      startAt: startAtFor(time, DATE_2),
      addonIds,
      idempotencyKey: `redeem-${new Types.ObjectId().toString()}`,
    });

    const redeem = (
      fixture: Fixture,
      customerId: Types.ObjectId,
      progressId: Types.ObjectId,
      input: ReturnType<typeof redeemInput>,
    ) =>
      creationService.redeemPackageSession(
        String(customerId),
        String(fixture.business._id),
        String(progressId),
        input,
      );

    describe("FIRST is shared: whichever purchase kind consumes it first", () => {
      it("NORMAL FIRST consumes the shared relationship; a later PACKAGE purchase is RETURNING and €0 online", async () => {
        const fixture = await setupFixture({ bundlePriceCents: 30_000 });
        const { customer, client } = await createLinkedCustomer(fixture, "normal-then-package");

        const first = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
        expect(first.financialContract).toMatchObject({
          classification: "FIRST",
          eligibleBasisCents: 10_000,
          requiredUpfrontCents: 2_000,
        });
        const consumed = await relationshipOf(client._id);
        expect(consumed.financialRelationship).toMatchObject({ state: "CONSUMED" });
        expect(consumed.financialRelationship?.consumed?.productKind).toBe("NORMAL_BOOKING");

        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        expect(pkg.financialContract).toMatchObject({
          version: 2,
          productKind: "PACKAGE_PURCHASE",
          classification: "RETURNING",
          requiredUpfrontCents: 0,
          onlineChargeCents: 0,
        });
        expect(pkg.financials).toMatchObject({
          depositCents: 0,
          platformFeeCents: 0,
          totalCents: 30_000,
          balanceDueCents: 30_000,
        });
        await noMoneyFor(pkg._id);
        // The relationship was only read, never written, by the RETURNING purchase.
        expect((await relationshipOf(client._id)).financialRelationship).toEqual(
          consumed.financialRelationship,
        );
      });

      it("PACKAGE FIRST (bundle basis, unchanged) consumes the SAME relationship; a later NORMAL booking is RETURNING and €0 online", async () => {
        const fixture = await setupFixture({ bundlePriceCents: 10_000 });
        const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
        const { customer, client } = await createLinkedCustomer(fixture, "package-then-normal");

        const pkg = confirmed(
          await finalizePackage(
            fixture,
            customer._id,
            packageInput(fixture, "14:00", { addonIds: [String(addon._id)] }),
          ),
        );
        // FIRST basis is the bundle price ONLY (never + add-ons): 20% of €100 = €20.
        expect(pkg.financialContract).toMatchObject({
          version: 2,
          classification: "FIRST",
          eligibleBasisCents: 10_000,
          packageBundlePriceCents: 10_000,
          requiredUpfrontCents: 2_000,
          onlineChargeCents: 2_000,
          upfrontLedgerType: "PLATFORM_FEE",
        });
        expect(pkg.financials).toMatchObject({
          totalCents: 14_000,
          depositCents: 2_000,
          platformFeeCents: 2_000,
          balanceDueCents: 12_000,
        });
        expect((await ledgerFor(pkg._id)).map((e) => [e.type, e.amountCents])).toEqual([
          ["PLATFORM_FEE", 2_000],
        ]);
        expect(
          await PaymentAttemptModel.countDocuments({
            bookingId: pkg._id,
            relationshipClassification: "FIRST",
          }),
        ).toBe(1);
        const consumed = await relationshipOf(client._id);
        expect(consumed.financialRelationship?.state).toBe("CONSUMED");
        expect(consumed.financialRelationship?.consumed?.productKind).toBe("PACKAGE_PURCHASE");

        const normal = confirmed(
          await finalizeNormal(fixture, customer._id, normalInput(fixture, "10:00")),
        );
        expect(normal.financialContract).toMatchObject({
          version: 3,
          classification: "RETURNING",
          requiredUpfrontCents: 0,
          onlineChargeCents: 0,
        });
        expect(normal.financials).toMatchObject({ depositCents: 0, balanceDueCents: 10_000 });
        await noMoneyFor(normal._id);
        expect((await relationshipOf(client._id)).financialRelationship).toEqual(
          consumed.financialRelationship,
        );
      });

      it("concurrent NORMAL vs PACKAGE FIRST: exactly one claims FIRST; the loser is rejected before any contract/attempt/charge; its retry is RETURNING €0", async () => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, "cross-race");
        const normal = normalInput(fixture, "10:00");
        const pkg = packageInput(fixture, "14:00");

        const { results, firstSettledIndex, whileHeld, attemptsWhileHeld } =
          await raceWithHeldWinner(client._id, [
            () => finalizeNormal(fixture, customer._id, normal),
            () => finalizePackage(fixture, customer._id, pkg),
          ]);
        const loserIndex = firstSettledIndex;
        const winnerIndex = loserIndex === 0 ? 1 : 0;
        const loser = results[loserIndex] as PromiseRejectedResult;
        expect(loser.status).toBe("rejected");
        expectFirstInProgress(loser.reason);
        expect(whileHeld.financialRelationship?.state).toBe("FIRST_PENDING");
        expect(attemptsWhileHeld).toBe(1); // only the winner's
        const winner = results[winnerIndex] as PromiseFulfilledResult<FinalizeBookingResult>;
        const winnerBooking = confirmed(winner.value);
        expect(winnerBooking.financialContract?.classification).toBe("FIRST");

        const loserKey = loserIndex === 0 ? normal.idempotencyKey : pkg.idempotencyKey;
        expect(await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: loserKey })).toBe(
          0,
        );
        expect(await BookingCreationClaimModel.countDocuments({ idempotencyKey: loserKey })).toBe(
          0,
        );
        expect(paymentGateway.paymentIntentInputs).toHaveLength(1);

        // The loser's retry (same logical action, released claim) is now RETURNING and €0.
        const retry = confirmed(
          loserIndex === 0
            ? await finalizeNormal(fixture, customer._id, normal)
            : await finalizePackage(fixture, customer._id, pkg),
        );
        expect(retry.financialContract).toMatchObject({
          classification: "RETURNING",
          onlineChargeCents: 0,
        });
        await noMoneyFor(retry._id);
        const row = await relationshipOf(client._id);
        expect(row.financialRelationship?.state).toBe("CONSUMED");
        expect(String(row.financialRelationship?.consumed?.bookingId)).toBe(
          String(winnerBooking._id),
        );
      });

      it("a declined PACKAGE FIRST never consumes the relationship; the next NORMAL booking is FIRST", async () => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, "declined-package");
        paymentGateway.queueNextChargeOutcome("failed");
        await expect(
          finalizePackage(fixture, customer._id, packageInput(fixture)),
        ).rejects.toMatchObject({ statusCode: 402 });
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");
        expect(await BookingModel.countDocuments()).toBe(0);

        const normal = confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture)));
        expect(normal.financialContract?.classification).toBe("FIRST");
        expect(normal.financials.platformFeeCents).toBe(2_000);
        expect(
          (await relationshipOf(client._id)).financialRelationship?.consumed?.productKind,
        ).toBe("NORMAL_BOOKING");
      });

      it("package FIRST under €5 is capped at the bundle basis (€3 PLATFORM_FEE, real attempt)", async () => {
        const fixture = await setupFixture({ bundlePriceCents: 300 });
        const { customer } = await createLinkedCustomer(fixture, "package-first-tiny");
        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        expect(pkg.financials).toMatchObject({ depositCents: 300, platformFeeCents: 300 });
        expect(paymentGateway.paymentIntentInputs.at(-1)?.amountCents).toBe(300);
        expect((await ledgerFor(pkg._id))[0]).toMatchObject({
          type: "PLATFORM_FEE",
          amountCents: 300,
        });
      });
    });

    describe("PACKAGE RETURNING purchase", () => {
      const setupReturning = async (options: Parameters<typeof setupFixture>[0] = {}) => {
        const fixture = await setupFixture(options);
        const linked = await createLinkedCustomer(fixture, "package-returning");
        confirmed(
          await finalizeNormal(
            fixture,
            linked.customer._id,
            normalInput(fixture, "09:00", { travel: Boolean(options.travel) }),
          ),
        );
        return { fixture, ...linked };
      };

      it("preview and finalize: €0 online, full bundle + add-ons + travel as the origin balance, PackageProgress created once, settlement outstanding = full total, platform entitlement 0", async () => {
        const { fixture, customer } = await setupReturning({
          bundlePriceCents: 30_000,
          travel: { feeCents: 2_500 },
        });
        const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
        const input = packageInput(fixture, "14:00", {
          addonIds: [String(addon._id)],
          travel: true,
        });
        const taxBefore = taxGateway.calls.length;

        const quote = await creationService.previewPackagePurchase(
          String(customer._id),
          String(fixture.business._id),
          input,
        );
        expect(quote).toMatchObject({
          isFirstBooking: false,
          preTaxChargeCents: 0,
          taxCents: 0,
          dueNowCents: 0,
          balanceDueCents: 36_500,
          requiresSavedCard: true,
        });

        const result = await finalizePackage(fixture, customer._id, input);
        expect(result.status).toBe("confirmed"); // never requires_action — nothing to authenticate
        const pkg = confirmed(result);
        expect(taxGateway.calls).toHaveLength(taxBefore);
        expect(pkg.financials).toMatchObject({
          servicesSubtotalCents: 30_000,
          addonsSubtotalCents: 4_000,
          travelFeeCents: 2_500,
          totalCents: 36_500,
          depositCents: 0,
          platformFeeCents: 0,
          balanceDueCents: 36_500,
        });
        expect(pkg.financialContract).toMatchObject({
          version: 2,
          classification: "RETURNING",
          packageBundlePriceCents: 30_000,
          requiredUpfrontCents: 0,
          onlineChargeCents: 0,
          bookingTotalCents: 36_500,
        });
        await noMoneyFor(pkg._id);
        const progresses = await PackageProgressModel.find({ originBookingId: pkg._id }).exec();
        expect(progresses).toHaveLength(1);
        expect(progresses[0]).toMatchObject({ totalSessions: 3, remainingSessions: 2 });
        expect(computePackageBalanceSettlement(pkg)).toEqual({
          balanceSettled: false,
          outstandingBalanceCents: 36_500,
        });
      });

      it("a bundle under €5 succeeds at €0 online (no legacy €5 floor)", async () => {
        const { fixture, customer } = await setupReturning({ bundlePriceCents: 300 });
        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        expect(pkg.financials).toMatchObject({
          depositCents: 0,
          totalCents: 300,
          balanceDueCents: 300,
        });
        await noMoneyFor(pkg._id);
      });

      it("a saved card is still required (PAYMENT_METHOD_REQUIRED) even though nothing is charged", async () => {
        const { fixture, customer } = await setupReturning();
        await CustomerPaymentProfileModel.updateOne(
          { userId: customer._id },
          { $unset: { defaultPaymentMethodId: "" } },
        ).exec();
        const input = packageInput(fixture);
        await expect(finalizePackage(fixture, customer._id, input)).rejects.toMatchObject({
          statusCode: 402,
          details: [expect.objectContaining({ code: "PAYMENT_METHOD_REQUIRED" })],
        });
        expect(await PackageProgressModel.countDocuments()).toBe(0);
        expect(
          await BookingCreationClaimModel.countDocuments({ idempotencyKey: input.idempotencyKey }),
        ).toBe(0);
      });

      it("same-key retry is idempotent: one booking, one PackageProgress, no money", async () => {
        const { fixture, customer } = await setupReturning();
        const input = packageInput(fixture);
        const first = confirmed(await finalizePackage(fixture, customer._id, input));
        const again = confirmed(await finalizePackage(fixture, customer._id, input));
        expect(String(again._id)).toBe(String(first._id));
        expect(await PackageProgressModel.countDocuments()).toBe(1);
        await noMoneyFor(first._id);
      });

      it("voiding an unused €0 RETURNING package refunds nothing and records no refund settlement", async () => {
        const { fixture, customer } = await setupReturning();
        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        const progress = await PackageProgressModel.findOne({ originBookingId: pkg._id })
          .orFail()
          .exec();
        const voided = await lifecycleService.voidUnusedPackage(
          String(customer._id),
          String(fixture.business._id),
          String(progress._id),
          "changed my mind",
        );
        expect(voided.voidedAt).toBeDefined();
        expect(voided.voidRefundSettlement).toBeUndefined();
        expect(paymentGateway.refundInputs).toHaveLength(0);
        expect(await RefundOperationModel.countDocuments()).toBe(0);
      });
    });

    describe("PACKAGE Session 2+ stays outside the relationship and its economics are unchanged", () => {
      it("a RETURNING package unlocks Session 2 only once the FULL origin total is recorded paid; Sessions 2 and 3 are €0 base, never touch the relationship, and add-ons keep the legacy redemption deposit", async () => {
        const fixture = await setupFixture({ bundlePriceCents: 10_000 });
        const { customer, client } = await createLinkedCustomer(fixture, "session-2");
        confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        const progress = await PackageProgressModel.findOne({ originBookingId: pkg._id })
          .orFail()
          .exec();
        const relationshipBefore = (await relationshipOf(client._id)).financialRelationship;

        // Locked: the €0-online purchase leaves the whole €100 outstanding.
        await expect(
          redeem(fixture, customer._id, progress._id, redeemInput(fixture, "10:00")),
        ).rejects.toMatchObject({ statusCode: 409 });
        // A partial venue payment still does not unlock it.
        await lifecycleService.completeBooking(
          String(fixture.owner._id),
          "BUSINESS_OWNER",
          String(fixture.business._id),
          String(pkg._id),
          { settlement: "PARTIAL", amountCents: 9_000 },
        );
        await expect(
          redeem(fixture, customer._id, progress._id, redeemInput(fixture, "10:00")),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (await PackageProgressModel.findById(progress._id).orFail().exec()).remainingSessions,
        ).toBe(2);
        expect((await relationshipOf(client._id)).financialRelationship).toEqual(
          relationshipBefore,
        );
      });

      it("after the full origin total is settled: Session 2 and Session 3 are €0 base with no money and no relationship write; a Session add-on still pays the unchanged legacy redemption deposit", async () => {
        const fixture = await setupFixture({ bundlePriceCents: 10_000 });
        const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
        const { customer, client } = await createLinkedCustomer(fixture, "session-settled");
        confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
        const pkg = confirmed(await finalizePackage(fixture, customer._id, packageInput(fixture)));
        const progress = await PackageProgressModel.findOne({ originBookingId: pkg._id })
          .orFail()
          .exec();
        await lifecycleService.completeBooking(
          String(fixture.owner._id),
          "BUSINESS_OWNER",
          String(fixture.business._id),
          String(pkg._id),
          { settlement: "FULL" },
        );
        const relationshipBefore = (await relationshipOf(client._id)).financialRelationship;

        const session2 = confirmed(
          await redeem(fixture, customer._id, progress._id, redeemInput(fixture, "10:00")),
        );
        expect(session2.financials).toMatchObject({ totalCents: 0, depositCents: 0 });
        expect(session2.serviceLines[0]?.pricingInput.sessionIndex).toBe(2);
        expect(session2.financialContract).toBeUndefined();
        await noMoneyFor(session2._id);

        // Session 3 with an add-on: the redemption keeps its own unchanged legacy deposit path
        // (never the P3 €0 rule — it is not a relationship-classified purchase).
        const session3 = confirmed(
          await redeem(
            fixture,
            customer._id,
            progress._id,
            redeemInput(fixture, "12:00", [String(addon._id)]),
          ),
        );
        expect(session3.serviceLines[0]?.pricingInput.sessionIndex).toBe(3);
        expect(session3.financials).toMatchObject({
          addonsSubtotalCents: 4_000,
          totalCents: 4_000,
          depositCents: legacyReturningDepositCents(4_000),
          platformFeeCents: 0,
        });
        expect((await ledgerFor(session3._id)).map((e) => [e.type, e.amountCents])).toEqual([
          ["DEPOSIT", legacyReturningDepositCents(4_000)],
        ]);

        const after = await PackageProgressModel.findById(progress._id).orFail().exec();
        expect(after.remainingSessions).toBe(0);
        expect((await relationshipOf(client._id)).financialRelationship).toEqual(
          relationshipBefore,
        );
      });
    });

    describe("pre-P3 in-flight RETURNING operations fail closed (never silently repriced)", () => {
      /** Recreates, through the real repositories/services, the durable state a pre-P3 RETURNING
       * operation left behind: its claim with the frozen deposit-bearing contract, and its real
       * requires_action PaymentAttempt — exactly what a resume after P3 finds. */
      const seedInFlightReturning = async (
        fixture: Fixture,
        customerId: Types.ObjectId,
        clientId: Types.ObjectId,
        kind: "normal" | "package",
      ) => {
        const input = kind === "normal" ? normalInput(fixture, "11:00") : packageInput(fixture);
        const bookingId = new Types.ObjectId();
        await claimRepository.claim({
          idempotencyKey: input.idempotencyKey,
          businessId: fixture.business._id,
          actorUserId: customerId,
          bookingId,
        });
        const depositCents = 2_000; // legacy clamp(20%) of the €100 basis
        const contract = {
          version: kind === "normal" ? 3 : 2,
          productKind: kind === "normal" ? "NORMAL_BOOKING" : "PACKAGE_PURCHASE",
          classification: "RETURNING",
          idempotencyKey: input.idempotencyKey,
          bookingId,
          customerUserId: customerId,
          businessId: fixture.business._id,
          businessClientId: clientId,
          currency: "EUR",
          eligibleBasisCents: 10_000,
          ...(kind === "normal" ? { promoEligibleBaseCents: 10_000 } : {}),
          requiredUpfrontCents: depositCents,
          promoDiscountCents: 0,
          onlineChargeCents: depositCents,
          travelFeeCents: 0,
          ...(kind === "package" ? { packageBundlePriceCents: 10_000 } : {}),
          bookingTotalCents: 10_000,
          upfrontLedgerType: "DEPOSIT",
        } as const;
        await claimRepository.recordFinancialContract(input.idempotencyKey, contract as never);
        paymentGateway.queueNextChargeOutcome("requires_action");
        const charge = await paymentService.chargeBookingDeposit({
          userId: customerId,
          amountCents: depositCents,
          idempotencyKey: input.idempotencyKey,
          metadata: buildPaymentIntentMetadata({
            bookingId: String(bookingId),
            businessId: String(fixture.business._id),
            businessClientId: String(clientId),
            purpose: kind === "normal" ? "BOOKING_DEPOSIT" : "PACKAGE_PURCHASE",
            preTaxChargeCents: depositCents,
            taxCents: 0,
            chargedAmountCents: depositCents,
            taxMode: "PRE_ACTIVATION",
            financialContract: {
              version: contract.version,
              classification: "RETURNING",
              productKind: contract.productKind,
            },
          }),
          financialContract: {
            version: contract.version,
            classification: "RETURNING",
            productKind: contract.productKind,
            businessClientId: clientId,
          },
        });
        if (charge.status !== "requires_action") throw new Error("expected requires_action");
        return { input, charge, depositCents };
      };

      it.each(["normal", "package"] as const)(
        "%s: the resume conflicts, the frozen contract is untouched, and no second PaymentIntent is created",
        async (kind) => {
          const fixture = await setupFixture();
          const { customer, client } = await createLinkedCustomer(fixture, `inflight-${kind}`);
          confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
          const { input } = await seedInFlightReturning(fixture, customer._id, client._id, kind);
          const before = await BookingCreationClaimModel.findOne({
            idempotencyKey: input.idempotencyKey,
          })
            .orFail()
            .lean()
            .exec();
          const piCount = paymentGateway.paymentIntentInputs.length;

          await expect(
            kind === "normal"
              ? finalizeNormal(fixture, customer._id, input as ReturnType<typeof normalInput>)
              : finalizePackage(fixture, customer._id, input as ReturnType<typeof packageInput>),
          ).rejects.toMatchObject({
            statusCode: 409,
            details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }],
          });

          const after = await BookingCreationClaimModel.findOne({
            idempotencyKey: input.idempotencyKey,
          })
            .orFail()
            .lean()
            .exec();
          expect(after.financialContract).toEqual(before.financialContract);
          expect(after.financialContract?.requiredUpfrontCents).toBe(2_000);
          expect(paymentGateway.paymentIntentInputs).toHaveLength(piCount);
          expect(await BookingModel.countDocuments({ _id: before.bookingId })).toBe(0);
        },
      );

      it.each(["normal", "package"] as const)(
        "%s: money captured by the old 3DS is compensated exactly once by P0 once its success is observed",
        async (kind) => {
          const fixture = await setupFixture();
          const { customer, client } = await createLinkedCustomer(fixture, `inflight-paid-${kind}`);
          confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
          const { input, charge, depositCents } = await seedInFlightReturning(
            fixture,
            customer._id,
            client._id,
            kind,
          );
          const relationshipBefore = (await relationshipOf(client._id)).financialRelationship;
          paymentGateway.succeedPaymentIntent(charge.paymentIntentId); // the customer finished 3DS

          await expect(
            kind === "normal"
              ? finalizeNormal(fixture, customer._id, input as ReturnType<typeof normalInput>)
              : finalizePackage(fixture, customer._id, input as ReturnType<typeof packageInput>),
          ).rejects.toMatchObject({ details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }] });

          const attempt = await PaymentAttemptModel.findOne({
            logicalIdempotencyKey: input.idempotencyKey,
          })
            .orFail()
            .exec();
          // P0: the success webhook records the provider success on the attempt first, then asks
          // to be retried (no ledger row exists for an operation that could never persist).
          const succeeded = webhookService.process({
            id: `evt_${new Types.ObjectId().toString()}`,
            type: "payment_intent.succeeded",
            data: {
              object: {
                id: charge.paymentIntentId,
                amount: depositCents,
                currency: "eur",
                customer: attempt.providerCustomerId,
                metadata: paymentGateway.paymentIntentInputs.at(-1)?.metadata ?? {},
              },
            },
          } as unknown as Stripe.Event);
          await expect(succeeded).rejects.toThrow("source ledger row is not persisted yet");
          expect(
            (await PaymentAttemptModel.findById(attempt._id).orFail().exec()).providerStatus,
          ).toBe("SUCCEEDED");
          await ageSuccess(attempt._id);
          await recoveryService.runOnce();
          await recoveryService.runOnce(); // a duplicate pass never refunds twice

          const refreshed = await PaymentAttemptModel.findById(attempt._id).orFail().exec();
          expect(refreshed.compensationStatus).toBe("REFUNDED");
          expect(
            await RefundOperationModel.countDocuments({ sourcePaymentAttemptId: attempt._id }),
          ).toBe(1);
          expect(paymentGateway.refundInputs).toHaveLength(1);
          expect(paymentGateway.refundInputs[0]?.amountCents).toBe(depositCents);
          expect(
            await BookingModel.countDocuments({ _id: attempt.bookingId as Types.ObjectId }),
          ).toBe(0);
          expect(await PackageProgressModel.countDocuments()).toBe(0);
          // RETURNING never touches the relationship, even through compensation.
          expect((await relationshipOf(client._id)).financialRelationship).toEqual(
            relationshipBefore,
          );
        },
      );
    });
  });
  describe("P4 business cancellation and package commands", () => {
    const purchaseForP4 = async (kind: "normal" | "package", price = 10000) => {
      const fixture = await setupFixture({ bundlePriceCents: price });
      const { customer, client } = await createLinkedCustomer(
        fixture,
        `p4-${new Types.ObjectId()}`,
      );
      const booking = confirmed(
        kind === "normal"
          ? await finalizeNormal(fixture, customer._id, normalInput(fixture))
          : await finalizePackage(fixture, customer._id, packageInput(fixture)),
      );
      const progress =
        kind === "package"
          ? await PackageProgressModel.findOne({ originBookingId: booking._id }).orFail()
          : null;
      return { fixture, customer, client, booking, progress };
    };
    const cancelP4 = async (
      row: Awaited<ReturnType<typeof purchaseForP4>>,
      role: "CUSTOMER" | "BUSINESS_OWNER" = "BUSINESS_OWNER",
    ) =>
      row.progress
        ? lifecycleService.packageAction(
            String(role === "CUSTOMER" ? row.customer._id : row.fixture.owner._id),
            role,
            String(row.fixture.business._id),
            String(row.progress._id),
            "TERMINATE",
          )
        : lifecycleService.cancelByBusiness(
            String(row.fixture.owner._id),
            "BUSINESS_OWNER",
            String(row.fixture.business._id),
            String(row.booking._id),
            "P4",
          );
    const redeemP4 = async (
      row: Awaited<ReturnType<typeof purchaseForP4>>,
      time: string,
      addonIds: string[] = [],
    ) =>
      confirmed(
        await creationService.redeemPackageSession(
          String(row.customer._id),
          String(row.fixture.business._id),
          String(row.progress!._id),
          {
            staffMembershipId: String(row.fixture.staffId),
            startAt: startAtFor(time, DATE_2),
            addonIds,
            idempotencyKey: `p4-${new Types.ObjectId()}`,
          },
        ),
      );

    it.each(["normal", "package"] as const)(
      "%s: refund pending protects FIRST; exact success restores once and another product can be FIRST",
      async (kind) => {
        const row = await purchaseForP4(kind);
        paymentGateway.queueNextRefundOutcome("pending");
        await cancelP4(row);
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "RESTORATION_PENDING",
        );
        await expect(
          finalizeNormal(row.fixture, row.customer._id, normalInput(row.fixture, "12:00")),
        ).rejects.toMatchObject({ statusCode: 409 });
        await cancelP4(row);
        expect(paymentGateway.refundInputs).toHaveLength(1);
        const operation = await RefundOperationModel.findOne({
          bookingId: row.booking._id,
        }).orFail();
        expect(operation.expectedRefundAmountCents).toBe(
          row.booking.financialContract!.onlineChargeCents,
        );
        paymentGateway.succeedRefund(operation.providerRefundId!);
        await recoveryService.runOnce();
        await recoveryService.runOnce();
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "ELIGIBLE",
        );
        const refunds = (await ledgerFor(row.booking._id)).filter(
          (entry) => entry.type === "REFUND",
        );
        expect(refunds).toHaveLength(1);
        expect(refunds[0]?.status).toBe("SUCCEEDED");
        const next = confirmed(
          kind === "normal"
            ? await finalizePackage(row.fixture, row.customer._id, packageInput(row.fixture))
            : await finalizeNormal(row.fixture, row.customer._id, normalInput(row.fixture)),
        );
        expect(next.financialContract?.classification).toBe("FIRST");
        await relationshipService.reconcile(row.client._id);
        expect(
          (await relationshipOf(row.client._id)).financialRelationship?.consumed?.bookingId,
        ).toEqual(next._id);
      },
    );
    it.each(["normal", "package"] as const)(
      "%s: refund failure never unlocks FIRST",
      async (kind) => {
        const row = await purchaseForP4(kind);
        paymentGateway.queueNextRefundOutcome("failed");
        await cancelP4(row);
        await recoveryService.runOnce();
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "RESTORATION_PENDING",
        );
      },
    );
    it.each(["normal", "package"] as const)(
      "%s: crash before dispatch leaves a recoverable committed intent",
      async (kind) => {
        const row = await purchaseForP4(kind);
        const spy = vi
          .spyOn(paymentService, "refund")
          .mockRejectedValueOnce(new Error("process stopped before provider"));
        await cancelP4(row);
        spy.mockRestore();
        const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
        expect(op.providerStatus).toBe("CREATED");
        expect(op.providerCallStartedAt).toBeUndefined();
        expect(paymentGateway.refundInputs).toHaveLength(0);
        await recoveryService.runOnce();
        expect(paymentGateway.refundInputs).toHaveLength(1);
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "ELIGIBLE",
        );
      },
    );
    it("failed refund accounting is not restoration proof, and confirmed recovery repairs one row", async () => {
      const row = await purchaseForP4("normal");
      paymentGateway.queueNextRefundOutcome("pending");
      await cancelP4(row);
      const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
      const ledger = await BookingFinancialTransactionModel.findOne({
        type: "REFUND",
        bookingId: row.booking._id,
      }).orFail();
      await BookingFinancialTransactionModel.updateOne(
        { _id: ledger._id },
        { $set: { status: "FAILED" } },
      );
      await RefundOperationModel.updateOne(
        { _id: op._id },
        { $set: { providerStatus: "SUCCEEDED", succeededLedgerTransactionId: ledger._id } },
      );
      await relationshipService.reconcile(row.client._id);
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
        "RESTORATION_PENDING",
      );
      paymentGateway.succeedRefund(op.providerRefundId!);
      await recoveryService.runOnce();
      expect((await BookingFinancialTransactionModel.findById(ledger._id))?.status).toBe(
        "SUCCEEDED",
      );
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("ELIGIBLE");
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          type: "REFUND",
          bookingId: row.booking._id,
        }),
      ).toBe(1);
    });
    it.each(["amount", "currency", "source", "client"])(
      "mismatched %s cannot restore",
      async (mismatch) => {
        const row = await purchaseForP4("normal");
        paymentGateway.queueNextRefundOutcome("pending");
        await cancelP4(row);
        const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
        const fields =
          mismatch === "amount"
            ? { expectedRefundAmountCents: op.expectedRefundAmountCents - 1 }
            : mismatch === "currency"
              ? { currency: "USD" }
              : mismatch === "source"
                ? { sourceFinancialTransactionId: new Types.ObjectId() }
                : { businessClientId: new Types.ObjectId() };
        await RefundOperationModel.updateOne(
          { _id: op._id },
          { $set: { ...fields, providerStatus: "SUCCEEDED" } },
        );
        await relationshipService.reconcile(row.client._id);
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "RESTORATION_PENDING",
        );
      },
    );
    it.each([
      "businessId",
      "businessClientId",
      "customerUserId",
      "providerReference",
      "sourceType",
    ] as const)(
      "mismatched refund ledger %s cannot restore or be silently repaired",
      async (field) => {
        const row = await purchaseForP4("normal");
        paymentGateway.queueNextRefundOutcome("pending");
        await cancelP4(row);
        const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
        const ledger = await BookingFinancialTransactionModel.findOne({
          type: "REFUND",
          bookingId: row.booking._id,
        }).orFail();
        const mismatch =
          field === "providerReference"
            ? "re_other"
            : field === "sourceType"
              ? "DEPOSIT"
              : new Types.ObjectId();
        const path = field === "sourceType" ? "metadata.sourceType" : field;
        await BookingFinancialTransactionModel.updateOne(
          { _id: ledger._id },
          { $set: { status: "SUCCEEDED", [path]: mismatch } },
        );
        await RefundOperationModel.updateOne(
          { _id: op._id },
          { $set: { providerStatus: "SUCCEEDED", succeededLedgerTransactionId: ledger._id } },
        );
        paymentGateway.succeedRefund(op.providerRefundId!);
        await relationshipService.reconcile(row.client._id);
        await recoveryService.runOnce();
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "RESTORATION_PENDING",
        );
        const unchanged = await BookingFinancialTransactionModel.findById(ledger._id).orFail();
        expect(
          String(field === "sourceType" ? unchanged.metadata?.["sourceType"] : unchanged[field]),
        ).toBe(String(mismatch));
        expect(
          await BookingFinancialTransactionModel.countDocuments({
            type: "REFUND",
            bookingId: row.booking._id,
          }),
        ).toBe(1);
      },
    );
    it("provider refund identity is fenced even when the replacement reports success", async () => {
      const row = await purchaseForP4("normal");
      paymentGateway.queueNextRefundOutcome("pending");
      await cancelP4(row);
      const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
      await expect(
        refundOperationRepository.recordProviderResult(op._id, {
          providerRefundId: "re_other",
          providerStatus: "SUCCEEDED",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await RefundOperationModel.findById(op._id))?.providerRefundId).toBe(
        op.providerRefundId,
      );
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
        "RESTORATION_PENDING",
      );
    });
    it.each(["normal", "package"] as const)(
      "%s: request, webhook and recovery race converge on one refund",
      async (kind) => {
        const row = await purchaseForP4(kind);
        paymentGateway.queueNextRefundOutcome("pending");
        await cancelP4(row);
        const op = await RefundOperationModel.findOne({ bookingId: row.booking._id }).orFail();
        const sourceBefore = await BookingFinancialTransactionModel.findById(
          op.sourceFinancialTransactionId,
        ).lean();
        paymentGateway.succeedRefund(op.providerRefundId!);
        await Promise.all([
          cancelP4(row),
          recoveryService.runOnce(),
          webhookService.process({
            id: `evt_${new Types.ObjectId()}`,
            type: "charge.refunded",
            data: {
              object: {
                id: `ch_${new Types.ObjectId()}`,
                payment_intent: op.sourcePaymentIntentId,
                metadata: {},
                refunds: {
                  data: [
                    {
                      id: op.providerRefundId,
                      amount: op.expectedRefundAmountCents,
                      currency: "eur",
                      status: "succeeded",
                      metadata: { booklyRefundOperationId: String(op._id) },
                    },
                  ],
                },
              },
            },
          } as unknown as Stripe.Event),
        ]);
        expect(paymentGateway.refundInputs).toHaveLength(1);
        expect(await RefundOperationModel.countDocuments({ bookingId: row.booking._id })).toBe(1);
        expect(
          await BookingFinancialTransactionModel.countDocuments({
            bookingId: row.booking._id,
            type: "REFUND",
            direction: "CREDIT",
            status: "SUCCEEDED",
          }),
        ).toBe(1);
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "ELIGIBLE",
        );
        expect(
          await BookingFinancialTransactionModel.findById(op.sourceFinancialTransactionId).lean(),
        ).toEqual(sourceBefore);
      },
    );
    it("zero-bundle package restores transactionally without money artifacts", async () => {
      const row = await purchaseForP4("package", 0);
      await cancelP4(row);
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("ELIGIBLE");
      expect(await RefundOperationModel.countDocuments()).toBe(0);
      expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
      expect((await PackageProgressModel.findById(row.progress!._id))?.voidedAt).toBeDefined();
    });
    it("package origin-only and later session cancellation preserve consumed FIRST", async () => {
      const row = await purchaseForP4("package", 300);
      const later = await redeemP4(row, "10:00");
      await lifecycleService.cancelByBusiness(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(row.booking._id),
        "origin only",
      );
      expect((await PackageProgressModel.findById(row.progress!._id))?.voidedAt).toBeUndefined();
      await lifecycleService.cancelByBusiness(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(later._id),
        "later only",
      );
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("CONSUMED");
      await cancelP4(row);
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("ELIGIBLE");
      expect(paymentGateway.refundInputs).toHaveLength(1);
    });
    it.each(["CUSTOMER", "BUSINESS_OWNER"] as const)(
      "%s future batch excludes origin, retains entitlement and is repeat safe",
      async (role) => {
        const row = await purchaseForP4("package", 0);
        const later = await redeemP4(row, "10:00");
        const action = () =>
          lifecycleService.packageAction(
            String(role === "CUSTOMER" ? row.customer._id : row.fixture.owner._id),
            role,
            String(row.fixture.business._id),
            String(row.progress!._id),
            "CANCEL_FUTURE",
          );
        const result = await action();
        expect(result.cancelledBookingIds).toEqual([String(later._id)]);
        expect(result.packageProgress.remainingSessions).toBe(2);
        expect(result.packageProgress.voidedAt).toBeUndefined();
        await action();
        expect((await PackageProgressModel.findById(row.progress!._id))?.remainingSessions).toBe(2);
        expect((await BookingModel.findById(row.booking._id))?.status).toBe("UPCOMING");
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "CONSUMED",
        );
        expect((await redeemP4(row, "11:00")).status).toBe("UPCOMING");
      },
    );
    it.each(["CUSTOMER", "BUSINESS_OWNER"] as const)(
      "%s partial termination preserves completed history without bundle proration",
      async (role) => {
        const row = await purchaseForP4("package");
        await lifecycleService.completeBooking(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(row.booking._id),
          { settlement: "FULL" },
        );
        const later = await redeemP4(row, "10:00");
        await cancelP4(row, role);
        expect((await BookingModel.findById(row.booking._id))?.status).toBe("COMPLETED");
        expect((await BookingModel.findById(later._id))?.status).toBe(
          role === "CUSTOMER" ? "CANCELLED_BY_CUSTOMER" : "CANCELLED_BY_BUSINESS",
        );
        const progress = await PackageProgressModel.findById(row.progress!._id).orFail();
        expect(progress.voidedAt).toBeDefined();
        expect(progress.completedSessions).toBe(1);
        expect(paymentGateway.refundInputs.map((input) => input.amountCents)).toEqual(
          role === "CUSTOMER" ? [] : [2000],
        );
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          role === "CUSTOMER" ? "CONSUMED" : "ELIGIBLE",
        );
        expect(await packageProgressRepository.claimSession(progress._id)).toBeNull();
      },
    );
    it.each(["PENDING", "UPCOMING"] as const)(
      "unresolved %s blocks full termination without partial writes",
      async (status) => {
        const row = await purchaseForP4("package", 0);
        await BookingModel.updateOne(
          { _id: row.booking._id },
          { $set: { status, "schedule.startAt": new Date(Date.now() - 60000) } },
        );
        await expect(cancelP4(row)).rejects.toMatchObject({ statusCode: 409 });
        expect((await PackageProgressModel.findById(row.progress!._id))?.voidedAt).toBeUndefined();
        expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
          "CONSUMED",
        );
      },
    );
    it.each(["SUPERVISOR", "STAFF", "SUPER_ADMIN"] as const)(
      "%s cannot full-terminate",
      async (role) => {
        const row = await purchaseForP4("package", 0);
        await expect(
          lifecycleService.packageAction(
            String(row.fixture.owner._id),
            role,
            String(row.fixture.business._id),
            String(row.progress!._id),
            "TERMINATE",
          ),
        ).rejects.toMatchObject({ statusCode: 404 });
      },
    );
    it("cross-customer and cross-business package actions are denied", async () => {
      const row = await purchaseForP4("package", 0);
      const other = await purchaseForP4("package", 0);
      await expect(
        lifecycleService.packageAction(
          String(other.customer._id),
          "CUSTOMER",
          String(row.fixture.business._id),
          String(row.progress!._id),
          "TERMINATE",
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        lifecycleService.packageAction(
          String(other.fixture.owner._id),
          "BUSINESS_OWNER",
          String(other.fixture.business._id),
          String(row.progress!._id),
          "TERMINATE",
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("termination beats stale claim; precharged extras are compensated and no booking survives", async () => {
      const row = await purchaseForP4("package", 0);
      const addon = await createAddon(row.fixture, row.fixture.packageService._id, 2000);
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = packageProgressRepository.claimSession.bind(packageProgressRepository);
      const spy = vi
        .spyOn(packageProgressRepository, "claimSession")
        .mockImplementationOnce(async (...args) => {
          enter();
          await gate;
          return original(...args);
        });
      const scheduling = redeemP4(row, "10:00", [String(addon._id)]).then(
        () => ({ success: true }),
        (error) => ({ success: false, error }),
      );
      await entered;
      await cancelP4(row);
      resume();
      const outcome = await scheduling;
      spy.mockRestore();
      expect(outcome.success).toBe(false);
      expect(await BookingModel.countDocuments({ status: "UPCOMING" })).toBe(0);
      expect(paymentGateway.refundInputs.map((input) => input.amountCents)).toEqual([500]);
    });
    it("claim-first and duplicate termination cancel each future booking once", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      await Promise.all([cancelP4(row), cancelP4(row)]);
      const progress = await PackageProgressModel.findById(row.progress!._id).orFail();
      expect(progress.voidedAt).toBeDefined();
      expect(progress.remainingSessions).toBe(3);
      expect(progress.sessions.find((entry) => entry.bookingId.equals(later._id))?.status).toBe(
        "CANCELLED",
      );
      expect(await BookingModel.countDocuments({ status: "UPCOMING" })).toBe(0);
    });
    it("Session extras refund recovery cannot terminate package or restore FIRST", async () => {
      const row = await purchaseForP4("package", 0);
      const addon = await createAddon(row.fixture, row.fixture.packageService._id, 2000);
      const later = await redeemP4(row, "10:00", [String(addon._id)]);
      paymentGateway.queueNextRefundOutcome("pending");
      await lifecycleService.cancelByBusiness(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(later._id),
        "extras",
      );
      const op = await RefundOperationModel.findOne({ bookingId: later._id }).orFail();
      await RefundOperationModel.updateOne(
        { _id: op._id },
        { $set: { packageProgressId: row.progress!._id } },
      );
      paymentGateway.succeedRefund(op.providerRefundId!);
      await recoveryService.runOnce();
      expect((await PackageProgressModel.findById(row.progress!._id))?.voidedAt).toBeUndefined();
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("CONSUMED");
    });
    it.each(["succeeded", "pending", "failed"] as const)(
      "business promo reversal survives %s refund and duplicate cancellation",
      async (refundStatus) => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(fixture, `promo-${refundStatus}`);
        const code = `P4${new Types.ObjectId()}`;
        const promo = await new PromoRepository().create({
          code,
          normalizedCode: code.toUpperCase(),
          type: "PERCENTAGE",
          value: 20,
          scope: "ALL_BOOKINGS",
          perUserUsageLimit: 1,
          businessIds: [],
          expiresAt: new Date("2040-01-01"),
          createdByUserId: fixture.owner._id,
        });
        const booking = confirmed(
          await creationService.finalizeCustomerBooking(
            String(customer._id),
            String(fixture.business._id),
            { ...normalInput(fixture), promoCode: code },
          ),
        );
        paymentGateway.queueNextRefundOutcome(refundStatus);
        const cancel = () =>
          lifecycleService.cancelByBusiness(
            String(fixture.owner._id),
            "BUSINESS_OWNER",
            String(fixture.business._id),
            String(booking._id),
            "promo",
          );
        await cancel();
        await cancel();
        expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(0);
        expect((await PromoUserUsageModel.findOne({ promoId: promo._id }))?.count).toBe(0);
        expect(await PromoRedemptionModel.countDocuments({ bookingId: booking._id })).toBe(1);
        expect(
          (await PromoRedemptionModel.findOne({ bookingId: booking._id }))?.usageRestoredAt,
        ).toBeDefined();
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe(
          refundStatus === "succeeded" ? "ELIGIBLE" : "RESTORATION_PENDING",
        );
      },
    );
    it("100% promo zero FIRST restores both entitlements without payment; underflow aborts the whole transaction", async () => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, "p4-zero-promo");
      const promo = await new PromoRepository().create({
        code: "P4ZERO",
        normalizedCode: "P4ZERO",
        type: "PERCENTAGE",
        value: 100,
        scope: "ALL_BOOKINGS",
        perUserUsageLimit: 1,
        businessIds: [],
        expiresAt: new Date("2040-01-01"),
        createdByUserId: fixture.owner._id,
      });
      const booking = confirmed(
        await creationService.finalizeCustomerBooking(
          String(customer._id),
          String(fixture.business._id),
          { ...normalInput(fixture), promoCode: "P4ZERO" },
        ),
      );
      await PromoUserUsageModel.updateOne({ promoId: promo._id }, { $set: { count: 0 } });
      const cancel = () =>
        lifecycleService.cancelByBusiness(
          String(fixture.owner._id),
          "BUSINESS_OWNER",
          String(fixture.business._id),
          String(booking._id),
          "zero",
        );
      await expect(cancel()).rejects.toThrow();
      expect((await BookingModel.findById(booking._id))?.status).toBe("UPCOMING");
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("CONSUMED");
      expect(
        (await PromoRedemptionModel.findOne({ bookingId: booking._id }))?.usageRestoredAt,
      ).toBeUndefined();
      await PromoUserUsageModel.updateOne({ promoId: promo._id }, { $set: { count: 1 } });
      await cancel();
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("ELIGIBLE");
      expect(await RefundOperationModel.countDocuments()).toBe(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
    });
    it.each(["normal", "package"] as const)(
      "zero package restoration permits next %s FIRST",
      async (nextKind) => {
        const row = await purchaseForP4("package", 0);
        await cancelP4(row);
        const next = confirmed(
          nextKind === "normal"
            ? await finalizeNormal(row.fixture, row.customer._id, normalInput(row.fixture))
            : await finalizePackage(row.fixture, row.customer._id, packageInput(row.fixture)),
        );
        expect(next.financialContract?.classification).toBe("FIRST");
      },
    );
    it.each(["CUSTOMER", "NO_SHOW"] as const)("%s never reverses promo or FIRST", async (actor) => {
      const fixture = await setupFixture();
      const { customer, client } = await createLinkedCustomer(fixture, `p4-keep-${actor}`);
      const code = `KEEP${new Types.ObjectId()}`;
      const promo = await new PromoRepository().create({
        code,
        normalizedCode: code.toUpperCase(),
        type: "PERCENTAGE",
        value: 20,
        scope: "ALL_BOOKINGS",
        perUserUsageLimit: 1,
        businessIds: [],
        expiresAt: new Date("2040-01-01"),
        createdByUserId: fixture.owner._id,
      });
      const booking = confirmed(
        await creationService.finalizeCustomerBooking(
          String(customer._id),
          String(fixture.business._id),
          { ...normalInput(fixture), promoCode: code },
        ),
      );
      if (actor === "CUSTOMER")
        await lifecycleService.cancelByCustomer(
          String(customer._id),
          String(booking._id),
          undefined,
        );
      else {
        await lifecycleService.markNoShow(
          String(fixture.owner._id),
          "BUSINESS_OWNER",
          String(fixture.business._id),
          String(booking._id),
        );
        await lifecycleService.waiveFee(
          String(fixture.owner._id),
          "BUSINESS_OWNER",
          String(fixture.business._id),
          String(booking._id),
          "test",
          undefined,
        );
      }
      expect(
        (await PromoRedemptionModel.findOne({ bookingId: booking._id }))?.usageRestoredAt,
      ).toBeUndefined();
      expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(1);
      expect((await PromoUserUsageModel.findOne({ promoId: promo._id }))?.count).toBe(1);
      expect((await relationshipOf(client._id)).financialRelationship?.state).toBe("CONSUMED");
    });
    it("unlimited promo restores only the counters it actually consumed", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "p4-unlimited");
      const promo = await new PromoRepository().create({
        code: "UNLIMITED",
        normalizedCode: "UNLIMITED",
        type: "PERCENTAGE",
        value: 100,
        scope: "ALL_BOOKINGS",
        businessIds: [],
        expiresAt: new Date("2040-01-01"),
        createdByUserId: fixture.owner._id,
      });
      const booking = confirmed(
        await creationService.finalizeCustomerBooking(
          String(customer._id),
          String(fixture.business._id),
          { ...normalInput(fixture), promoCode: promo.code },
        ),
      );
      await lifecycleService.cancelByBusiness(
        String(fixture.owner._id),
        "BUSINESS_OWNER",
        String(fixture.business._id),
        String(booking._id),
        undefined,
      );
      expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(0);
      expect(await PromoUserUsageModel.countDocuments()).toBe(0);
      expect(
        (await PromoRedemptionModel.findOne({ bookingId: booking._id }))?.userUsageCounted,
      ).toBe(false);
    });
    it("active supervisor may cancel future appointments but cannot terminate the package", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      const supervisor = await userRepository.create({
        normalizedEmail: "p4-supervisor@example.com",
        passwordHash: "hash",
        role: "SUPERVISOR",
        status: "ACTIVE",
      });
      await staffRepository.create({
        userId: supervisor._id,
        businessId: row.fixture.business._id,
        role: "SUPERVISOR",
        createdByUserId: row.fixture.owner._id,
      });
      const result = await lifecycleService.packageAction(
        String(supervisor._id),
        "SUPERVISOR",
        String(row.fixture.business._id),
        String(row.progress!._id),
        "CANCEL_FUTURE",
      );
      expect(result.cancelledBookingIds).toEqual([String(later._id)]);
      await expect(
        lifecycleService.packageAction(
          String(supervisor._id),
          "SUPERVISOR",
          String(row.fixture.business._id),
          String(row.progress!._id),
          "TERMINATE",
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("claim commits while termination is beginning: fresh transactional read includes it", async () => {
      const row = await purchaseForP4("package", 0);
      let entered!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = packageProgressRepository.findByIdInternal.bind(packageProgressRepository);
      const spy = vi
        .spyOn(packageProgressRepository, "findByIdInternal")
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      const termination = cancelP4(row);
      await ready;
      const later = await redeemP4(row, "10:00");
      resume();
      await termination;
      spy.mockRestore();
      expect((await BookingModel.findById(later._id))?.status).toBe("CANCELLED_BY_BUSINESS");
      expect(
        (await PackageProgressModel.findById(row.progress!._id))?.sessions.some(
          (entry) => entry.status === "SCHEDULED",
        ),
      ).toBe(false);
    });
    it("full termination vs completion preserves whichever session interpretation won", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      const results = await Promise.allSettled([
        cancelP4(row),
        lifecycleService.completeBooking(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(later._id),
        ),
      ]);
      if (results[0]?.status === "rejected") await cancelP4(row);
      const booking = await BookingModel.findById(later._id).orFail();
      const progress = await PackageProgressModel.findById(row.progress!._id).orFail();
      expect(progress.voidedAt).toBeDefined();
      expect(progress.sessions.find((entry) => entry.bookingId.equals(later._id))?.status).toBe(
        booking.status === "COMPLETED" ? "COMPLETED" : "CANCELLED",
      );
    });
    it("full termination vs no-show either cancels or fails closed on pending resolution", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      const results = await Promise.allSettled([
        cancelP4(row),
        lifecycleService.markNoShow(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(later._id),
        ),
      ]);
      const progress = await PackageProgressModel.findById(row.progress!._id).orFail();
      const booking = await BookingModel.findById(later._id).orFail();
      if (results[0]?.status === "fulfilled") {
        expect(progress.voidedAt).toBeDefined();
        expect(booking.status).toBe("CANCELLED_BY_BUSINESS");
      } else {
        expect(progress.voidedAt).toBeUndefined();
        expect(booking.status).toBe("PENDING");
      }
    });
    it("full termination vs reschedule leaves no scheduled booking on the terminal package", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      const results = await Promise.allSettled([
        cancelP4(row),
        lifecycleService.rescheduleByOwner(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(later._id),
          startAtFor("12:00", DATE_2),
        ),
      ]);
      if (results[0]?.status === "rejected") await cancelP4(row);
      expect((await BookingModel.findById(later._id))?.status).toBe("CANCELLED_BY_BUSINESS");
      expect((await PackageProgressModel.findById(row.progress!._id))?.voidedAt).toBeDefined();
    });
    it("missing positive upfront evidence fails closed rather than restoring zero FIRST", async () => {
      const row = await purchaseForP4("normal");
      await BookingFinancialTransactionModel.deleteMany({ bookingId: row.booking._id });
      await expect(cancelP4(row)).rejects.toMatchObject({ statusCode: 409 });
      expect((await BookingModel.findById(row.booking._id))?.status).toBe("UPCOMING");
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("CONSUMED");
    });
    it("legacy relationship without consumed identity is never guessed for restoration", async () => {
      const row = await purchaseForP4("normal");
      await BusinessClientModel.updateOne(
        { _id: row.client._id },
        { $unset: { "financialRelationship.consumed": 1 } },
      );
      await cancelP4(row);
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("CONSUMED");
    });
    it("business RETURNING normal promo and package terminate without restoring the original FIRST", async () => {
      const row = await purchaseForP4("normal");
      const promo = await new PromoRepository().create({
        code: "RETURNP4",
        normalizedCode: "RETURNP4",
        type: "PERCENTAGE",
        value: 100,
        scope: "ALL_BOOKINGS",
        perUserUsageLimit: 1,
        businessIds: [],
        expiresAt: new Date("2040-01-01"),
        createdByUserId: row.fixture.owner._id,
      });
      const returning = confirmed(
        await creationService.finalizeCustomerBooking(
          String(row.customer._id),
          String(row.fixture.business._id),
          { ...normalInput(row.fixture, "12:00"), promoCode: promo.code },
        ),
      );
      await lifecycleService.cancelByBusiness(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(returning._id),
        undefined,
      );
      const purchase = confirmed(
        await finalizePackage(row.fixture, row.customer._id, packageInput(row.fixture)),
      );
      const progress = await PackageProgressModel.findOne({
        originBookingId: purchase._id,
      }).orFail();
      await lifecycleService.packageAction(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(progress._id),
        "TERMINATE",
      );
      expect(purchase.financialContract?.classification).toBe("RETURNING");
      expect(
        (await relationshipOf(row.client._id)).financialRelationship?.consumed?.bookingId,
      ).toEqual(row.booking._id);
      expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(0);
      expect(await RefundOperationModel.countDocuments()).toBe(0);
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "REFUND" })).toBe(0);
    });
    it.each(["PENDING", "UPCOMING"] as const)(
      "future batch excludes %s past/unresolved session",
      async (status) => {
        const row = await purchaseForP4("package", 0);
        const earlier = await redeemP4(row, "10:00");
        const future = await redeemP4(row, "11:00");
        await BookingModel.updateOne(
          { _id: earlier._id },
          { $set: { status, "schedule.startAt": new Date(Date.now() - 60000) } },
        );
        const result = await lifecycleService.packageAction(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(row.progress!._id),
          "CANCEL_FUTURE",
        );
        expect(result.cancelledBookingIds).toEqual([String(future._id)]);
        expect((await BookingModel.findById(earlier._id))?.status).toBe(status);
        expect(result.packageProgress.remainingSessions).toBe(1);
      },
    );
    it("repeated promo reversal repository entry is a no-op even after a limit edit", async () => {
      const fixture = await setupFixture();
      const { customer } = await createLinkedCustomer(fixture, "p4-repeat-reversal");
      const promo = await new PromoRepository().create({
        code: "REENTRY",
        normalizedCode: "REENTRY",
        type: "PERCENTAGE",
        value: 100,
        scope: "ALL_BOOKINGS",
        perUserUsageLimit: 1,
        businessIds: [],
        expiresAt: new Date("2040-01-01"),
        createdByUserId: fixture.owner._id,
      });
      const booking = confirmed(
        await creationService.finalizeCustomerBooking(
          String(customer._id),
          String(fixture.business._id),
          { ...normalInput(fixture), promoCode: promo.code },
        ),
      );
      const dbSession = await mongoose.startSession();
      try {
        await dbSession.withTransaction(async () => {
          const reversals = new PromoRedemptionRepository();
          const identity = {
            bookingId: booking._id,
            businessId: fixture.business._id,
            customerUserId: customer._id,
            actorUserId: fixture.owner._id,
          };
          await reversals.restoreBusinessCancellation(identity, dbSession);
          await reversals.restoreBusinessCancellation(identity, dbSession);
        });
      } finally {
        await dbSession.endSession();
      }
      expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(0);
      expect((await PromoUserUsageModel.findOne({ promoId: promo._id }))?.count).toBe(0);
      expect(await PromoRedemptionModel.countDocuments({ bookingId: booking._id })).toBe(1);
    });
    it("completed sessions cannot be restored by a repeated terminal hook", async () => {
      const row = await purchaseForP4("package", 0);
      const later = await redeemP4(row, "10:00");
      await lifecycleService.completeBooking(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(later._id),
      );
      const before = await PackageProgressModel.findById(row.progress!._id).orFail();
      await packageProgressRepository.resolveSessionOnTerminalStatus(later._id, "RESTORE");
      const after = await PackageProgressModel.findById(row.progress!._id).orFail();
      expect(after.remainingSessions).toBe(before.remainingSessions);
      expect(after.sessions.find((entry) => entry.bookingId.equals(later._id))?.status).toBe(
        "COMPLETED",
      );
    });
    it("future batch includes a claim that commits before its fresh transactional read", async () => {
      const row = await purchaseForP4("package", 0);
      let entered!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = packageProgressRepository.findByIdInternal.bind(packageProgressRepository);
      const spy = vi
        .spyOn(packageProgressRepository, "findByIdInternal")
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      const batch = lifecycleService.packageAction(
        String(row.fixture.owner._id),
        "BUSINESS_OWNER",
        String(row.fixture.business._id),
        String(row.progress!._id),
        "CANCEL_FUTURE",
      );
      await ready;
      const later = await redeemP4(row, "10:00");
      resume();
      const result = await batch;
      spy.mockRestore();
      expect(result.cancelledBookingIds).toEqual([String(later._id)]);
      expect(result.packageProgress.voidedAt).toBeUndefined();
      expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe("CONSUMED");
      expect((await redeemP4(row, "11:00")).status).toBe("UPCOMING");
    });
    it.each(["CUSTOMER", "BUSINESS_OWNER"] as const)(
      "business cancellation vs %s cancellation reverses promo only for the winning business transition",
      async (competingActor) => {
        const fixture = await setupFixture();
        const { customer, client } = await createLinkedCustomer(
          fixture,
          `p4-cancel-race-${competingActor}`,
        );
        const promo = await new PromoRepository().create({
          code: "RACEP4",
          normalizedCode: "RACEP4",
          type: "PERCENTAGE",
          value: 100,
          scope: "ALL_BOOKINGS",
          perUserUsageLimit: 1,
          businessIds: [],
          expiresAt: new Date("2040-01-01"),
          createdByUserId: fixture.owner._id,
        });
        const booking = confirmed(
          await creationService.finalizeCustomerBooking(
            String(customer._id),
            String(fixture.business._id),
            { ...normalInput(fixture), promoCode: promo.code },
          ),
        );
        const businessCancel = () =>
          lifecycleService.cancelByBusiness(
            String(fixture.owner._id),
            "BUSINESS_OWNER",
            String(fixture.business._id),
            String(booking._id),
            undefined,
          );
        const outcomes = await Promise.allSettled([
          businessCancel(),
          competingActor === "CUSTOMER"
            ? lifecycleService.cancelByCustomer(
                String(customer._id),
                String(booking._id),
                undefined,
              )
            : businessCancel(),
        ]);
        expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
        const final = await BookingModel.findById(booking._id).orFail();
        const businessWon = final.status === "CANCELLED_BY_BUSINESS";
        expect(final.eventHistory.filter((event) => event.type === "STATUS_CHANGED")).toHaveLength(
          1,
        );
        expect((await relationshipOf(client._id)).financialRelationship?.state).toBe(
          businessWon ? "ELIGIBLE" : "CONSUMED",
        );
        expect((await new PromoRepository().findById(promo._id))?.redeemedCount).toBe(
          businessWon ? 0 : 1,
        );
        expect((await PromoUserUsageModel.findOne({ promoId: promo._id }))?.count).toBe(
          businessWon ? 0 : 1,
        );
        const redemption = await PromoRedemptionModel.findOne({ bookingId: booking._id }).orFail();
        expect(Boolean(redemption.usageRestoredAt)).toBe(businessWon);
        expect(await PromoRedemptionModel.countDocuments({ bookingId: booking._id })).toBe(1);
      },
    );
    it.each(["CUSTOMER", "BUSINESS_OWNER"] as const)(
      "%s full termination preserves a forfeited session and its money facts",
      async (actor) => {
        const row = await purchaseForP4("package", 300);
        const later = await redeemP4(row, "10:00");
        await lifecycleService.markNoShow(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(later._id),
        );
        await lifecycleService.waiveFee(
          String(row.fixture.owner._id),
          "BUSINESS_OWNER",
          String(row.fixture.business._id),
          String(later._id),
          "test",
          undefined,
        );
        const before = await BookingFinancialTransactionModel.find({ bookingId: later._id }).lean();
        await cancelP4(row, actor);
        const progress = await PackageProgressModel.findById(row.progress!._id).orFail();
        expect(progress.voidedAt).toBeDefined();
        expect(progress.sessions.find((entry) => entry.bookingId.equals(later._id))?.status).toBe(
          "FORFEITED",
        );
        expect(progress.remainingSessions).toBe(2);
        expect(
          await BookingFinancialTransactionModel.find({ bookingId: later._id }).lean(),
        ).toEqual(before);
        const refunds = await RefundOperationModel.find({ bookingId: row.booking._id });
        if (actor === "CUSTOMER") {
          expect(refunds).toHaveLength(0);
          expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
            "CONSUMED",
          );
        } else {
          expect(refunds).toHaveLength(1);
          expect(refunds[0]?.expectedRefundAmountCents).toBe(
            row.booking.financialContract?.onlineChargeCents,
          );
          expect((await relationshipOf(row.client._id)).financialRelationship?.state).toBe(
            "ELIGIBLE",
          );
        }
      },
    );
    it("terminal success cannot regress from a stale settlement writer", async () => {
      const row = await purchaseForP4("normal");
      await cancelP4(row);
      await bookingRepository.updateCancellationSettlement(row.booking._id, "FAILED", undefined);
      expect(
        (await BookingModel.findById(row.booking._id))?.cancellationOutcome?.settlementStatus,
      ).toBe("SUCCEEDED");
    });
  });
  describe("A1 Customer replay ownership", () => {
    afterEach(() => vi.restoreAllMocks());
    const denied = { statusCode: 409, details: [{ code: "BOOKING_IDEMPOTENCY_CONFLICT" }] };
    const databaseState = async () => {
      const db = mongoose.connection.db;
      if (!db || mongoose.connection.host !== "127.0.0.1")
        throw new Error("Owned database required");
      const state: Record<string, unknown> = {};
      for (const collection of (await db.collections()).sort((a, b) =>
        a.collectionName.localeCompare(b.collectionName),
      ))
        state[collection.collectionName] = await collection.find({}).sort({ _id: 1 }).toArray();
      return JSON.stringify({
        state,
        provider: paymentGateway.paymentIntentInputs,
        refunds: paymentGateway.refundInputs,
        tax: taxGateway.calls,
      });
    };
    const setupReplay = async (kind: "normal" | "purchase" | "redemption") => {
      const f = await setupFixture({ fixedPriceCents: 0, bundlePriceCents: 0 });
      const { customer } = await createLinkedCustomer(f, "a1-owner");
      let progressId: Types.ObjectId | undefined;
      const input = kind === "normal" ? normalInput(f) : packageInput(f);
      if (kind === "redemption") {
        const purchase = confirmed(await finalizePackage(f, customer._id, packageInput(f)));
        progressId = (
          await PackageProgressModel.findOne({ originBookingId: purchase._id }).orFail()
        )._id;
      }
      const redemption = {
        staffMembershipId: String(f.staffId),
        startAt: startAtFor("10:00", DATE_2),
        idempotencyKey: input.idempotencyKey,
      };
      const call = (
        actor = customer._id,
        business = f.business._id,
        otherKey = input.idempotencyKey,
        selectedProgress = progressId,
      ) =>
        kind === "normal"
          ? creationService.finalizeCustomerBooking(String(actor), String(business), {
              ...input,
              idempotencyKey: otherKey,
            })
          : kind === "purchase"
            ? creationService.finalizePackagePurchase(String(actor), String(business), {
                ...input,
                idempotencyKey: otherKey,
              })
            : creationService.redeemPackageSession(
                String(actor),
                String(business),
                String(selectedProgress),
                { ...redemption, idempotencyKey: otherKey },
              );
      const booking = confirmed(await call());
      return { f, customer, booking, input, call, progressId };
    };
    const prepareA2 = async (kind: "normal" | "manual" | "purchase" | "redemption" | "paid") => {
      const f = await setupFixture({
        fixedPriceCents: kind === "paid" ? 10000 : 0,
        bundlePriceCents: 0,
      });
      const { customer, client } = await createLinkedCustomer(f, "a2-owner");
      const input = kind === "purchase" ? packageInput(f) : normalInput(f);
      let progressId: Types.ObjectId | undefined;
      if (kind === "redemption") {
        const purchase = confirmed(await finalizePackage(f, customer._id, packageInput(f)));
        progressId = (
          await PackageProgressModel.findOne({ originBookingId: purchase._id }).orFail()
        )._id;
      }
      const run = async () =>
        kind === "manual"
          ? creationService.createManualBooking(
              String(f.owner._id),
              "BUSINESS_OWNER",
              String(f.business._id),
              {
                ...input,
                businessClientId: String(client._id),
              },
            )
          : confirmed(
              await (kind === "purchase"
                ? finalizePackage(f, customer._id, input)
                : kind === "redemption"
                  ? creationService.redeemPackageSession(
                      String(customer._id),
                      String(f.business._id),
                      String(progressId),
                      {
                        staffMembershipId: String(f.staffId),
                        startAt: startAtFor("10:00", DATE_2),
                        idempotencyKey: input.idempotencyKey,
                      },
                    )
                  : finalizeNormal(f, customer._id, input)),
            );
      return { f, customer, client, input, run, progressId };
    };

    const c1Signal = () => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    it.each(["normal", "purchase", "redemption", "paid"] as const)(
      "C1 %s final admission rejects a shift edit after preview and preserves money authorities",
      async (kind) => {
        const f = await prepareA2(kind);
        const bookingsBefore = await BookingModel.countDocuments();
        const reservationsBefore = await BookingSlotReservationClaimModel.countDocuments();
        const reached = c1Signal(),
          proceed = c1Signal();
        const original = availabilityService.assertSlotIsBookable.bind(availabilityService);
        vi.spyOn(availabilityService, "assertSlotIsBookable").mockImplementation(
          async (input, session) => {
            const result = await original(input, session);
            if (!session) {
              reached.resolve();
              await proceed.promise;
            }
            return result;
          },
        );
        const pending = f.run().then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        try {
          await reached.promise;
          await staffScheduleRepository.replace(f.f.staffId, f.f.business._id, []);
        } finally {
          proceed.resolve();
        }
        expect((await pending).error).toMatchObject({ statusCode: 409 });
        expect(await BookingModel.countDocuments()).toBe(bookingsBefore);
        expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(reservationsBefore);
        if (kind === "paid") {
          expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
          expect(paymentGateway.refundInputs).toHaveLength(1);
        } else expect(paymentGateway.refundInputs).toHaveLength(0);
      },
    );
    it("C1 Customer admission wins before a prospective shift removal and replay remains read-only", async () => {
      const f = await prepareA2("normal");
      const reached = c1Signal(),
        proceed = c1Signal();
      const original = reservationService.reserveOrJoin.bind(reservationService);
      vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
        async (input, session) => {
          reached.resolve();
          await proceed.promise;
          return original(input, session);
        },
      );
      const pending = f.run();
      await reached.promise;
      const mutation = staffScheduleRepository.replace(f.f.staffId, f.f.business._id, []);
      proceed.resolve();
      const booking = await pending;
      await mutation;
      const before = await databaseState();
      expect((await f.run())._id).toEqual(booking._id);
      expect(await databaseState()).toBe(before);
    });
    it("C1 ordinary travel admission rechecks active city after preview", async () => {
      const f = await setupFixture({ fixedPriceCents: 0, travel: { feeCents: 0 } });
      const { customer } = await createLinkedCustomer(f, "c1-travel");
      const reached = c1Signal(),
        proceed = c1Signal();
      const original = claimRepository.claim.bind(claimRepository);
      vi.spyOn(claimRepository, "claim").mockImplementationOnce(async (input) => {
        const result = await original(input);
        reached.resolve();
        await proceed.promise;
        return result;
      });
      const pending = finalizeNormal(
        f,
        customer._id,
        normalInput(f, "10:00", { travel: true }),
      ).then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      try {
        await reached.promise;
        await new BusinessTravelSettingsService(
          businessTravelSettingsRepository,
          businessRepository,
          new BusinessAccessRepository(),
        ).updateBusinessTravelSettings(String(f.owner._id), String(f.business._id), [
          { city: "Larnaca", active: false, feeCents: 0 },
        ]);
      } finally {
        proceed.resolve();
      }
      expect((await pending).error).toMatchObject({ statusCode: 409 });
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    });

    it("C1 ordinary travel admission commits before a prospective city deactivation", async () => {
      const f = await setupFixture({ fixedPriceCents: 0, travel: { feeCents: 0 } });
      const { customer } = await createLinkedCustomer(f, "c1-travel-first");
      const input = normalInput(f, "10:00", { travel: true });
      const reached = c1Signal(),
        proceed = c1Signal();
      const original = reservationService.reserveOrJoin.bind(reservationService);
      vi.spyOn(reservationService, "reserveOrJoin").mockImplementationOnce(
        async (request, session) => {
          reached.resolve();
          await proceed.promise;
          return original(request, session);
        },
      );
      const pending = finalizeNormal(f, customer._id, input);
      await reached.promise;
      const mutation = new BusinessTravelSettingsService(
        businessTravelSettingsRepository,
        businessRepository,
        new BusinessAccessRepository(),
      ).updateBusinessTravelSettings(String(f.owner._id), String(f.business._id), [
        { city: "Larnaca", active: false, feeCents: 0 },
      ]);
      proceed.resolve();
      const booking = confirmed(await pending);
      await mutation;
      const before = await databaseState();
      expect(confirmed(await finalizeNormal(f, customer._id, input))._id).toEqual(booking._id);
      expect(await databaseState()).toBe(before);
      expect(
        await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "APPLIED" }),
      ).toBe(1);
    });
    const injectA2Outcome = (mode: "committed" | "unresolved") => {
      const originalStart = mongoose.startSession.bind(mongoose);
      vi.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
        const session = await originalStart(...args);
        const originalTransaction = session.withTransaction.bind(session);
        vi.spyOn(session, "withTransaction").mockImplementation(async (callback, options) => {
          await originalTransaction(async (active) => {
            await callback(active);
            if (mode === "unresolved") await active.abortTransaction();
          }, options);
          // Public transaction-return boundary injection, NOT a wire acknowledgement fault.
          if (mode === "committed") expect(await BookingModel.countDocuments()).toBeGreaterThan(0);
          const error = new mongoose.mongo.MongoServerError({
            message: "A2 injected unknown transaction result",
          });
          error.addErrorLabel("UnknownTransactionCommitResult");
          throw error;
        });
        return session;
      });
    };
    it.each(["normal", "manual", "purchase", "redemption", "paid"] as const)(
      "A2 committed %s survives injected lost transaction return and replays original",
      async (kind) => {
        const f = await prepareA2(kind);
        injectA2Outcome("committed");
        const booking = await f.run().catch(async (error) => {
          expect(await BookingModel.countDocuments()).toBeGreaterThan(0);
          expect(await claimRepository.findByIdempotencyKey(f.input.idempotencyKey)).not.toBeNull();
          throw error;
        });
        const claim = await claimRepository.findByIdempotencyKey(f.input.idempotencyKey);
        expect(String(claim?.bookingId)).toBe(String(booking._id));
        const before = await databaseState();
        expect(String((await f.run())._id)).toBe(String(booking._id));
        expect(await databaseState()).toBe(before);
        expect(paymentGateway.refundInputs).toHaveLength(0);
      },
    );
    it.each(["normal", "manual", "purchase", "redemption", "paid"] as const)(
      "A2 unresolved %s preserves claim and bounded retries without replacement or refund",
      async (kind) => {
        const f = await prepareA2(kind);
        injectA2Outcome("unresolved");
        await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
        const claim = await claimRepository.findByIdempotencyKey(f.input.idempotencyKey);
        expect(claim).not.toBeNull();
        expect(await BookingModel.findById(claim?.bookingId)).toBeNull();
        const before = await databaseState();
        await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
        await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
        expect(await databaseState()).toBe(before);
        expect(paymentGateway.refundInputs).toHaveLength(0);
      },
    );
    it.each(["absent", "read failure"] as const)(
      "A2 delayed winner resolution after %s retains the original operation",
      async (fault) => {
        const f = await prepareA2("normal");
        injectA2Outcome("committed");
        const read = vi.spyOn(bookingRepository, "findById");
        if (fault === "absent") read.mockResolvedValueOnce(null);
        else read.mockRejectedValueOnce(new Error("A2 temporary result-read failure"));
        await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
        const claim = await claimRepository.findByIdempotencyKey(f.input.idempotencyKey);
        expect(claim).not.toBeNull();
        expect(await BookingModel.findById(claim?.bookingId)).not.toBeNull();
        const before = await databaseState();
        expect(String((await f.run())._id)).toBe(String(claim?.bookingId));
        expect(await databaseState()).toBe(before);
      },
    );
    it.each(["normal", "manual", "purchase", "redemption"] as const)(
      "A2 definite callback abort for %s rolls back and permits an authorized retry",
      async (kind) => {
        const f = await prepareA2(kind);
        const count = await BookingModel.countDocuments();
        const progress = await PackageProgressModel.find({}).lean();
        vi.spyOn(bookingRepository, "create").mockRejectedValueOnce(new Error("A2 before commit"));
        await expect(f.run()).rejects.toThrow("A2 before commit");
        expect(await BookingModel.countDocuments()).toBe(count);
        expect(await PackageProgressModel.find({}).lean()).toEqual(progress);
        expect(await claimRepository.findByIdempotencyKey(f.input.idempotencyKey)).toBeNull();
        const result = await f.run();
        expect(
          String((await claimRepository.findByIdempotencyKey(f.input.idempotencyKey))?.bookingId),
        ).toBe(String(result._id));
      },
    );
    it.each(["normal", "manual", "purchase", "redemption"] as const)(
      "A2 session-start failure for %s permits retry without poisoning the claim",
      async (kind) => {
        const f = await prepareA2(kind);
        vi.spyOn(mongoose, "startSession").mockRejectedValueOnce(
          new Error("A2 session unavailable"),
        );
        await expect(f.run()).rejects.toThrow("A2 session unavailable");
        expect(await claimRepository.findByIdempotencyKey(f.input.idempotencyKey)).toBeNull();
        await f.run();
      },
    );
    it.each(["normal", "paid"] as const)(
      "A2 postcommit notification failure for %s never compensates or releases",
      async (kind) => {
        const f = await prepareA2(kind);
        const port = creationService as unknown as {
          dispatchBookingCreatedNotifications: () => Promise<void>;
        };
        vi.spyOn(port, "dispatchBookingCreatedNotifications").mockRejectedValue(
          new Error("A2 notification unavailable"),
        );
        const booking = await f.run();
        expect(
          String((await claimRepository.findByIdempotencyKey(f.input.idempotencyKey))?.bookingId),
        ).toBe(String(booking._id));
        expect(paymentGateway.refundInputs).toHaveLength(0);
        expect(String((await f.run())._id)).toBe(String(booking._id));
      },
    );
    it("A2 driver callback retry reuses pinned identity and dispatches outside the callback", async () => {
      const f = await prepareA2("paid");
      const error = new mongoose.mongo.MongoServerError({
        message: "A2 synthetic transient callback error",
      });
      error.addErrorLabel("TransientTransactionError");
      const original = bookingRepository.create.bind(bookingRepository);
      const create = vi
        .spyOn(bookingRepository, "create")
        .mockRejectedValueOnce(error)
        .mockImplementation(original);
      const result = await f.run();
      expect(create).toHaveBeenCalledTimes(2);
      expect(String(create.mock.calls[0]?.[0]._id)).toBe(String(result._id));
      expect(String(create.mock.calls[1]?.[0]._id)).toBe(String(result._id));
      expect(paymentGateway.paymentIntentInputs).toHaveLength(1);
      expect(await BookingModel.countDocuments()).toBe(1);
    });
    it("A2 conditional abort cleanup cannot delete a replacement claim", async () => {
      const f = await prepareA2("manual");
      let replacement: Types.ObjectId | undefined;
      vi.spyOn(bookingRepository, "create").mockImplementationOnce(async () => {
        replacement = new Types.ObjectId();
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { bookingId: replacement } },
        );
        throw new Error("A2 abort after claim replacement");
      });
      await expect(f.run()).rejects.toThrow("A2 abort after claim replacement");
      expect(
        String((await claimRepository.findByIdempotencyKey(f.input.idempotencyKey))?.bookingId),
      ).toBe(String(replacement));
    });
    it("A2 incomplete legacy entitlement never certifies a committed result", async () => {
      const f = await prepareA2("purchase");
      const originalStart = mongoose.startSession.bind(mongoose);
      vi.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
        const session = await originalStart(...args);
        const originalTransaction = session.withTransaction.bind(session);
        vi.spyOn(session, "withTransaction").mockImplementation(async (callback, options) => {
          await originalTransaction(callback, options);
          await PackageProgressModel.deleteMany({}); // only the owned synthetic DB
          throw new Error("A2 unlabelled post-callback uncertainty");
        });
        return session;
      });
      await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
      expect(await claimRepository.findByIdempotencyKey(f.input.idempotencyKey)).not.toBeNull();
      await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
      expect(await BookingModel.countDocuments()).toBe(1);
    });
    it.each(["normal", "purchase", "redemption"] as const)(
      "A1 same Customer %s replay returns original without side effects",
      async (kind) => {
        const f = await setupReplay(kind);
        const before = await databaseState();
        expect(String(confirmed(await f.call())._id)).toBe(String(f.booking._id));
        expect(await databaseState()).toBe(before);
      },
    );
    it.each(["normal", "purchase", "redemption"] as const)(
      "A1 denies foreign Customer %s finalized-key replay",
      async (kind) => {
        const f = await setupReplay(kind);
        const { customer: foreign } = await createLinkedCustomer(f.f, "a1-foreign");
        let foreignProgress: Types.ObjectId | undefined;
        if (kind === "redemption") {
          const purchase = confirmed(
            await finalizePackage(f.f, foreign._id, packageInput(f.f, "12:00")),
          );
          foreignProgress = (
            await PackageProgressModel.findOne({ originBookingId: purchase._id }).orFail()
          )._id;
        }
        const before = await databaseState();
        const read = vi.spyOn(bookingRepository, "findById");
        await expect(
          f.call(foreign._id, f.f.business._id, f.input.idempotencyKey, foreignProgress),
        ).rejects.toMatchObject(denied);
        if (kind !== "redemption") expect(read).not.toHaveBeenCalled();
        expect(await databaseState()).toBe(before);
      },
    );
    it.each(["normal", "purchase"] as const)(
      "A1 %s cross-Business replay denies independently",
      async (kind) => {
        const f = await setupReplay(kind);
        const other = await setupFixture();
        const before = await databaseState();
        await expect(f.call(f.customer._id, other.business._id)).rejects.toMatchObject(denied);
        expect(await databaseState()).toBe(before);
      },
    );
    it.each(["normal", "purchase"] as const)(
      "A1 %s wrong operation kind denies before replay",
      async (kind) => {
        const f = await setupReplay(kind);
        const before = await databaseState();
        const call =
          kind === "normal"
            ? finalizePackage(f.f, f.customer._id, {
                ...packageInput(f.f),
                idempotencyKey: f.input.idempotencyKey,
              })
            : finalizeNormal(f.f, f.customer._id, {
                ...normalInput(f.f),
                idempotencyKey: f.input.idempotencyKey,
              });
        await expect(call).rejects.toMatchObject(denied);
        expect(await databaseState()).toBe(before);
      },
    );
    it("A1 redemption key cannot replay as purchase or ordinary", async () => {
      const f = await setupReplay("redemption");
      const before = await databaseState();
      await expect(
        finalizeNormal(f.f, f.customer._id, {
          ...normalInput(f.f),
          idempotencyKey: f.input.idempotencyKey,
        }),
      ).rejects.toMatchObject(denied);
      await expect(
        finalizePackage(f.f, f.customer._id, {
          ...packageInput(f.f),
          idempotencyKey: f.input.idempotencyKey,
        }),
      ).rejects.toMatchObject(denied);
      expect(await databaseState()).toBe(before);
    });
    it("A1 rejects purchase key through owned Progress redemption", async () => {
      const f = await setupReplay("purchase");
      const progress = await PackageProgressModel.findOne({
        originBookingId: f.booking._id,
      }).orFail();
      const before = await databaseState();
      await expect(
        creationService.redeemPackageSession(
          String(f.customer._id),
          String(f.f.business._id),
          String(progress._id),
          {
            staffMembershipId: String(f.f.staffId),
            startAt: startAtFor("10:00", DATE_2),
            idempotencyKey: f.input.idempotencyKey,
          },
        ),
      ).rejects.toMatchObject(denied);
      expect(await databaseState()).toBe(before);
    });
    it.each([
      "claim actor",
      "claim Business",
      "claim Booking",
      "missing actor",
      "Booking Customer",
      "missing Booking Customer",
      "missing Booking client",
      "contract Customer",
      "contract client",
    ])("A1 fails closed on %s evidence", async (fault) => {
      const f = await setupReplay("normal");
      const other = await createLinkedCustomer(f.f, "a1-corrupt");
      // Deliberately corrupt only an owned test row to exercise fail-closed reads; no runtime bypass.
      if (fault === "claim actor")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { actorUserId: other.customer._id } },
        );
      if (fault === "claim Business")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { businessId: new Types.ObjectId() } },
        );
      if (fault === "claim Booking")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { bookingId: new Types.ObjectId() } },
        );
      if (fault === "missing actor")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $unset: { actorUserId: 1 } },
        );
      if (fault === "Booking Customer")
        await BookingModel.collection.updateOne(
          { _id: f.booking._id },
          { $set: { "customer.customerUserId": other.customer._id } },
        );
      if (fault === "missing Booking Customer")
        await BookingModel.collection.updateOne(
          { _id: f.booking._id },
          { $unset: { "customer.customerUserId": 1 } },
        );
      if (fault === "missing Booking client")
        await BookingModel.collection.updateOne(
          { _id: f.booking._id },
          { $unset: { "customer.businessClientId": 1 } },
        );
      if (fault === "contract Customer")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { "financialContract.customerUserId": other.customer._id } },
        );
      if (fault === "contract client")
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $set: { "financialContract.businessClientId": other.client._id } },
        );
      const before = await databaseState();
      await expect(f.call()).rejects.toMatchObject(denied);
      expect(await databaseState()).toBe(before);
    });
    it("A1 foreign bare pending claim rejects before Booking/payment lookup or wait", async () => {
      const f = await setupFixture();
      const { customer: owner } = await createLinkedCustomer(f, "a1-pending-owner");
      const { customer: foreign } = await createLinkedCustomer(f, "a1-pending-foreign");
      const input = normalInput(f);
      await claimRepository.claim({
        idempotencyKey: input.idempotencyKey,
        businessId: f.business._id,
        actorUserId: owner._id,
        bookingId: new Types.ObjectId(),
      });
      const before = await databaseState();
      const read = vi.spyOn(bookingRepository, "findById");
      const attempt = vi.spyOn(paymentService, "findPaymentAttempt");
      await expect(finalizeNormal(f, foreign._id, input)).rejects.toMatchObject(denied);
      expect(read).not.toHaveBeenCalled();
      expect(attempt).not.toHaveBeenCalled();
      expect(await databaseState()).toBe(before);
    });
    it.each([false, true])(
      "A1 awaited result rechecks canonical and Booking ownership; corrupt=%s",
      async (corrupt) => {
        const f = await setupReplay("normal");
        if (corrupt)
          await BookingModel.collection.updateOne(
            { _id: f.booking._id },
            { $set: { "customer.customerUserId": new Types.ObjectId() } },
          );
        const original = bookingRepository.findById.bind(bookingRepository);
        vi.spyOn(bookingRepository, "findById")
          .mockImplementationOnce(async () => null)
          .mockImplementation(original);
        vi.spyOn(paymentService, "findPaymentAttempt").mockResolvedValue(null);
        const read = vi.spyOn(claimRepository, "findForCustomerReplay");
        const before = await databaseState();
        if (corrupt) await expect(f.call()).rejects.toMatchObject(denied);
        else expect(String(confirmed(await f.call())._id)).toBe(String(f.booking._id));
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(await databaseState()).toBe(before);
      },
    );
    it.each(["actor", "Booking ID", "removed"])(
      "A1 awaited result rejects a canonical claim changed at the read boundary: %s",
      async (fault) => {
        const f = await setupReplay("normal");
        const original = bookingRepository.findById.bind(bookingRepository);
        // Force the pending-result boundary using real stored rows, then alter only
        // this owned disposable claim before the next canonical read.
        vi.spyOn(bookingRepository, "findById")
          .mockImplementationOnce(async () => {
            const filter = { idempotencyKey: f.input.idempotencyKey };
            if (fault === "removed") await BookingCreationClaimModel.collection.deleteOne(filter);
            else
              await BookingCreationClaimModel.collection.updateOne(filter, {
                $set:
                  fault === "actor"
                    ? { actorUserId: new Types.ObjectId() }
                    : { bookingId: new Types.ObjectId() },
              });
            return null;
          })
          .mockImplementation(original);
        vi.spyOn(paymentService, "findPaymentAttempt").mockResolvedValue(null);
        await expect(f.call()).rejects.toMatchObject(
          fault === "removed"
            ? { statusCode: 503, details: [{ code: "BOOKING_TRANSACTION_UNAVAILABLE" }] }
            : denied,
        );
        expect(await BookingModel.countDocuments({ _id: f.booking._id })).toBe(1);
        expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
      },
    );
    it.each(["normal", "purchase"] as const)(
      "A1 historical %s replay without a FinancialContract uses owned stored Booking evidence",
      async (kind) => {
        const f = await setupReplay(kind);
        // Simulate pre-contract history without manufacturing new runtime authority.
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: f.input.idempotencyKey },
          { $unset: { financialContract: 1 } },
        );
        await BookingModel.collection.updateOne(
          { _id: f.booking._id },
          { $unset: { financialContract: 1 } },
        );
        const before = await databaseState();
        expect(String(confirmed(await f.call())._id)).toBe(String(f.booking._id));
        const wrong =
          kind === "normal"
            ? finalizePackage(f.f, f.customer._id, {
                ...packageInput(f.f),
                idempotencyKey: f.input.idempotencyKey,
              })
            : finalizeNormal(f.f, f.customer._id, {
                ...normalInput(f.f),
                idempotencyKey: f.input.idempotencyKey,
              });
        await expect(wrong).rejects.toMatchObject(denied);
        expect(await databaseState()).toBe(before);
      },
    );
    it("A1 late claim collision cannot return mismatched Booking Customer", async () => {
      const f = await setupReplay("normal");
      await BookingModel.collection.updateOne(
        { _id: f.booking._id },
        { $set: { "customer.customerUserId": new Types.ObjectId() } },
      );
      vi.spyOn(claimRepository, "findForCustomerReplay").mockResolvedValueOnce(null);
      const before = await databaseState();
      await expect(f.call()).rejects.toMatchObject(denied);
      expect(await databaseState()).toBe(before);
    });
    it("A1 own bare pending claim with no kind waits boundedly without financial side effects", async () => {
      const f = await setupFixture();
      const { customer } = await createLinkedCustomer(f, "a1-own-pending");
      const input = normalInput(f);
      await claimRepository.claim({
        idempotencyKey: input.idempotencyKey,
        businessId: f.business._id,
        actorUserId: customer._id,
        bookingId: new Types.ObjectId(),
      });
      const before = await databaseState();
      await expect(finalizeNormal(f, customer._id, input)).rejects.toMatchObject({
        statusCode: 503,
        details: [{ code: "BOOKING_TRANSACTION_UNAVAILABLE" }],
      });
      expect(await databaseState()).toBe(before);
    });
  });

  it("B3 actual Customer Group creators and joiners cancel only their own contribution", async () => {
    const f = await setupFixture();
    const group = await serviceRepository.create({
      businessId: f.business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Fitness",
      name: "B3 group",
      pricingMode: "PER_PERSON",
      perPersonPricing: {
        ratePerPersonCents: 1000,
        minPersons: 1,
        maxPersons: 5,
        durationMin: 60,
        bookingIntervalMin: 60,
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [f.staffId],
    });
    const a = await createLinkedCustomer(f, "b3-creator");
    const b = await createLinkedCustomer(f, "b3-joiner");
    const request = (partySize: number) => ({
      ...normalInput(f),
      serviceLines: [
        {
          serviceId: String(group._id),
          staffMembershipId: String(f.staffId),
          addonIds: [],
          pricingInput: { personCount: partySize },
        },
      ],
    });
    const first = confirmed(
      await creationService.finalizeCustomerBooking(
        String(a.customer._id),
        String(f.business._id),
        request(1),
      ),
    );
    const joined = confirmed(
      await creationService.finalizeCustomerBooking(
        String(b.customer._id),
        String(f.business._id),
        request(2),
      ),
    );
    const firstLine = first.serviceLines[0];
    const joinLine = joined.serviceLines[0];
    if (!firstLine?.reservationOperationKey || !joinLine?.reservationOperationKey)
      throw new Error("Real Booking operations required");
    expect(String(firstLine.reservationId)).toBe(String(joinLine.reservationId));
    expect(firstLine.reservationOperationKey).toBeDefined();
    expect(joinLine.reservationOperationKey).not.toBe(firstLine.reservationOperationKey);
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed).toBe(
      3,
    );
    await lifecycleService.cancelByCustomer(String(a.customer._id), String(first._id), undefined);
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed).toBe(
      2,
    );
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: firstLine.reservationOperationKey,
        }).orFail()
      ).effect?.state,
    ).toBe("RELEASED");
    await expect(
      lifecycleService.cancelByCustomer(String(a.customer._id), String(first._id), undefined),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed).toBe(
      2,
    );
    await lifecycleService.cancelByCustomer(String(b.customer._id), String(joined._id), undefined);
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals).toHaveLength(0);
    expect(
      await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "RELEASED" }),
    ).toBe(2);
  });
});
