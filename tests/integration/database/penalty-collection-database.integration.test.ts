import { Types } from "mongoose";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { toBookingDetailDto } from "../../../src/modules/booking/booking.dto.js";
import { type BookingDocument, BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import { NoShowResolutionService } from "../../../src/modules/booking/no-show-resolution.service.js";
import {
  computeNoShowPenalty,
  PenaltyCollectionService,
} from "../../../src/modules/booking/penalty-collection.service.js";
import {
  type BookingFinancialTransactionDocument,
  BookingFinancialTransactionModel,
} from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
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
import { createFinancialRelationshipService } from "../../../src/modules/client/financial-relationship.factory.js";
import { renderEmailTemplate } from "../../../src/modules/email/template-registry.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { BookingCancelledNotifier } from "../../../src/modules/notification/booking-cancelled.notifier.js";
import { NoShowNotifier } from "../../../src/modules/notification/no-show.notifier.js";
import { PenaltySettlementNotifier } from "../../../src/modules/notification/penalty-settlement.notifier.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileModel } from "../../../src/modules/payment/customer-payment-profile.model.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { PaymentTaxAssociationReconciler } from "../../../src/modules/payment/payment-tax-association-reconciler.js";
import { penaltyAttemptKey } from "../../../src/modules/payment/penalty-attempt.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionModel } from "../../../src/modules/promo/promo-redemption.model.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventModel } from "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20";
const OWNER = "BUSINESS_OWNER" as const;

/**
 * P5 — durable customer penalty collection (late-cancellation / no-show shortfall): durable
 * obligation before dispatch, one PaymentAttempt per obligation, UNKNOWN reconciled (never
 * retried), shared convergence across request / worker / webhook / recovery, waiver/reversal
 * gate, no-show claim atomicity + worker fairness, MANUAL / FIRST / promo / package isolation,
 * truthful staged notifications and legacy fail-closed handling.
 */
