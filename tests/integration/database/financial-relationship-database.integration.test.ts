import { Types } from "mongoose";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { CyprusTaxService } from "../../../src/modules/payment/tax.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
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
    claimRepository = new BookingCreationClaimRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
    packageProgressRepository = new PackageProgressRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
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
      expect(attempt.financialContractVersion).toBe(2);
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
        version: 2,
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
        financialContractVersion: 2,
      });
      const metadata = paymentGateway.paymentIntentInputs[0]?.metadata ?? {};
      expect(metadata).toMatchObject({
        financialContractVersion: "2",
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
      await PaymentAttemptModel.collection.updateOne(
        { _id: attempt._id },
        { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } },
      );

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

  // --- RETURNING stays pre-P3 --------------------------------------------------------------------

  describe("RETURNING keeps current (pre-P3) payment behaviour", () => {
    it("normal and package RETURNING still charge a real DEPOSIT online (never €0) and never mutate the relationship", async () => {
      const fixture = await setupFixture({ bundlePriceCents: 10_000 });
      const addon = await createAddon(fixture, fixture.packageService._id, 4_000);
      const { customer, client } = await createLinkedCustomer(fixture, "returning");
      confirmed(await finalizeNormal(fixture, customer._id, normalInput(fixture, "09:00")));
      const consumed = await relationshipOf(client._id);

      const normal = confirmed(
        await finalizeNormal(fixture, customer._id, normalInput(fixture, "11:00")),
      );
      expect(normal.financials).toMatchObject({ depositCents: 2_000, platformFeeCents: 0 });
      expect(normal.financialContract).toMatchObject({
        classification: "RETURNING",
        upfrontLedgerType: "DEPOSIT",
        onlineChargeCents: 2_000,
      });
      expect(paymentGateway.paymentIntentInputs.at(-1)).toMatchObject({ amountCents: 2_000 });
      expect(
        paymentGateway.paymentIntentInputs.at(-1)?.metadata["relationshipClassification"],
      ).toBe("RETURNING");
      expect((await ledgerFor(normal._id)).map((entry) => entry.type)).toEqual(["DEPOSIT"]);

      // Package RETURNING keeps the legacy deposit on bundle + add-ons (20% of €140 = €28).
      const pkg = confirmed(
        await finalizePackage(
          fixture,
          customer._id,
          packageInput(fixture, "14:00", { addonIds: [String(addon._id)] }),
        ),
      );
      expect(pkg.financials).toMatchObject({ depositCents: 2_800, platformFeeCents: 0 });
      expect(pkg.financialContract).toMatchObject({
        classification: "RETURNING",
        eligibleBasisCents: 14_000,
        upfrontLedgerType: "DEPOSIT",
      });
      expect(paymentGateway.paymentIntentInputs.at(-1)).toMatchObject({ amountCents: 2_800 });
      expect((await ledgerFor(pkg._id)).map((entry) => entry.type)).toEqual(["DEPOSIT"]);

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
    it("business cancellation of a consumed FIRST booking refunds via P0 but does NOT restore ELIGIBLE (P4)", async () => {
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
      expect(after.financialRelationship).toEqual(before.financialRelationship);
      expect(after.financialRelationship?.state).toBe("CONSUMED");
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
});