describe("P5 durable penalty collection", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let noShowService: NoShowResolutionService;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentGateway: FakePaymentGateway;
  let paymentService: PaymentService;
  let attempts: PaymentAttemptRepository;
  let financialTransactionService: BookingFinancialTransactionService;
  let penaltyCollection: PenaltyCollectionService;
  let webhookService: StripeWebhookService;
  let recovery: MoneyRecoveryService;
  let financeService: FinanceService;
  let lifecycleDeps: ConstructorParameters<typeof BookingLifecycleService>;
  let noShowDeps: ConstructorParameters<typeof NoShowResolutionService>;
  let penaltyDeps: ConstructorParameters<typeof PenaltyCollectionService>[0];

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-08-19T08:00:00Z"));
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
    paymentGateway = new FakePaymentGateway();
    attempts = new PaymentAttemptRepository();
    const refunds = new RefundOperationRepository();
    paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
      attempts,
      refunds,
    );
    financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
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
    );
    const packageProgressRepository = new PackageProgressRepository();
    penaltyDeps = {
      paymentService,
      financialTransactionService,
      bookingRepository,
      businessRepository,
      settlementNotifier: new PenaltySettlementNotifier(new EmailOutboxService(), userRepository),
      noShowNotifier: new NoShowNotifier(new EmailOutboxService()),
      packageProgressRepository,
    };
    penaltyCollection = new PenaltyCollectionService(penaltyDeps);
    lifecycleDeps = [
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
      new BookingCancelledNotifier(new EmailOutboxService(), userRepository),
      new NoShowNotifier(new EmailOutboxService()),
      undefined,
      undefined,
      undefined,
      packageProgressRepository,
      undefined,
      undefined,
      penaltyCollection,
    ];
    lifecycleService = new BookingLifecycleService(...lifecycleDeps);
    noShowDeps = [
      bookingRepository,
      businessRepository,
      paymentService,
      financialTransactionService,
      new NoShowNotifier(new EmailOutboxService()),
      packageProgressRepository,
      penaltyCollection,
    ];
    noShowService = new NoShowResolutionService(...noShowDeps);
    const relationshipService = createFinancialRelationshipService({
      paymentAttemptRepository: attempts,
      refundOperationRepository: refunds,
      bookingRepository,
    });
    webhookService = new StripeWebhookService(
      paymentGateway,
      new StripeWebhookEventRepository(),
      financialTransactionService,
      new PaymentTaxAssociationReconciler(paymentGateway, bookingRepository),
      attempts,
      refunds,
      packageProgressRepository,
      bookingRepository,
      relationshipService,
      penaltyCollection,
    );
    recovery = new MoneyRecoveryService(
      paymentService,
      attempts,
      refunds,
      bookingRepository,
      financialTransactionService,
      webhookService,
      packageProgressRepository,
      relationshipService,
      penaltyCollection,
    );
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      new BusinessPayoutRepository(),
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ----------------------------------------------------------------------------

  const setupBusiness = async (opts: { cancellationPct?: number; noShowPct?: number }) => {
    const ownerEmail = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: ownerEmail,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Salon P5",
      ownerName: "Owner Name",
      email: ownerEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
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
    const service = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 10_000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [membership._id],
    });
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(owner._id), String(business._id), [
      ...days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
      { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);
    await staffScheduleRepository.replace(
      membership._id,
      business._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    await cancellationPolicyRepository.replace(
      business._id,
      [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
        opts.cancellationPct !== undefined
          ? { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: opts.cancellationPct }
          : { tier: "UNDER_2_HOURS", mode: "FREE" },
      ],
      // The policy floor is 20%: €20 on a €100 booking, exactly covered by a FIRST PLATFORM_FEE.
      opts.noShowPct ?? 20,
    );
    return { owner, business, membership, service };
  };

  type Ctx = Awaited<ReturnType<typeof setupBusiness>>;

  const createLinkedCustomer = async (ctx: Ctx, withCard = true) => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    if (withCard) {
      const setupIntent = await paymentService.createSetupIntent(String(customer._id));
      await paymentService.confirmSavedPaymentMethod(
        String(customer._id),
        setupIntent.setupIntentId,
      );
    }
    const client = await clientRepository.create({
      businessId: ctx.business._id,
      createdByUserId: ctx.owner._id,
      firstName: "Dana",
      lastName: "Customer",
      normalizedEmail: customer.normalizedEmail,
      phone: (() => {
        const nationalNumber = `9${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
        return { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` };
      })(),
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

  const finalizeInput = (ctx: Ctx, time: string, idempotencyKey?: string) => ({
    serviceLines: [
      {
        serviceId: String(ctx.service._id),
        staffMembershipId: String(ctx.membership._id),
        addonIds: [],
        pricingInput: {},
      },
    ],
    startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
    idempotencyKey: idempotencyKey ?? `key-${new Types.ObjectId().toString()}`,
  });

  const book = async (ctx: Ctx, customerId: Types.ObjectId, time = "10:00") => {
    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
      String(ctx.business._id),
      finalizeInput(ctx, time),
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    return result.booking;
  };

  /** €100 FIRST booking (€20 PLATFORM_FEE retained) by a linked customer with a saved card. */
  const firstBooking = async (opts: { cancellationPct?: number; noShowPct?: number }) => {
    const ctx = await setupBusiness(opts);
    const { customer, client } = await createLinkedCustomer(ctx);
    const booking = await book(ctx, customer._id);
    return { ...ctx, customer, client, booking };
  };

  const makeLate = async (bookingId: Types.ObjectId) => {
    const booking = await BookingModel.findById(bookingId).orFail();
    // Advance the action clock; never contradict the admitted interval or B2 intent.
    vi.setSystemTime(new Date(booking.schedule.startAt.getTime() - 60 * 60 * 1000));
  };

  const markOverdue = async (ctx: Ctx, bookingId: Types.ObjectId) => {
    await lifecycleService.markNoShow(
      String(ctx.owner._id),
      OWNER,
      String(ctx.business._id),
      String(bookingId),
    );
    await BookingModel.updateOne(
      { _id: bookingId },
      { $set: { noShowDeadlineAt: new Date(Date.now() - 1000) } },
    ).exec();
  };

  const cancelLate = async (
    ctx: { customer: { _id: Types.ObjectId } },
    bookingId: Types.ObjectId,
  ) => lifecycleService.cancelByCustomer(String(ctx.customer._id), String(bookingId), "late");

  const rows = (bookingId: Types.ObjectId, type: BookingFinancialTransactionDocument["type"]) =>
    BookingFinancialTransactionModel.find({ bookingId, type }).lean().exec();
  const attemptsFor = (bookingId: Types.ObjectId) =>
    PaymentAttemptModel.find({ bookingId }).lean().exec();
  const freshBooking = async (bookingId: Types.ObjectId) =>
    (await BookingModel.findById(bookingId).lean().exec()) as unknown as BookingDocument;
  const outboxFor = (templateKey: string) => EmailOutboxModel.find({ templateKey }).lean().exec();

  /** Simulates the process dying / a long pause: the attempt is now beyond any in-flight
   * request, so only the strongly consistent recovery may decide it. */
  const backdateAttempts = async (bookingId: Types.ObjectId) => {
    const past = new Date(Date.now() - 60 * 60_000);
    await PaymentAttemptModel.collection.updateMany(
      { bookingId },
      {
        $set: { createdAt: past, updatedAt: past, persistenceLeaseExpiresAt: past },
        $unset: { nextRecoveryAt: "" },
      },
    );
  };

  const piEvent = async (
    type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled",
    paymentIntentId: string,
    metadataOverride: Record<string, string> = {},
  ): Promise<Stripe.Event> => {
    const snapshot = await paymentGateway.retrievePaymentIntent(paymentIntentId);
    return {
      id: `evt_${new Types.ObjectId().toString()}`,
      type,
      data: {
        object: {
          id: paymentIntentId,
          amount: snapshot.amountCents,
          currency: snapshot.currency.toLowerCase(),
          customer: snapshot.customerId,
          metadata: { ...snapshot.metadata, ...metadataOverride },
          cancellation_reason: type === "payment_intent.canceled" ? "abandoned" : null,
        },
      },
    } as unknown as Stripe.Event;
  };

  /** A lifecycle whose post-commit collection never runs — the process "died" right after the
   * cancellation transaction committed. */
  const crashAfterCommitLifecycle = () => {
    const crashing = Object.create(penaltyCollection) as PenaltyCollectionService;
    crashing.collect = async () => "UNRESOLVED";
    const deps = [...lifecycleDeps] as typeof lifecycleDeps;
    deps[19] = crashing;
    return new BookingLifecycleService(...deps);
  };

  /** A penalty service whose FIRST convergence transaction fails (e.g. DB outage after the
   * provider already succeeded) — every later call behaves normally. */
  const failingFirstConvergence = (target: "ledger" | "booking") => {
    let failed = false;
    const ledger = Object.create(financialTransactionService) as BookingFinancialTransactionService;
    const bookings = Object.create(bookingRepository) as BookingRepository;
    if (target === "ledger") {
      ledger.settlePenaltyObligation = async (...args) => {
        if (!failed) {
          failed = true;
          throw new Error("ledger write failed (test)");
        }
        return financialTransactionService.settlePenaltyObligation(...args);
      };
    } else {
      bookings.settleCancellationPenalty = async (...args) => {
        if (!failed) {
          failed = true;
          throw new Error("booking write failed (test)");
        }
        return bookingRepository.settleCancellationPenalty(...args);
      };
    }
    return new PenaltyCollectionService({
      ...penaltyDeps,
      financialTransactionService: ledger,
      bookingRepository: bookings,
    });
  };

  const lifecycleWith = (collection: PenaltyCollectionService) => {
    const deps = [...lifecycleDeps] as typeof lifecycleDeps;
    deps[19] = collection;
    return new BookingLifecycleService(...deps);
  };

  const noShowWith = (collection: PenaltyCollectionService) => {
    const deps = [...noShowDeps] as typeof noShowDeps;
    deps[6] = collection;
    return new NoShowResolutionService(...deps);
  };

  const claimOnly = async (bookingId: Types.ObjectId) => {
    const booking = await freshBooking(bookingId);
    const upfront = await financialTransactionService.findSucceededUpfrontPayment(bookingId);
    return penaltyCollection.claimNoShowPenalty(
      (await bookingRepository.findByIdOnly(bookingId)) ?? booking,
      computeNoShowPenalty(booking, upfront?.amountCents ?? 0),
    );
  };

  const waive = (ctx: Ctx, bookingId: Types.ObjectId) =>
    lifecycleService.waiveFee(
      String(ctx.owner._id),
      OWNER,
      String(ctx.business._id),
      String(bookingId),
      "Goodwill",
      undefined,
    );

  const reverse = (ctx: Ctx, bookingId: Types.ObjectId) =>
    lifecycleService.cancelNoShowByBusiness(
      String(ctx.owner._id),
      OWNER,
      String(ctx.business._id),
      String(bookingId),
    );

  const rejectsWith = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({
      statusCode: 409,
      details: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  };

  // ==========================================================================================
  // CUSTOMER CANCELLATION
  // ==========================================================================================

  describe("customer late cancellation", () => {
    it("1 FIRST fee fully covered by the retained PLATFORM_FEE: no obligation, no attempt, no provider call", async () => {
      const ctx = await firstBooking({ cancellationPct: 20 }); // €20 fee == €20 retained
      await makeLate(ctx.booking._id);
      const piBefore = paymentGateway.createdPaymentIntentIds().length;

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome).toMatchObject({
        cancellationFeeCents: 2000,
        depositAppliedCents: 2000,
        additionalChargeCents: 0,
        settlementStatus: "NOT_APPLICABLE",
      });
      expect(await rows(ctx.booking._id, "CANCELLATION_FEE")).toHaveLength(0);
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "CANCELLATION_FEE"),
      ).toHaveLength(0);
      expect(paymentGateway.createdPaymentIntentIds()).toHaveLength(piBefore);
    });

    it("2/48/50/54/55/71/73 FIRST partial shortfall: one exact obligation, one server-keyed attempt, one PaymentIntent", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 }); // €50 gross − €20 = €30
      await makeLate(ctx.booking._id);

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome).toMatchObject({
        cancellationFeeCents: 5000,
        depositAppliedCents: 2000,
        additionalChargeCents: 3000,
        settlementStatus: "SUCCEEDED",
      });
      const [obligation, ...extra] = await rows(ctx.booking._id, "CANCELLATION_FEE");
      expect(extra).toHaveLength(0);
      expect(obligation).toMatchObject({
        idempotencyKey: `cancellation-fee:${String(ctx.booking._id)}`,
        status: "SUCCEEDED",
        amountCents: 3000,
        currency: "EUR",
        direction: "DEBIT",
      });
      const penaltyAttempts = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(penaltyAttempts).toHaveLength(1);
      const attempt = penaltyAttempts[0];
      expect(attempt?.logicalIdempotencyKey).toBe(
        penaltyAttemptKey(obligation?._id as Types.ObjectId),
      );
      expect(attempt?.relationshipClassification).toBeUndefined();
      expect(attempt?.financialContractVersion).toBeUndefined();
      expect(attempt?.productKind).toBeUndefined();
      expect(attempt).toMatchObject({
        providerStatus: "SUCCEEDED",
        persistenceStatus: "COMPLETED",
        expectedAmountCents: 3000,
      });
      expect(obligation?.providerReference).toBe(attempt?.providerPaymentIntentId);
      expect(cancelled.cancellationOutcome?.settlementProviderReference).toBe(
        attempt?.providerPaymentIntentId,
      );
      const penaltyInputs = paymentGateway.paymentIntentInputs.filter(
        (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
      );
      expect(penaltyInputs).toHaveLength(1);
      expect(penaltyInputs[0]).toMatchObject({
        amountCents: 3000,
        currency: "eur",
        offSession: true,
        saveForFutureUse: false,
        idempotencyKey: `payment-attempt:${String(attempt?._id)}`,
      });
      expect(penaltyInputs[0]?.metadata).toMatchObject({
        booklyPaymentAttemptId: String(attempt?._id),
        booklyPenaltyObligationId: String(obligation?._id),
        taxMode: "PRE_ACTIVATION",
        taxCents: "0",
      });
      expect(penaltyInputs[0]?.metadata["booklyPaymentMethodId"]).toMatch(/^pm_fake_/);
    });

    it("3 RETURNING P3 (€0 upfront): the full gross fee is the shortfall", async () => {
      const ctx = await setupBusiness({ cancellationPct: 50 });
      const { customer } = await createLinkedCustomer(ctx);
      await book(ctx, customer._id, "10:00");
      const returning = await book(ctx, customer._id, "11:00");
      expect(
        await financialTransactionService.findSucceededUpfrontPayment(returning._id),
      ).toBeUndefined();
      await makeLate(returning._id);

      const cancelled = await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(returning._id),
        "late",
      );

      expect(cancelled.cancellationOutcome).toMatchObject({
        cancellationFeeCents: 5000,
        depositAppliedCents: 0,
        additionalChargeCents: 5000,
        settlementStatus: "SUCCEEDED",
      });
      expect((await rows(returning._id, "CANCELLATION_FEE"))[0]).toMatchObject({
        amountCents: 5000,
        status: "SUCCEEDED",
      });
    });

    it("4 zero fee (FREE tier): no obligation, no attempt", async () => {
      const ctx = await firstBooking({});
      await makeLate(ctx.booking._id);
      const cancelled = await cancelLate(ctx, ctx.booking._id);
      expect(cancelled.status).toBe("CANCELLED_BY_CUSTOMER");
      expect(await rows(ctx.booking._id, "CANCELLATION_FEE")).toHaveLength(0);
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "CANCELLATION_FEE"),
      ).toHaveLength(0);
    });

    it("5 [race] duplicate cancellation: one obligation, one attempt, one provider PaymentIntent", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);

      const results = await Promise.allSettled([
        cancelLate(ctx, ctx.booking._id),
        cancelLate(ctx, ctx.booking._id),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await rows(ctx.booking._id, "CANCELLATION_FEE")).toHaveLength(1);
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "CANCELLATION_FEE"),
      ).toHaveLength(1);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
    });

    it("6/17/64/65/70/94/95 crash after commit, before dispatch: obligation + pending email survive; waive blocked; recovery proves absence -> FAILED with no PaymentIntent", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);

      const cancelled = await crashAfterCommitLifecycle().cancelByCustomer(
        String(ctx.customer._id),
        String(ctx.booking._id),
        "late",
      );

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("PENDING");
      const [obligation] = await rows(ctx.booking._id, "CANCELLATION_FEE");
      expect(obligation).toMatchObject({ status: "PENDING", amountCents: 3000 });
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(attempt?.providerStatus).toBe("NOT_CREATED");
      // 94/95 — the durable "booking cancelled, fee collection pending" email committed with it.
      const pending = await outboxFor("BOOKING_CANCELLED_CUSTOMER");
      expect(pending).toHaveLength(1);
      const text = renderEmailTemplate("BOOKING_CANCELLED_CUSTOMER", pending[0]?.payload).text;
      expect(text).toContain("Additional amount due: €30.00 — fee collection pending.");
      expect(text).not.toContain("Additional amount charged");
      expect(await outboxFor("BOOKING_CANCELLED_OWNER")).toHaveLength(1);
      // 17 — waive is blocked while the obligation is PENDING.
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");

      // A fresh (in-flight) attempt is never decided by recovery.
      await recovery.runOnce();
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("PENDING");

      await backdateAttempts(ctx.booking._id);
      const piCountBefore = paymentGateway.createdPaymentIntentIds().length;
      await recovery.runOnce();

      const closed = await PaymentAttemptModel.findById(attempt?._id).lean().exec();
      expect(closed).toMatchObject({
        providerStatus: "FAILED",
        lastErrorCode: "PROVIDER_NOT_CREATED",
      });
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "FAILED",
      );
      expect(paymentGateway.createdPaymentIntentIds()).toHaveLength(piCountBefore);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(0);
      expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(1);
    });

    it("7/8/18/66/69/99/100 provider success with a lost response: UNKNOWN (never FAILED), waive blocked, recovery finds the SAME PaymentIntent", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("PENDING");
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(attempt?.providerStatus).toBe("UNKNOWN");
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("PENDING");
      // 99/100 — nothing claims success or failure while the outcome is unknown.
      expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(0);
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");
      const createdPi = paymentGateway.createdPaymentIntentIds().at(-1);
      // P5 Rule 2 — an UNKNOWN attempt is reconciled, never sent again.
      const source = await paymentService.resolvePenaltyPaymentSource(ctx.customer._id);
      const inputsBefore = paymentGateway.paymentIntentInputs.length;
      const redispatched = await paymentService.dispatchPenaltyAttempt(
        attempt?._id as Types.ObjectId,
        {
          stripeCustomerId: source?.stripeCustomerId as string,
          paymentMethodId: source?.paymentMethodId as string,
          metadata: {},
        },
      );
      expect(redispatched.providerStatus).toBe("UNKNOWN");
      expect(paymentGateway.paymentIntentInputs).toHaveLength(inputsBefore);

      await recovery.runOnce();

      const [obligation] = await rows(ctx.booking._id, "CANCELLATION_FEE");
      expect(obligation).toMatchObject({ status: "SUCCEEDED", providerReference: createdPi });
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "SUCCEEDED",
      );
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
      expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(1);
    });

    it("66 UNKNOWN with lagging search is resolved only by the strongly consistent list after the stale window", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();
      await cancelLate(ctx, ctx.booking._id);
      paymentGateway.searchLagging = true;

      await recovery.runOnce();
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("PENDING");

      await backdateAttempts(ctx.booking._id);
      await recovery.runOnce();
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("SUCCEEDED");
      expect(paymentGateway.createdPaymentIntentIds()).toHaveLength(
        new Set(paymentGateway.createdPaymentIntentIds()).size,
      );
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
    });

    it.each(["ledger", "booking"] as const)(
      "9/10/67/68 provider success but %s convergence write fails: nothing half-settles; recovery settles exactly once",
      async (target) => {
        const ctx = await firstBooking({ cancellationPct: 50 });
        await makeLate(ctx.booking._id);

        const cancelled = await lifecycleWith(failingFirstConvergence(target)).cancelByCustomer(
          String(ctx.customer._id),
          String(ctx.booking._id),
          "late",
        );

        expect(cancelled.cancellationOutcome?.settlementStatus).toBe("PENDING");
        expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("PENDING");
        const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
          (a) => a.purpose === "CANCELLATION_FEE",
        );
        expect(attempt?.providerStatus).toBe("SUCCEEDED");
        expect(attempt?.compensationStatus).toBe("NOT_REQUIRED");
        // 19 — provider success not yet converged still blocks a waiver.
        await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_ALREADY_CHARGED");

        await backdateAttempts(ctx.booking._id); // lease expiry
        await recovery.runOnce();
        await recovery.runOnce();

        const settledRows = await rows(ctx.booking._id, "CANCELLATION_FEE");
        expect(settledRows).toHaveLength(1);
        expect(settledRows[0]).toMatchObject({
          status: "SUCCEEDED",
          providerReference: attempt?.providerPaymentIntentId,
        });
        expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
          "SUCCEEDED",
        );
        expect(await PaymentAttemptModel.findById(attempt?._id).lean().exec()).toMatchObject({
          persistenceStatus: "COMPLETED",
          compensationStatus: "NOT_REQUIRED",
        });
        expect(paymentGateway.refundInputs).toHaveLength(0);
        expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(1);
      },
    );

    it("11/15/16/19/97/98 permanent decline: FAILED, cancellation final, waivable exactly once with the same row", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("FAILED");
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(attempt).toMatchObject({ providerStatus: "FAILED", persistenceStatus: "COMPLETED" });
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
      const failure = await outboxFor("PENALTY_SETTLEMENT_CUSTOMER");
      expect(failure).toHaveLength(1);
      const failureText = renderEmailTemplate(
        "PENALTY_SETTLEMENT_CUSTOMER",
        failure[0]?.payload,
      ).text;
      expect(failureText).toContain("No successful charge has been confirmed");
      expect(failureText).not.toMatch(/has been charged|waived/);
      expect(await outboxFor("PENALTY_SETTLEMENT_OWNER")).toHaveLength(1);

      // no automatic second attempt, ever
      await recovery.runOnce();
      const source = await paymentService.resolvePenaltyPaymentSource(ctx.customer._id);
      await paymentService.dispatchPenaltyAttempt(attempt?._id as Types.ObjectId, {
        stripeCustomerId: source?.stripeCustomerId as string,
        paymentMethodId: source?.paymentMethodId as string,
        metadata: {},
      });
      expect(
        await penaltyCollection.collect(
          (await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?._id as Types.ObjectId,
        ),
      ).toBe("FAILED");
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] !== "BOOKING_DEPOSIT",
        ),
      ).toHaveLength(1);

      const waived = await waive(ctx, ctx.booking._id);
      expect(waived.status).toBe("LATE_CANCELLATION");
      expect(waived.cancellationOutcome?.settlementStatus).toBe("WAIVED");
      const after = await rows(ctx.booking._id, "CANCELLATION_FEE");
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe("WAIVED");
      const waivedMail = (await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).find(
        (row) => (row.payload as { outcome?: string }).outcome === "WAIVED",
      );
      expect(
        renderEmailTemplate("PENALTY_SETTLEMENT_CUSTOMER", waivedMail?.payload).text,
      ).toContain("You will not be charged for it");

      // 16 — a repeated waive never applies twice: the settlement guard refuses it (the repo's
      // existing convention for a sequential repeat) and no second ledger row ever exists.
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_NO_WAIVABLE_FEE");
      expect(await rows(ctx.booking._id, "CANCELLATION_FEE")).toHaveLength(1);
    });

    it("16 [race] concurrent waives of a failed fee: exactly one WAIVED row and one waived settlement", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");
      await cancelLate(ctx, ctx.booking._id);

      const results = await Promise.allSettled([
        waive(ctx, ctx.booking._id),
        waive(ctx, ctx.booking._id),
      ]);

      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const after = await rows(ctx.booking._id, "CANCELLATION_FEE");
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe("WAIVED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "WAIVED",
      );
      expect(
        (await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).filter(
          (row) => (row.payload as { outcome?: string }).outcome === "WAIVED",
        ),
      ).toHaveLength(1);
    });

    it("12 requires_action off-session: definitive FAILED, one PaymentIntent, no second attempt", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("requires_action");

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("FAILED");
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
      await recovery.runOnce();
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
    });

    it("13 missing saved card: definitive FAILED obligation, no attempt, no provider call; cancellation final", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      await CustomerPaymentProfileModel.updateOne(
        { userId: ctx.customer._id },
        { $unset: { defaultPaymentMethodId: "" } },
      ).exec();

      const cancelled = await cancelLate(ctx, ctx.booking._id);

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("FAILED");
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]).toMatchObject({
        status: "FAILED",
        amountCents: 3000,
      });
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "CANCELLATION_FEE"),
      ).toHaveLength(0);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(0);
      const waived = await waive(ctx, ctx.booking._id);
      expect(waived.cancellationOutcome?.settlementStatus).toBe("WAIVED");
    });

    it("14 detached card (rejected before any PaymentIntent): UNKNOWN until strongly proven absent, then FAILED; no dunning", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeThrowBeforeCreate();

      const cancelled = await cancelLate(ctx, ctx.booking._id);
      expect(cancelled.cancellationOutcome?.settlementStatus).toBe("PENDING");

      await backdateAttempts(ctx.booking._id);
      await recovery.runOnce();

      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "FAILED",
      );
      expect(paymentGateway.createdPaymentIntentIds().filter(Boolean)).toHaveLength(
        paymentGateway.paymentIntentInputs.length,
      );
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(0);
    });

    it("19/96 a collected fee can never be waived; success follow-up is truthful", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      await cancelLate(ctx, ctx.booking._id);

      // A settled fee is no longer an outstanding one (existing settlement guard).
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_NO_WAIVABLE_FEE");
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("SUCCEEDED");
      const success = await outboxFor("PENALTY_SETTLEMENT_CUSTOMER");
      expect(success).toHaveLength(1);
      expect(
        renderEmailTemplate("PENALTY_SETTLEMENT_CUSTOMER", success[0]?.payload).text,
      ).toContain("has been charged to your saved card");
      const owner = await outboxFor("PENALTY_SETTLEMENT_OWNER");
      expect(renderEmailTemplate("PENALTY_SETTLEMENT_OWNER", owner[0]?.payload).text).toContain(
        "was charged successfully",
      );
    });

    it("20 a WAIVED settlement/obligation is never overwritten by a stale success or failure path", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");
      await cancelLate(ctx, ctx.booking._id);
      await waive(ctx, ctx.booking._id);
      const [obligation] = await rows(ctx.booking._id, "CANCELLATION_FEE");

      expect(
        await bookingRepository.updateCancellationSettlement(ctx.booking._id, "SUCCEEDED", "pi_x"),
      ).toBeNull();
      expect(
        await bookingRepository.settleCancellationPenalty(ctx.booking._id, "FAILED", undefined),
      ).toBeNull();
      expect(
        await financialTransactionService.settlePenaltyObligation(
          obligation?._id as Types.ObjectId,
          {
            status: "SUCCEEDED",
            providerReference: "pi_x",
          },
        ),
      ).toBeNull();

      // A provider success arriving after the waiver is investigation, never a regression.
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      paymentGateway.setPaymentIntentStatus(
        attempt?.providerPaymentIntentId as string,
        "succeeded",
      );
      await webhookService.process(
        await piEvent("payment_intent.succeeded", attempt?.providerPaymentIntentId as string),
      );
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("WAIVED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "WAIVED",
      );
      expect(await StripeWebhookEventModel.countDocuments({ status: "FAILED" })).toBe(1);
    });
  });

  // ==========================================================================================
  // NO-SHOW
  // ==========================================================================================

  describe("no-show", () => {
    it("21 FIRST fully covered by the retained PLATFORM_FEE: waived, no obligation, no attempt", async () => {
      const ctx = await firstBooking({ noShowPct: 20 }); // €20 gross == €20 retained
      await markOverdue(ctx, ctx.booking._id);
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("waived_no_charge_possible");
      expect(await rows(ctx.booking._id, "NO_SHOW_FEE")).toHaveLength(0);
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "NO_SHOW_FEE"),
      ).toHaveLength(0);
    });

    it("22/29/32/51/72/102 FIRST partial shortfall: atomic claim + marker, NO_SHOW_CHARGED, exact PI, charged email", async () => {
      const ctx = await firstBooking({ noShowPct: 80 }); // €80 − €20 = €60
      await markOverdue(ctx, ctx.booking._id);

      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charged");

      const booking = await freshBooking(ctx.booking._id);
      expect(booking.status).toBe("NO_SHOW_CHARGED");
      expect(booking.noShowChargeClaimedAt).toBeInstanceOf(Date);
      const [obligation, ...extra] = await rows(ctx.booking._id, "NO_SHOW_FEE");
      expect(extra).toHaveLength(0);
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "NO_SHOW_FEE",
      );
      expect(obligation).toMatchObject({
        status: "SUCCEEDED",
        amountCents: 6000,
        providerReference: attempt?.providerPaymentIntentId,
      });
      expect(attempt?.relationshipClassification).toBeUndefined();
      expect(attempt?.logicalIdempotencyKey).toBe(
        penaltyAttemptKey(obligation?._id as Types.ObjectId),
      );
      const charged = await outboxFor("NO_SHOW_CHARGED");
      expect(charged).toHaveLength(1);
      expect(renderEmailTemplate("NO_SHOW_CHARGED", charged[0]?.payload).text).toContain("€60.00");
    });

    it("23 RETURNING P3: the full gross no-show fee is charged", async () => {
      const ctx = await setupBusiness({ noShowPct: 80 });
      const { customer } = await createLinkedCustomer(ctx);
      await book(ctx, customer._id, "10:00");
      const returning = await book(ctx, customer._id, "11:00");
      await markOverdue(ctx, returning._id);

      expect(await noShowService.autoResolve(returning._id)).toBe("charged");
      expect((await rows(returning._id, "NO_SHOW_FEE"))[0]).toMatchObject({
        amountCents: 8000,
        status: "SUCCEEDED",
      });
    });

    it("25/92/93 MANUAL booking with a linked customer and saved card: never auto-charged", async () => {
      const ctx = await setupBusiness({ noShowPct: 80 });
      const { client } = await createLinkedCustomer(ctx);
      const manual = await creationService.createManualBooking(
        String(ctx.owner._id),
        OWNER,
        String(ctx.business._id),
        {
          businessClientId: String(client._id),
          serviceLines: finalizeInput(ctx, "10:00").serviceLines,
          startAt: finalizeInput(ctx, "10:00").startAt,
          idempotencyKey: `manual-${new Types.ObjectId().toString()}`,
        } as never,
      );
      expect(manual.customer.customerUserId).toBeDefined();
      await markOverdue(ctx, manual._id);

      expect(await noShowService.autoResolve(manual._id)).toBe("waived_no_charge_possible");
      expect((await freshBooking(manual._id)).status).toBe("NO_SHOW_WAIVED");
      expect(await rows(manual._id, "NO_SHOW_FEE")).toHaveLength(0);
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(0);
    });

    it("26/27/28 [race] two workers: one claim, one attempt, one PaymentIntent", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);

      const outcomes = await Promise.all([
        noShowService.autoResolve(ctx.booking._id),
        noShowService.autoResolve(ctx.booking._id),
      ]);

      expect(outcomes.filter((o) => o === "charged")).toHaveLength(1);
      expect(await rows(ctx.booking._id, "NO_SHOW_FEE")).toHaveLength(1);
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "NO_SHOW_FEE"),
      ).toHaveLength(1);
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(1);
    });

    it("30/35/39/43 crash after claim, before dispatch: excluded from the worker; waive/reversal blocked; recovery -> FAILED, booking stays PENDING", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      const claim = await claimOnly(ctx.booking._id);
      expect(claim?.attempt?.providerStatus).toBe("NOT_CREATED");
      const markedAt = (await freshBooking(ctx.booking._id)).noShowChargeClaimedAt;
      expect(markedAt).toBeInstanceOf(Date);
      // A second claim on an already-claimed booking is refused atomically and re-stamps nothing.
      expect(await claimOnly(ctx.booking._id)).toBeNull();
      expect((await freshBooking(ctx.booking._id)).noShowChargeClaimedAt).toEqual(markedAt);

      expect(await bookingRepository.findManyOverdueNoShows(new Date(), 50)).toHaveLength(0);
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("skipped_already_resolved");
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");
      await rejectsWith(reverse(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");

      await backdateAttempts(ctx.booking._id);
      await recovery.runOnce();

      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("FAILED");
      const booking = await freshBooking(ctx.booking._id);
      expect(booking.status).toBe("PENDING");
      expect(booking.noShowChargeClaimedAt).toBeInstanceOf(Date);
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(0);
    });

    it("31/40/44 timeout after provider success: charge_pending, waive/reversal blocked, recovery -> NO_SHOW_CHARGED with the same PI", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();

      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charge_pending");
      expect((await freshBooking(ctx.booking._id)).status).toBe("PENDING");
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");
      await rejectsWith(reverse(ctx, ctx.booking._id), "BOOKING_FEE_CHARGE_IN_PROGRESS");
      const createdPi = paymentGateway.createdPaymentIntentIds().at(-1);

      await recovery.runOnce();

      expect((await freshBooking(ctx.booking._id)).status).toBe("NO_SHOW_CHARGED");
      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]).toMatchObject({
        status: "SUCCEEDED",
        providerReference: createdPi,
      });
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(1);
    });

    it("33/34/41/101 definitive failure: booking stays PENDING, never re-charged, manual-resolution email, waivable", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");

      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charge_failed");
      expect((await freshBooking(ctx.booking._id)).status).toBe("PENDING");
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("skipped_already_resolved");
      await noShowService.runOnce(50);
      await recovery.runOnce();
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(1);

      const customerMail = await outboxFor("PENALTY_SETTLEMENT_CUSTOMER");
      const customerText = renderEmailTemplate(
        "PENALTY_SETTLEMENT_CUSTOMER",
        customerMail[0]?.payload,
      ).text;
      expect(customerText).toContain("awaiting review");
      expect(customerText).not.toMatch(/has been charged|has waived/);
      const ownerText = renderEmailTemplate(
        "PENALTY_SETTLEMENT_OWNER",
        (await outboxFor("PENALTY_SETTLEMENT_OWNER"))[0]?.payload,
      ).text;
      expect(ownerText).toContain("waive the fee or cancel the no-show");
      expect(await outboxFor("NO_SHOW_CHARGED")).toHaveLength(0);

      const waived = await waive(ctx, ctx.booking._id);
      expect(waived.status).toBe("NO_SHOW_WAIVED");
      const after = await rows(ctx.booking._id, "NO_SHOW_FEE");
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe("WAIVED");
    });

    it("36 [fairness] claimed stuck no-shows no longer starve newer overdue ones", async () => {
      const ctx = await setupBusiness({ noShowPct: 80 });
      const stuck: Types.ObjectId[] = [];
      for (const time of ["09:00", "10:00"]) {
        const { customer } = await createLinkedCustomer(ctx);
        const booking = await book(ctx, customer._id, time);
        await markOverdue(ctx, booking._id);
        paymentGateway.queueNextChargeOutcome("failed");
        expect(await noShowService.autoResolve(booking._id)).toBe("charge_failed");
        stuck.push(booking._id);
      }
      await BookingModel.updateMany(
        { _id: { $in: stuck } },
        { $set: { noShowDeadlineAt: new Date(Date.now() - 24 * 60 * 60_000) } },
      ).exec();
      const { customer } = await createLinkedCustomer(ctx);
      const fresh = await book(ctx, customer._id, "11:00");
      await markOverdue(ctx, fresh._id);

      const counts = await noShowService.runOnce(1);

      expect(counts.charged).toBe(1);
      expect((await freshBooking(fresh._id)).status).toBe("NO_SHOW_CHARGED");
    });

    it("37 one worker item throws: the rest of the batch still runs", async () => {
      const ctx = await setupBusiness({ noShowPct: 80 });
      const ids: Types.ObjectId[] = [];
      for (const time of ["09:00", "10:00"]) {
        const { customer } = await createLinkedCustomer(ctx);
        const booking = await book(ctx, customer._id, time);
        await markOverdue(ctx, booking._id);
        ids.push(booking._id);
      }
      const original = noShowService.autoResolve.bind(noShowService);
      const spy = vi
        .spyOn(noShowService, "autoResolve")
        .mockImplementationOnce(async () => {
          throw new Error("item exploded (test)");
        })
        .mockImplementation(original);

      const counts = await noShowService.runOnce(50);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(counts.error).toBe(1);
      expect(counts.charged).toBe(1);
    });

    it("38/42/47 waive or reversal before any claim: no charge, ever", async () => {
      for (const action of ["waive", "reverse"] as const) {
        const ctx = await firstBooking({ noShowPct: 80 });
        await markOverdue(ctx, ctx.booking._id);
        const resolved =
          action === "waive"
            ? await waive(ctx, ctx.booking._id)
            : await reverse(ctx, ctx.booking._id);
        expect(resolved.status).toBe(action === "waive" ? "NO_SHOW_WAIVED" : "NO_SHOW_CANCELLED");
        expect(await noShowService.autoResolve(ctx.booking._id)).toBe("skipped_already_resolved");
      }
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(0);
    });

    it("47 [race] a worker holding a stale PENDING read cannot claim after a committed reversal", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      const staleRead = await bookingRepository.findByIdOnly(ctx.booking._id);
      await reverse(ctx, ctx.booking._id);

      const claim = await penaltyCollection.claimNoShowPenalty(
        staleRead as BookingDocument,
        computeNoShowPenalty(staleRead as BookingDocument, 2000),
      );

      expect(claim).toBeNull();
      expect(await rows(ctx.booking._id, "NO_SHOW_FEE")).toHaveLength(0);
      expect((await freshBooking(ctx.booking._id)).status).toBe("NO_SHOW_CANCELLED");
    });

    it("45 reversal after provider SUCCEEDED (convergence pending) or after full collection: refused, no refund", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      expect(await noShowWith(failingFirstConvergence("ledger")).autoResolve(ctx.booking._id)).toBe(
        "charge_pending",
      );
      expect((await freshBooking(ctx.booking._id)).status).toBe("PENDING");

      await rejectsWith(reverse(ctx, ctx.booking._id), "BOOKING_NO_SHOW_FEE_ALREADY_CHARGED");
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_ALREADY_CHARGED");

      await backdateAttempts(ctx.booking._id);
      await recovery.runOnce();
      expect((await freshBooking(ctx.booking._id)).status).toBe("NO_SHOW_CHARGED");
      await expect(reverse(ctx, ctx.booking._id)).rejects.toMatchObject({ statusCode: 409 });
      expect(paymentGateway.refundInputs).toHaveLength(0);
    });

    it("46/103 reversal after a definitive failure is allowed and never claims fee success", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");
      await noShowService.autoResolve(ctx.booking._id);

      const reversed = await reverse(ctx, ctx.booking._id);

      expect(reversed.status).toBe("NO_SHOW_CANCELLED");
      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("FAILED");
      expect(await outboxFor("NO_SHOW_CHARGED")).toHaveLength(0);
      expect(
        (await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).filter(
          (row) => (row.payload as { outcome?: string }).outcome === "SUCCEEDED",
        ),
      ).toHaveLength(0);
    });

    it("missing card at claim: definitive FAILED, no attempt, failure email, booking PENDING", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      await CustomerPaymentProfileModel.updateOne(
        { userId: ctx.customer._id },
        { $unset: { defaultPaymentMethodId: "" } },
      ).exec();

      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charge_failed");
      expect((await freshBooking(ctx.booking._id)).status).toBe("PENDING");
      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("FAILED");
      expect(
        (await attemptsFor(ctx.booking._id)).filter((a) => a.purpose === "NO_SHOW_FEE"),
      ).toHaveLength(0);
      expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(1);
    });
  });

  // ==========================================================================================
  // PAYMENTATTEMPT / WEBHOOK / RECOVERY
  // ==========================================================================================

  describe("PaymentAttempt reuse, webhook and recovery", () => {
    it("49 a client-supplied checkout key can never occupy the penalty namespace (and vice versa)", async () => {
      const base = {
        customerUserId: new Types.ObjectId(),
        currency: "EUR",
        expectedAmountCents: 1000,
        providerCustomerId: "cus_x",
      };
      await expect(
        attempts.createOrResumeWithDisposition({
          ...base,
          logicalIdempotencyKey: penaltyAttemptKey(new Types.ObjectId()),
          purpose: "BOOKING_DEPOSIT",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        attempts.createOrResumeWithDisposition({
          ...base,
          logicalIdempotencyKey: `cancellation-fee:${new Types.ObjectId().toString()}`,
          purpose: "CANCELLATION_FEE",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      // End to end: a FIRST checkout using a penalty-shaped key is refused before any charge.
      const ctx = await setupBusiness({ cancellationPct: 50 });
      const { customer } = await createLinkedCustomer(ctx);
      await expect(
        creationService.finalizeCustomerBooking(
          String(customer._id),
          String(ctx.business._id),
          finalizeInput(ctx, "10:00", penaltyAttemptKey(new Types.ObjectId())),
        ),
      ).rejects.toBeDefined();
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
    });

    it("52/53 penalty attempts are invisible to FIRST stale recovery and never take the compensation path", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      await crashAfterCommitLifecycle().cancelByCustomer(
        String(ctx.customer._id),
        String(ctx.booking._id),
        "late",
      );
      await backdateAttempts(ctx.booking._id);
      const staleBefore = new Date();
      const penaltyIds = (await attemptsFor(ctx.booking._id))
        .filter((a) => a.purpose === "CANCELLATION_FEE")
        .map((a) => String(a._id));
      const firstUnsent = (await attempts.listStaleFirstUnsent(50, staleBefore)).map((a) =>
        String(a._id),
      );
      const firstAction = (await attempts.listStaleFirstRequiresAction(50, staleBefore)).map((a) =>
        String(a._id),
      );
      expect(firstUnsent.some((id) => penaltyIds.includes(id))).toBe(false);
      expect(firstAction.some((id) => penaltyIds.includes(id))).toBe(false);

      // Success recorded but its booking vanished: never compensation-refunded.
      const ctx2 = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx2.booking._id);
      await lifecycleWith(failingFirstConvergence("ledger")).cancelByCustomer(
        String(ctx2.customer._id),
        String(ctx2.booking._id),
        "late",
      );
      await BookingModel.deleteOne({ _id: ctx2.booking._id }).exec();
      await backdateAttempts(ctx2.booking._id);
      await recovery.runOnce();
      const [orphan] = (await attemptsFor(ctx2.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(orphan?.compensationStatus).toBe("NOT_REQUIRED");
      expect(paymentGateway.refundInputs).toHaveLength(0);
    });

    it("56/79 cancellation success webhook converges (request never saw the outcome) and records one processing fee", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();
      await cancelLate(ctx, ctx.booking._id);
      const pi = paymentGateway.createdPaymentIntentIds().at(-1) as string;

      const event = await piEvent("payment_intent.succeeded", pi);
      await webhookService.process(event);
      await webhookService.process({
        ...event,
        id: `evt_${new Types.ObjectId().toString()}`,
      } as Stripe.Event);

      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]).toMatchObject({
        status: "SUCCEEDED",
        providerReference: pi,
      });
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "SUCCEEDED",
      );
      const fees = (await rows(ctx.booking._id, "PROCESSING_FEE")).filter(
        (r) => r.providerReference === pi,
      );
      expect(fees).toHaveLength(1);
      expect(fees[0]?.metadata).toMatchObject({ sourceType: "CANCELLATION_FEE" });
    });

    it("57/80 no-show success webhook converges and its processing fee is no longer lost", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charged");
      const [obligation] = await rows(ctx.booking._id, "NO_SHOW_FEE");

      await webhookService.process(
        await piEvent("payment_intent.succeeded", obligation?.providerReference as string),
      );
      await webhookService.process(
        await piEvent("payment_intent.succeeded", obligation?.providerReference as string),
      );

      const fees = (await rows(ctx.booking._id, "PROCESSING_FEE")).filter(
        (r) => r.providerReference === obligation?.providerReference,
      );
      expect(fees).toHaveLength(1);
      expect(fees[0]?.metadata).toMatchObject({ sourceType: "NO_SHOW_FEE" });
      expect(await StripeWebhookEventModel.countDocuments({ status: "PROCESSED" })).toBe(2);
    });

    it("58 failed webhook converges an UNKNOWN attempt to FAILED", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeOutcome("failed");
      paymentGateway.queueNextChargeLostResponse();
      await cancelLate(ctx, ctx.booking._id);
      const pi = paymentGateway.createdPaymentIntentIds().at(-1) as string;

      await webhookService.process(await piEvent("payment_intent.payment_failed", pi));

      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "FAILED",
      );
    });

    it("59 canceled webhook converges to a definitive failure", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charge_pending");
      const pi = paymentGateway.createdPaymentIntentIds().at(-1) as string;
      paymentGateway.setPaymentIntentStatus(pi, "canceled");

      await webhookService.process(await piEvent("payment_intent.canceled", pi));

      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("FAILED");
      expect((await freshBooking(ctx.booking._id)).status).toBe("PENDING");
    });

    it("60 a stale failure event cannot regress a collected penalty", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      await cancelLate(ctx, ctx.booking._id);
      const [obligation] = await rows(ctx.booking._id, "CANCELLATION_FEE");

      await webhookService.process(
        await piEvent("payment_intent.payment_failed", obligation?.providerReference as string),
      );

      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("SUCCEEDED");
      expect((await freshBooking(ctx.booking._id)).cancellationOutcome?.settlementStatus).toBe(
        "SUCCEEDED",
      );
    });

    it("61/62 [race] webhook vs recovery vs request convergence: exactly one settlement, one fee, one follow-up", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();
      await cancelLate(ctx, ctx.booking._id);
      const pi = paymentGateway.createdPaymentIntentIds().at(-1) as string;
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );

      await Promise.allSettled([
        webhookService.process(await piEvent("payment_intent.succeeded", pi)),
        recovery.runOnce(),
        penaltyCollection.convergeAttempt(attempt?._id as Types.ObjectId),
      ]);
      await backdateAttempts(ctx.booking._id);
      await recovery.runOnce();
      await webhookService.process(await piEvent("payment_intent.succeeded", pi));

      expect(await rows(ctx.booking._id, "CANCELLATION_FEE")).toHaveLength(1);
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]).toMatchObject({
        status: "SUCCEEDED",
        providerReference: pi,
      });
      expect(
        (await rows(ctx.booking._id, "PROCESSING_FEE")).filter((r) => r.providerReference === pi),
      ).toHaveLength(1);
      expect(await outboxFor("PENALTY_SETTLEMENT_CUSTOMER")).toHaveLength(1);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(1);
    });

    it("63 a purpose mismatch fails closed before anything is recorded", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      paymentGateway.queueNextChargeLostResponse();
      await cancelLate(ctx, ctx.booking._id);
      const pi = paymentGateway.createdPaymentIntentIds().at(-1) as string;

      await webhookService.process(
        await piEvent("payment_intent.succeeded", pi, { purpose: "NO_SHOW_FEE" }),
      );

      expect(await StripeWebhookEventModel.countDocuments({ status: "FAILED" })).toBe(1);
      const [attempt] = (await attemptsFor(ctx.booking._id)).filter(
        (a) => a.purpose === "CANCELLATION_FEE",
      );
      expect(attempt?.providerStatus).toBe("UNKNOWN");
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("PENDING");
    });
  });

  // ==========================================================================================
  // ACCOUNTING / ISOLATION / MANUAL / LEGACY
  // ==========================================================================================

  describe("accounting, isolation, MANUAL and legacy", () => {
    it("74/75/76/77/81/82 business owns the penalty; failed/waived contribute €0; PLATFORM_FEE netting never double-credits", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await makeLate(ctx.booking._id);
      const cancelled = await cancelLate(ctx, ctx.booking._id);
      const pi = cancelled.cancellationOutcome?.settlementProviderReference as string;
      await webhookService.process(await piEvent("payment_intent.succeeded", pi));

      const { customer } = await createLinkedCustomer(ctx);
      const failed = await book(ctx, customer._id, "12:00");
      await makeLate(failed._id);
      paymentGateway.queueNextChargeOutcome("failed");
      await lifecycleService.cancelByCustomer(String(customer._id), String(failed._id), "late");

      const payable = await financeService.getBusinessPayableForSuperAdmin(
        String(ctx.business._id),
      );
      // €30 collected penalty (the €20 PLATFORM_FEE stays Bookly's) − €0.55 Business-borne fee.
      expect(payable).toMatchObject({
        cancellationAmountCents: 3000,
        processingFeesCents: 55,
        netCents: 2945,
      });
    });

    it("18 travel is excluded: a booking carrying a travel fee is charged on the eligible basis only", async () => {
      const cancel = await firstBooking({ cancellationPct: 50 });
      const noShow = await firstBooking({ noShowPct: 80 });
      for (const id of [cancel.booking._id, noShow.booking._id]) {
        await BookingModel.updateOne(
          { _id: id },
          { $set: { "financials.travelFeeCents": 1500, "financials.totalCents": 11_500 } },
        ).exec();
      }
      await makeLate(cancel.booking._id);
      const cancelled = await cancelLate(cancel, cancel.booking._id);
      expect(cancelled.cancellationOutcome).toMatchObject({
        cancellationFeeCents: 5000,
        additionalChargeCents: 3000,
      });

      await markOverdue(noShow, noShow.booking._id);
      expect(await noShowService.autoResolve(noShow.booking._id)).toBe("charged");
      expect((await rows(noShow.booking._id, "NO_SHOW_FEE"))[0]?.amountCents).toBe(6000);
    });

    it("24/40/89 package percentage suppression: a package-linked booking with a real positive basis is never charged", async () => {
      // A Package origin booking carries the genuine bundle basis; linkage is the line's
      // packageProgressId (package-progress.rules.ts isPackageLinkedBooking).
      const linkToPackage = (id: Types.ObjectId) =>
        BookingModel.updateOne(
          { _id: id },
          { $set: { "serviceLines.0.pricingInput.packageProgressId": new Types.ObjectId() } },
        ).exec();

      const cancel = await firstBooking({ cancellationPct: 50 });
      await linkToPackage(cancel.booking._id);
      await makeLate(cancel.booking._id);
      const cancelled = await cancelLate(cancel, cancel.booking._id);
      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome).toMatchObject({
        cancellationFeeCents: 0,
        additionalChargeCents: 0,
        settlementStatus: "NOT_APPLICABLE",
      });

      const noShow = await firstBooking({ noShowPct: 80 });
      await linkToPackage(noShow.booking._id);
      await markOverdue(noShow, noShow.booking._id);
      expect(await noShowService.autoResolve(noShow.booking._id)).toBe("waived_no_policy");
      expect((await freshBooking(noShow.booking._id)).status).toBe("NO_SHOW_WAIVED");

      expect(await rows(cancel.booking._id, "CANCELLATION_FEE")).toHaveLength(0);
      expect(await rows(noShow.booking._id, "NO_SHOW_FEE")).toHaveLength(0);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] !== "BOOKING_DEPOSIT",
        ),
      ).toHaveLength(0);
    });

    it("78 legacy DEPOSIT netting is preserved", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await BookingFinancialTransactionModel.updateOne(
        { bookingId: ctx.booking._id, type: "PLATFORM_FEE" },
        { $set: { type: "DEPOSIT" } },
      ).exec();
      await makeLate(ctx.booking._id);
      const cancelled = await cancelLate(ctx, ctx.booking._id);
      expect(cancelled.cancellationOutcome).toMatchObject({
        depositAppliedCents: 2000,
        additionalChargeCents: 3000,
      });
    });

    it("83/84/85/86 penalties never consume/restore FIRST, never change activatedAt, never touch promo", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      const before = await BusinessClientModel.findById(ctx.client._id).lean().exec();
      const promoBefore = await PromoRedemptionModel.countDocuments({});
      await makeLate(ctx.booking._id);
      await cancelLate(ctx, ctx.booking._id);
      const after = await BusinessClientModel.findById(ctx.client._id).lean().exec();
      expect(after?.financialRelationship).toEqual(before?.financialRelationship);
      expect(after?.activatedAt).toEqual(before?.activatedAt);
      expect(await PromoRedemptionModel.countDocuments({})).toBe(promoBefore);
    });

    it("91/93 MANUAL late cancellation keeps its lifecycle classification but is never auto-charged", async () => {
      const ctx = await setupBusiness({ cancellationPct: 50 });
      const { customer, client } = await createLinkedCustomer(ctx);
      const manual = await creationService.createManualBooking(
        String(ctx.owner._id),
        OWNER,
        String(ctx.business._id),
        {
          businessClientId: String(client._id),
          serviceLines: finalizeInput(ctx, "10:00").serviceLines,
          startAt: finalizeInput(ctx, "10:00").startAt,
          idempotencyKey: `manual-${new Types.ObjectId().toString()}`,
        } as never,
      );
      await makeLate(manual._id);

      const cancelled = await lifecycleService.cancelByCustomer(
        String(customer._id),
        String(manual._id),
        "late",
      );

      expect(cancelled.status).toBe("LATE_CANCELLATION");
      expect(cancelled.cancellationOutcome).toMatchObject({
        feeMode: "PERCENTAGE",
        cancellationFeeCents: 0,
        additionalChargeCents: 0,
        settlementStatus: "NOT_APPLICABLE",
      });
      expect(await rows(manual._id, "CANCELLATION_FEE")).toHaveLength(0);
      expect(paymentGateway.paymentIntentInputs).toHaveLength(0);
    });

    it("104/105/108/109 legacy cancellation `:ledger` rows stay readable, are never auto-charged and never waived blind", async () => {
      const ctx = await firstBooking({ cancellationPct: 50 });
      await BookingModel.updateOne(
        { _id: ctx.booking._id },
        {
          $set: {
            status: "LATE_CANCELLATION",
            cancellationOutcome: {
              classifiedAt: new Date(),
              tier: "UNDER_2_HOURS",
              feeMode: "PERCENTAGE",
              feePercentage: 50,
              cancellationFeeCents: 5000,
              depositAppliedCents: 2000,
              additionalChargeCents: 3000,
              refundOwedCents: 0,
              settlementStatus: "FAILED",
            },
          },
        },
      ).exec();
      await financialTransactionService.record({
        businessId: ctx.business._id,
        bookingId: ctx.booking._id,
        businessClientId: ctx.booking.customer.businessClientId,
        customerUserId: ctx.customer._id,
        type: "CANCELLATION_FEE",
        direction: "DEBIT",
        amountCents: 3000,
        currency: "EUR",
        status: "FAILED",
        idempotencyKey: `cancellation-fee:${String(ctx.booking._id)}:ledger`,
      });

      expect(
        toBookingDetailDto(await freshBooking(ctx.booking._id)).cancellationOutcome
          ?.settlementStatus,
      ).toBe("FAILED");
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_RECONCILIATION_REQUIRED");
      const result = await recovery.runOnce();
      expect(result.errors).toBe(0);
      expect(
        paymentGateway.paymentIntentInputs.filter(
          (i) => i.metadata["purpose"] === "CANCELLATION_FEE",
        ),
      ).toHaveLength(0);
      expect((await rows(ctx.booking._id, "CANCELLATION_FEE"))[0]?.status).toBe("FAILED");
    });

    it("106/107 a legacy stranded PENDING no-show claim is never auto-charged, is marked out of the worker, and needs reconciliation", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      await financialTransactionService.record({
        businessId: ctx.business._id,
        bookingId: ctx.booking._id,
        businessClientId: ctx.booking.customer.businessClientId,
        customerUserId: ctx.customer._id,
        type: "NO_SHOW_FEE",
        direction: "DEBIT",
        amountCents: 6000,
        currency: "EUR",
        status: "PENDING",
        idempotencyKey: `no-show:${String(ctx.booking._id)}`,
      });

      const counts = await noShowService.runOnce(50);
      expect(counts.skipped_already_resolved).toBe(1);
      expect((await freshBooking(ctx.booking._id)).noShowChargeClaimedAt).toBeInstanceOf(Date);
      expect(await bookingRepository.findManyOverdueNoShows(new Date(), 50)).toHaveLength(0);
      await rejectsWith(waive(ctx, ctx.booking._id), "BOOKING_FEE_RECONCILIATION_REQUIRED");
      await rejectsWith(reverse(ctx, ctx.booking._id), "BOOKING_FEE_RECONCILIATION_REQUIRED");
      expect((await recovery.runOnce()).errors).toBe(0);
      expect(
        paymentGateway.paymentIntentInputs.filter((i) => i.metadata["purpose"] === "NO_SHOW_FEE"),
      ).toHaveLength(0);
      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("PENDING");
    });

    it("legacy FAILED no-show claim keeps its existing manual waive path", async () => {
      const ctx = await firstBooking({ noShowPct: 80 });
      await markOverdue(ctx, ctx.booking._id);
      await financialTransactionService.record({
        businessId: ctx.business._id,
        bookingId: ctx.booking._id,
        businessClientId: ctx.booking.customer.businessClientId,
        customerUserId: ctx.customer._id,
        type: "NO_SHOW_FEE",
        direction: "DEBIT",
        amountCents: 6000,
        currency: "EUR",
        status: "FAILED",
        idempotencyKey: `no-show:${String(ctx.booking._id)}`,
      });
      const waived = await waive(ctx, ctx.booking._id);
      expect(waived.status).toBe("NO_SHOW_WAIVED");
      expect((await rows(ctx.booking._id, "NO_SHOW_FEE"))[0]?.status).toBe("WAIVED");
    });
  });
});
