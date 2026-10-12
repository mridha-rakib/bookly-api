import express from "express";
import { Types } from "mongoose";
import type Stripe from "stripe";
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
import { PenaltyCollectionService } from "../../../src/modules/booking/penalty-collection.service.js";
import {
  type BookingFinancialTransactionDocument,
  BookingFinancialTransactionModel,
} from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createBusinessRoute } from "../../../src/modules/business/business.route.js";
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
import { BusinessPayoutModel } from "../../../src/modules/finance/business-payout.model.js";
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { BusinessPayoutService } from "../../../src/modules/finance/business-payout.service.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { BUSINESS_PAYABLE_TYPES } from "../../../src/modules/finance/finance-ownership.js";
import { BookingCancelledNotifier } from "../../../src/modules/notification/booking-cancelled.notifier.js";
import { NoShowNotifier } from "../../../src/modules/notification/no-show.notifier.js";
import { PenaltySettlementNotifier } from "../../../src/modules/notification/penalty-settlement.notifier.js";
import { ProviderReversalNotifier } from "../../../src/modules/notification/provider-reversal.notifier.js";
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import type { RefundResult } from "../../../src/modules/payment/payment.types.js";
import {
  PaymentAttemptModel,
  PROVIDER_NOT_CREATED,
} from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { buildPaymentIntentMetadata } from "../../../src/modules/payment/payment-intent-metadata.js";
import { PaymentTaxAssociationReconciler } from "../../../src/modules/payment/payment-tax-association-reconciler.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { encryptIban } from "../../../src/modules/payout-destination/payout-destination.crypto.js";
import { PayoutDestinationRepository } from "../../../src/modules/payout-destination/payout-destination.repository.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionModel } from "../../../src/modules/promo/promo-redemption.model.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageModel } from "../../../src/modules/promo/promo-user-usage.model.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ExternalRefundModel } from "../../../src/modules/provider-reversal/external-refund.model.js";
import { PaymentDisputeModel } from "../../../src/modules/provider-reversal/payment-dispute.model.js";
import { ProviderReversalQueryService } from "../../../src/modules/provider-reversal/provider-reversal.query.js";
import {
  ExternalRefundRepository,
  PaymentDisputeRepository,
} from "../../../src/modules/provider-reversal/provider-reversal.repository.js";
import {
  disputeFeeKey,
  disputePrincipalKey,
  externalRefundKey,
  ProviderReversalService,
} from "../../../src/modules/provider-reversal/provider-reversal.service.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventModel } from "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { seedLegacyReturningDeposit } from "../../helpers/legacy-returning-deposit.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20";
const OWNER = "BUSINESS_OWNER" as const;
const DISPUTE_FEE = 1_500;
const TEST_IBAN_CY = "CY17002001280000001200527600";

type DisputeEventType =
  | "charge.dispute.created"
  | "charge.dispute.updated"
  | "charge.dispute.closed"
  | "charge.dispute.funds_withdrawn"
  | "charge.dispute.funds_reinstated";

/**
 * P6 — provider-originated reversals: Stripe disputes (chargebacks) and refunds made outside
 * Bookly. Accounting only (provider-confirmed money movements, one immutable row each, owned by
 * the disputed/refunded principal's economic owner), Business carry-forward through the existing
 * payout, webhook + polling convergence, FAILED replay, support/Business visibility and strict
 * FIRST / promo / package / penalty isolation.
 */
describe("P6 provider-originated reversals", () => {
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
  let refunds: RefundOperationRepository;
  let financialTransactionService: BookingFinancialTransactionService;
  let packageProgressRepository: PackageProgressRepository;
  let penaltyCollection: PenaltyCollectionService;
  let relationshipService: ReturnType<typeof createFinancialRelationshipService>;
  let eventRepository: StripeWebhookEventRepository;
  let providerReversals: ProviderReversalService;
  let webhookService: StripeWebhookService;
  let recovery: MoneyRecoveryService;
  let financeService: FinanceService;
  let businessPayoutService: BusinessPayoutService;
  let payoutDestinationRepository: PayoutDestinationRepository;
  let query: ProviderReversalQueryService;
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
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
    paymentGateway = new FakePaymentGateway();
    attempts = new PaymentAttemptRepository();
    refunds = new RefundOperationRepository();
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
    packageProgressRepository = new PackageProgressRepository();
    penaltyCollection = new PenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      businessRepository,
      settlementNotifier: new PenaltySettlementNotifier(new EmailOutboxService(), userRepository),
      noShowNotifier: new NoShowNotifier(new EmailOutboxService()),
      packageProgressRepository,
    });
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
      new BookingCancelledNotifier(new EmailOutboxService(), userRepository),
      new NoShowNotifier(new EmailOutboxService()),
      undefined,
      undefined,
      undefined,
      packageProgressRepository,
      undefined,
      undefined,
      penaltyCollection,
    );
    noShowService = new NoShowResolutionService(
      bookingRepository,
      businessRepository,
      paymentService,
      financialTransactionService,
      new NoShowNotifier(new EmailOutboxService()),
      packageProgressRepository,
      penaltyCollection,
    );
    relationshipService = createFinancialRelationshipService({
      paymentAttemptRepository: attempts,
      refundOperationRepository: refunds,
      bookingRepository,
    });
    eventRepository = new StripeWebhookEventRepository();
    providerReversals = buildProviderReversals();
    webhookService = buildWebhookService(providerReversals);
    recovery = buildRecovery(providerReversals);
    const businessPayoutRepository = new BusinessPayoutRepository();
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      businessPayoutRepository,
    );
    payoutDestinationRepository = new PayoutDestinationRepository();
    businessPayoutService = new BusinessPayoutService(
      businessRepository,
      financialTransactionService,
      businessPayoutRepository,
      payoutDestinationRepository,
    );
    query = new ProviderReversalQueryService(
      new PaymentDisputeRepository(),
      new ExternalRefundRepository(),
      financialTransactionService,
    );
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Composition ---------------------------------------------------------------------------

  const buildProviderReversals = () =>
    new ProviderReversalService({
      gateway: paymentGateway,
      disputes: new PaymentDisputeRepository(),
      externalRefunds: new ExternalRefundRepository(),
      financialTransactionService,
      paymentAttemptRepository: attempts,
      refundOperationRepository: refunds,
      bookingRepository,
      businessRepository,
      notifier: new ProviderReversalNotifier(new EmailOutboxService(), userRepository),
    });

  const buildWebhookService = (reversals: ProviderReversalService) =>
    new StripeWebhookService(
      paymentGateway,
      eventRepository,
      financialTransactionService,
      new PaymentTaxAssociationReconciler(paymentGateway, bookingRepository),
      attempts,
      refunds,
      packageProgressRepository,
      bookingRepository,
      relationshipService,
      penaltyCollection,
      reversals,
    );

  const buildRecovery = (reversals: ProviderReversalService) =>
    new MoneyRecoveryService(
      paymentService,
      attempts,
      refunds,
      bookingRepository,
      financialTransactionService,
      buildWebhookService(reversals),
      packageProgressRepository,
      relationshipService,
      penaltyCollection,
      reversals,
    );

  // --- Business / customer / booking fixtures (same shapes as the P5 suite) -------------------

  const setupBusiness = async (opts: { cancellationPct?: number; noShowPct?: number } = {}) => {
    const ownerEmail = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: ownerEmail,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Salon P6",
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
      opts.noShowPct ?? 20,
    );
    return { owner, business, membership, service };
  };

  type Ctx = Awaited<ReturnType<typeof setupBusiness>>;

  const createLinkedCustomer = async (ctx: Ctx) => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const setupIntent = await paymentService.createSetupIntent(String(customer._id));
    await paymentService.confirmSavedPaymentMethod(String(customer._id), setupIntent.setupIntentId);
    const nationalNumber = `9${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    const client = await clientRepository.create({
      businessId: ctx.business._id,
      createdByUserId: ctx.owner._id,
      firstName: "Dana",
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

  const book = async (ctx: Ctx, customerId: Types.ObjectId, time = "10:00") => {
    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
      String(ctx.business._id),
      {
        serviceLines: [
          {
            serviceId: String(ctx.service._id),
            staffMembershipId: String(ctx.membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    return result.booking;
  };

  /** €100 FIRST booking (€20 Bookly PLATFORM_FEE) by a linked customer with a saved card. */
  const firstBooking = async (opts: { cancellationPct?: number; noShowPct?: number } = {}) => {
    const ctx = await setupBusiness(opts);
    const { customer, client } = await createLinkedCustomer(ctx);
    const booking = await book(ctx, customer._id);
    return { ...ctx, customer, client, booking };
  };

  type FirstCtx = Awaited<ReturnType<typeof firstBooking>>;

  /** A RETURNING (€0 online) booking turned into a legacy Business-owned €20 DEPOSIT. */
  const legacyDeposit = async (ctx: FirstCtx, time: string) => {
    const booking = await book(ctx, ctx.customer._id, time);
    const seeded = await seedLegacyReturningDeposit(
      { paymentService, financialTransactionService },
      booking,
    );
    return seeded;
  };

  /**
   * Session 2+ extras exactly as BookingCreationService records them: a non-FIRST,
   * non-contract PACKAGE_SESSION_EXTRAS PaymentAttempt + Business-owned DEPOSIT row, linked to a
   * package entitlement (used here only to prove it is never mutated).
   */
  const sessionExtras = async (ctx: FirstCtx, time: string, amountCents = 1_500) => {
    const booking = await book(ctx, ctx.customer._id, time);
    const progressId = new Types.ObjectId();
    await PackageProgressModel.collection.insertOne({
      _id: progressId,
      businessId: ctx.business._id,
      customerUserId: ctx.customer._id,
      remainingSessions: 2,
      totalSessions: 3,
      marker: "p6-isolation",
    } as never);
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "serviceLines.0.pricingInput.packageProgressId": progressId } },
    ).exec();
    const key = `session-extras:${String(booking._id)}`;
    const charge = await paymentService.chargeBookingDeposit({
      userId: ctx.customer._id,
      amountCents,
      idempotencyKey: key,
      metadata: buildPaymentIntentMetadata({
        bookingId: String(booking._id),
        businessId: String(ctx.business._id),
        businessClientId: String(ctx.client._id),
        purpose: "PACKAGE_SESSION_EXTRAS",
        preTaxChargeCents: amountCents,
        taxCents: 0,
        chargedAmountCents: amountCents,
        taxMode: "PRE_ACTIVATION",
      }),
    });
    const ledger = await financialTransactionService.record({
      businessId: ctx.business._id,
      bookingId: booking._id,
      businessClientId: ctx.client._id,
      customerUserId: ctx.customer._id,
      type: "DEPOSIT",
      direction: "DEBIT",
      amountCents,
      currency: "EUR",
      status: "SUCCEEDED",
      providerReference: charge.paymentIntentId,
      idempotencyKey: `${key}:deposit`,
    });
    const lease = await paymentService.claimPaymentPersistence(charge.paymentAttemptId);
    await paymentService.markPaymentCompleted(
      charge.paymentAttemptId,
      { bookingId: booking._id, packageProgressId: progressId, succeededTransactionId: ledger._id },
      lease as string,
    );
    return { booking };
  };

  const makeLate = (bookingId: Types.ObjectId) =>
    BookingModel.updateOne(
      { _id: bookingId },
      { $set: { "schedule.startAt": new Date(Date.now() + 60 * 60 * 1000) } },
    ).exec();

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

  // --- The five disputed source classes ------------------------------------------------------

  type SourceName =
    | "PLATFORM_FEE"
    | "DEPOSIT"
    | "SESSION_EXTRAS"
    | "CANCELLATION_FEE"
    | "NO_SHOW_FEE";

  type Source = {
    ctx: FirstCtx;
    bookingId: Types.ObjectId;
    principal: BookingFinancialTransactionDocument;
    pi: string;
    owner: "BOOKLY" | "BUSINESS";
  };

  const sourceOf = async (
    ctx: FirstCtx,
    bookingId: Types.ObjectId,
    type: BookingFinancialTransactionDocument["type"],
    owner: Source["owner"],
  ): Promise<Source> => {
    const [principal, ...extra] = await BookingFinancialTransactionModel.find({
      bookingId,
      type,
      status: "SUCCEEDED",
      providerReference: /^pi_/,
    }).exec();
    if (!principal || extra.length > 0) throw new Error(`expected exactly one ${type} principal`);
    return { ctx, bookingId, principal, pi: principal.providerReference as string, owner };
  };

  const SOURCES: Record<SourceName, () => Promise<Source>> = {
    PLATFORM_FEE: async () => {
      const ctx = await firstBooking();
      return sourceOf(ctx, ctx.booking._id, "PLATFORM_FEE", "BOOKLY");
    },
    DEPOSIT: async () => {
      const ctx = await firstBooking();
      const { booking } = await legacyDeposit(ctx, "14:00");
      return sourceOf(ctx, booking._id, "DEPOSIT", "BUSINESS");
    },
    SESSION_EXTRAS: async () => {
      const ctx = await firstBooking();
      const { booking } = await sessionExtras(ctx, "14:00");
      return sourceOf(ctx, booking._id, "DEPOSIT", "BUSINESS");
    },
    CANCELLATION_FEE: async () => {
      const ctx = await firstBooking({ cancellationPct: 50 }); // €50 − €20 retained = €30
      await makeLate(ctx.booking._id);
      await lifecycleService.cancelByCustomer(
        String(ctx.customer._id),
        String(ctx.booking._id),
        "late",
      );
      return sourceOf(ctx, ctx.booking._id, "CANCELLATION_FEE", "BUSINESS");
    },
    NO_SHOW_FEE: async () => {
      const ctx = await firstBooking({ noShowPct: 80 }); // €80 − €20 retained = €60
      await markOverdue(ctx, ctx.booking._id);
      expect(await noShowService.autoResolve(ctx.booking._id)).toBe("charged");
      return sourceOf(ctx, ctx.booking._id, "NO_SHOW_FEE", "BUSINESS");
    },
  };

  // --- Provider events -----------------------------------------------------------------------

  const evtId = () => `evt_${new Types.ObjectId().toString()}`;

  const disputeEvent = (type: DisputeEventType, disputeId: string, id = evtId()): Stripe.Event =>
    ({
      id,
      type,
      data: { object: { id: disputeId, object: "dispute", amount: 0, currency: "eur" } },
    }) as unknown as Stripe.Event;

  /** charge.refunded as current Stripe API versions send it: cumulative state only (the
   * charge's refund list is not expanded) — every refund id must be listed from the provider. */
  const chargeRefundedEvent = (pi: string, cumulativeCents: number, id = evtId()): Stripe.Event =>
    ({
      id,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_${pi}`,
          payment_intent: pi,
          amount_refunded: cumulativeCents,
          metadata: {},
          refunds: { data: [] },
        },
      },
    }) as unknown as Stripe.Event;

  const refundUpdatedEvent = (refund: RefundResult, id = evtId()): Stripe.Event =>
    ({
      id,
      type: "charge.refund.updated",
      data: {
        object: {
          id: refund.refundId,
          payment_intent: refund.paymentIntentId,
          amount: refund.amountCents,
          currency: "eur",
          status: refund.status,
          metadata: refund.metadata ?? {},
        },
      },
    }) as unknown as Stripe.Event;

  const piSucceededEvent = async (paymentIntentId: string): Promise<Stripe.Event> => {
    const snapshot = await paymentGateway.retrievePaymentIntent(paymentIntentId);
    return {
      id: evtId(),
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          amount: snapshot.amountCents,
          currency: snapshot.currency.toLowerCase(),
          customer: snapshot.customerId,
          metadata: snapshot.metadata,
        },
      },
    } as unknown as Stripe.Event;
  };

  // --- Reads ---------------------------------------------------------------------------------

  const disputeRecord = async (disputeId: string) =>
    PaymentDisputeModel.findOne({ providerDisputeId: disputeId }).orFail().lean().exec();

  const disputeRows = (disputeId: string) =>
    BookingFinancialTransactionModel.find({ "metadata.providerDisputeId": disputeId })
      .sort({ createdAt: 1 })
      .lean()
      .exec();

  const rowSummary = (rows: Array<{ type: string; amountCents: number }>) =>
    rows.map((row) => `${row.type}:${row.amountCents}`).sort();

  const externalRefundCount = (bookingId: Types.ObjectId) =>
    BookingFinancialTransactionModel.countDocuments({
      bookingId,
      type: "REFUND",
      "metadata.refundOrigin": "PROVIDER_EXTERNAL",
    });

  const payableNet = async (businessId: Types.ObjectId) =>
    (await financeService.getBusinessPayableForSuperAdmin(String(businessId))).netCents;

  /** The test's whole ledger lifetime (well inside the ledger's maximum query range). */
  const allTime = () => ({
    from: new Date(Date.now() - 30 * 24 * 60 * 60_000),
    to: new Date(Date.now() + 30 * 24 * 60 * 60_000),
  });

  /** A real provider PaymentIntent on the account that is NOT a Bookly charge. */
  const foreignPaymentIntent = async () =>
    (
      await paymentGateway.createAndConfirmPaymentIntent({
        stripeCustomerId: "cus_foreign",
        paymentMethodId: "pm_foreign",
        amountCents: 1_000,
        currency: "eur",
        idempotencyKey: `foreign-${new Types.ObjectId().toString()}`,
        offSession: true,
        saveForFutureUse: false,
        metadata: {},
      })
    ).paymentIntentId;

  const booklyTotals = async () => (await financeService.getPlatformSummary(allTime())).bookly;

  /** Distinct notifications (support alerts fan out to two internal mailboxes). */
  const notifications = async (templateKey: string, kind?: string) => {
    const rows = await EmailOutboxModel.find({
      templateKey,
      ...(kind ? { "payload.kind": kind } : {}),
    })
      .lean()
      .exec();
    return [...new Set(rows.map((row) => row.eventKey))];
  };

  /** Everything P6 must never mutate: booking / penalty lifecycle, FIRST relationship + audit,
   * promo, package entitlements, payment attempts and Bookly refund operations. */
  const domainSnapshot = async () => {
    const collections = [
      BookingModel,
      BusinessClientModel,
      PackageProgressModel,
      PromoRedemptionModel,
      PromoUserUsageModel,
      PaymentAttemptModel,
      RefundOperationModel,
    ];
    const snapshot: Record<string, unknown> = {};
    for (const model of collections) {
      snapshot[model.collection.collectionName] = JSON.parse(
        JSON.stringify(await model.collection.find({}).sort({ _id: 1 }).toArray()),
      );
    }
    return snapshot;
  };

  const createAdmin = () =>
    userRepository.create({
      normalizedEmail: `admin-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  const configureDestination = async (ctx: Ctx) => {
    const encrypted = encryptIban(TEST_IBAN_CY, ctx.business._id);
    await payoutDestinationRepository.upsert(
      ctx.business._id,
      {
        accountHolderName: "Test Account Holder",
        ibanCiphertext: encrypted.ciphertext,
        ibanIv: encrypted.iv,
        ibanAuthTag: encrypted.authTag,
        ibanKeyVersion: encrypted.keyVersion,
        ibanLast4: TEST_IBAN_CY.slice(-4),
        ibanCountry: TEST_IBAN_CY.slice(0, 2),
        lastUpdatedByUserId: ctx.owner._id,
      },
      {
        action: "CREATED",
        actorUserId: ctx.owner._id,
        changedAt: new Date(),
        newLast4: TEST_IBAN_CY.slice(-4),
      },
    );
  };

  /** Business with a FIRST booking (Bookly PLATFORM_FEE) + `count` legacy €20 DEPOSITs. */
  const businessWithDeposits = async (count: number) => {
    const ctx = await firstBooking();
    const deposits: Source[] = [];
    for (let index = 0; index < count; index += 1) {
      const { booking } = await legacyDeposit(ctx, `${String(11 + index).padStart(2, "0")}:00`);
      deposits.push(await sourceOf(ctx, booking._id, "DEPOSIT", "BUSINESS"));
    }
    await configureDestination(ctx);
    const admin = await createAdmin();
    const payout = () =>
      businessPayoutService.executePayout(String(admin._id), String(ctx.business._id));
    return { ctx, deposits, admin, payout };
  };

  const sync = (disputeId: string, type: DisputeEventType = "charge.dispute.updated") =>
    webhookService.process(disputeEvent(type, disputeId));

  // ==========================================================================================
  // PHASE 37 — dispute matrix per source class (1–17)
  // ==========================================================================================

  describe.each([
    "PLATFORM_FEE",
    "DEPOSIT",
    "SESSION_EXTRAS",
    "CANCELLATION_FEE",
    "NO_SHOW_FEE",
  ] as const)("dispute matrix — %s", (name) => {
    it("1–7/11/13–17 created → duplicate → updated → withdrawn (+fee) → duplicate → lost; stale state never regresses", async () => {
      const source = await SOURCES[name]();
      const amount = source.principal.amountCents;
      const businessId = source.ctx.business._id;
      const before = await domainSnapshot();
      const payableBefore = await payableNet(businessId);
      const booklyBefore = await booklyTotals();

      const disputeId = paymentGateway.openDispute(source.pi, amount);
      const staleSnapshot = await paymentGateway.retrieveDispute(disputeId);

      // 1 created: durable, correlated, owned — but "opened" alone moves no money.
      expect(await sync(disputeId, "charge.dispute.created")).toBe(true);
      const opened = await disputeRecord(disputeId);
      expect(opened).toMatchObject({
        correlation: "CORRELATED",
        economicOwner: source.owner,
        sourceType: source.principal.type,
        providerStatus: "needs_response",
        final: false,
        amountCents: amount,
        currency: "EUR",
      });
      expect(opened.investigationReason).toBeUndefined();
      expect(String(opened.sourceTransactionId)).toBe(String(source.principal._id)); // 13
      expect(String(opened.bookingId)).toBe(String(source.bookingId));
      expect(await disputeRows(disputeId)).toHaveLength(0);

      // 2 duplicate created event (a different delivery id).
      await sync(disputeId, "charge.dispute.created");
      // 3 updated
      paymentGateway.setDisputeStatus(disputeId, "under_review");
      await sync(disputeId, "charge.dispute.updated");
      expect((await disputeRecord(disputeId)).providerStatus).toBe("under_review");
      expect(await disputeRows(disputeId)).toHaveLength(0);

      // 5 funds withdrawn (+ 11 the provider's dispute fee), 6 duplicate deliveries.
      const withdrawal = paymentGateway.withdrawDisputeFunds(disputeId);
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      await sync(disputeId, "charge.dispute.updated");
      const rows = await disputeRows(disputeId);
      expect(rowSummary(rows)).toEqual([
        `DISPUTE_FEE:${DISPUTE_FEE}`,
        `DISPUTE_WITHDRAWAL:${amount}`,
      ]);
      expect(rows.map((row) => row.idempotencyKey).sort()).toEqual(
        [disputeFeeKey(disputeId, withdrawal), disputePrincipalKey(disputeId, withdrawal)].sort(),
      );
      for (const row of rows) {
        expect(row).toMatchObject({
          status: "SUCCEEDED",
          currency: "EUR",
          providerReference: disputeId,
          businessId,
          bookingId: source.bookingId,
        });
        expect(row.payoutId).toBeUndefined();
        expect(row.metadata).toMatchObject({
          sourceType: source.principal.type,
          sourceTransactionId: String(source.principal._id),
          balanceTransactionId: withdrawal,
        });
      }
      expect((await disputeRecord(disputeId)).fundsWithdrawnAt).toBeInstanceOf(Date);

      // 7 final lost
      paymentGateway.setDisputeStatus(disputeId, "lost");
      await sync(disputeId, "charge.dispute.closed");
      expect(await disputeRecord(disputeId)).toMatchObject({
        final: true,
        outcome: "LOST",
        providerStatus: "lost",
      });

      // 4/P6-I18 an out-of-order (older) provider view after closure regresses nothing.
      await providerReversals.applyDisputeSnapshot(staleSnapshot, "WEBHOOK");
      expect(await disputeRecord(disputeId)).toMatchObject({ final: true, outcome: "LOST" });
      expect(await disputeRows(disputeId)).toHaveLength(2);

      // 14/15 economic owner bears principal + fee — and only that owner.
      const loss = amount + DISPUTE_FEE;
      const booklyAfter = await booklyTotals();
      if (source.owner === "BUSINESS") {
        expect(payableBefore - (await payableNet(businessId))).toBe(loss);
        expect(booklyAfter.netCents).toBe(booklyBefore.netCents);
        expect(booklyAfter.disputeAdjustmentsCents).toBe(0);
      } else {
        expect(await payableNet(businessId)).toBe(payableBefore);
        expect(booklyBefore.netCents - booklyAfter.netCents).toBe(loss);
        expect(booklyAfter.disputeAdjustmentsCents).toBe(loss);
      }
      // 16 payout effect: Business-owned rows are payable-scoped and still unclaimed.
      expect(
        rows.every((row) => (BUSINESS_PAYABLE_TYPES as readonly string[]).includes(row.type)),
      ).toBe(true);

      // 17 notifications: support once; the Business only when it bears the money.
      expect(await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_NEW")).toHaveLength(1);
      const business = async (kind: string) => notifications("PROVIDER_REVERSAL_BUSINESS", kind);
      const expected = source.owner === "BUSINESS" ? 1 : 0;
      expect(await business("DISPUTE_OPENED")).toHaveLength(expected);
      expect(await business("DISPUTE_FUNDS_WITHDRAWN")).toHaveLength(expected);
      expect(await business("DISPUTE_LOST")).toHaveLength(expected);
      expect(await business("DISPUTE_WON")).toHaveLength(0);
      expect(await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_INVESTIGATION")).toHaveLength(0);

      // P6-I2 nothing was ever refused or re-keyed: no reconciliation was needed.
      expect((await disputeRecord(disputeId)).investigationReason).toBeUndefined();
      expect(
        await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_RECONCILIATION_REQUIRED"),
      ).toHaveLength(0);

      // P6-I11..I14 accounting only: no lifecycle, relationship, promo or package mutation.
      expect(await domainSnapshot()).toEqual(before);
    });

    it("8–10/12 withdrawn at creation → reinstated (+ fee returned) → duplicate reinstatement → won", async () => {
      const source = await SOURCES[name]();
      const amount = source.principal.amountCents;
      const businessId = source.ctx.business._id;
      const before = await domainSnapshot();
      const payableBefore = await payableNet(businessId);
      const booklyBefore = await booklyTotals();

      // Stripe usually withdraws at creation: "opened" and "funds withdrawn" describe ONE
      // movement and must never double-account.
      const disputeId = paymentGateway.openDispute(source.pi, amount, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      expect(await disputeRows(disputeId)).toHaveLength(2);

      paymentGateway.reinstateDisputeFunds(disputeId);
      paymentGateway.setDisputeStatus(disputeId, "won");
      await sync(disputeId, "charge.dispute.funds_reinstated");
      await sync(disputeId, "charge.dispute.funds_reinstated"); // 10 duplicate
      await sync(disputeId, "charge.dispute.closed");

      const rows = await disputeRows(disputeId);
      expect(rowSummary(rows)).toEqual(
        [
          `DISPUTE_FEE:${DISPUTE_FEE}`,
          `DISPUTE_FEE_REVERSAL:${DISPUTE_FEE}`,
          `DISPUTE_REINSTATEMENT:${amount}`,
          `DISPUTE_WITHDRAWAL:${amount}`,
        ].sort(),
      );
      expect(await disputeRecord(disputeId)).toMatchObject({ final: true, outcome: "WON" });
      expect((await disputeRecord(disputeId)).fundsReinstatedAt).toBeInstanceOf(Date);

      // P6-I7 the reinstatement reverses exactly the prior movement: net effect zero.
      expect(await payableNet(businessId)).toBe(payableBefore);
      expect((await booklyTotals()).netCents).toBe(booklyBefore.netCents);
      const view = await query.getDispute(disputeId);
      expect(view?.accounting).toMatchObject({
        principalWithdrawnCents: amount,
        principalReinstatedCents: amount,
        feeChargedCents: DISPUTE_FEE,
        feeReturnedCents: DISPUTE_FEE,
        netLossCents: 0,
      });

      const expected = source.owner === "BUSINESS" ? 1 : 0;
      for (const kind of [
        "DISPUTE_OPENED",
        "DISPUTE_FUNDS_WITHDRAWN",
        "DISPUTE_FUNDS_REINSTATED",
        "DISPUTE_WON",
      ]) {
        expect(await notifications("PROVIDER_REVERSAL_BUSINESS", kind)).toHaveLength(expected);
      }
      expect(await notifications("PROVIDER_REVERSAL_BUSINESS", "DISPUTE_LOST")).toHaveLength(0);
      expect((await disputeRecord(disputeId)).investigationReason).toBeUndefined();
      expect(await domainSnapshot()).toEqual(before);
    });
  });

  // ==========================================================================================
  // PHASE 38 — before / after payout (18–23)
  // ==========================================================================================

  describe("payout carry-forward (Business-owned DEPOSIT)", () => {
    const disputedDeposit = async (deposit: Source) => {
      const disputeId = paymentGateway.openDispute(deposit.pi, deposit.principal.amountCents, {
        withdraw: true,
      });
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      return disputeId;
    };

    it("18 a withdrawal before payout reduces current payable; the payout claims it exactly once", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      expect(await payableNet(ctx.business._id)).toBe(4_000);
      const disputeId = await disputedDeposit(deposits[0] as Source);
      const preview = await financeService.getBusinessPayableForSuperAdmin(
        String(ctx.business._id),
      );
      expect(preview).toMatchObject({ netCents: 500, disputeAdjustmentsCents: 3_500 });

      const paid = await payout();
      expect(paid).toMatchObject({ netPayoutCents: 500, disputeAdjustmentsCents: 3_500 });
      for (const row of await disputeRows(disputeId)) {
        expect(String(row.payoutId)).toBe(String(paid._id));
      }
      expect(await payableNet(ctx.business._id)).toBe(0);
      await expect(payout()).rejects.toMatchObject({ statusCode: 409 });
    });

    it("19/21 a withdrawal after payout carries forward as a negative balance; no payout is created for net <= 0", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(1);
      const first = await payout();
      expect(first.netPayoutCents).toBe(2_000);

      const disputeId = await disputedDeposit(deposits[0] as Source);
      expect(await payableNet(ctx.business._id)).toBe(-3_500);
      for (const row of await disputeRows(disputeId)) expect(row.payoutId).toBeUndefined();

      await expect(payout()).rejects.toMatchObject({
        statusCode: 409,
        details: expect.arrayContaining([
          expect.objectContaining({ code: "FINANCE_NO_ELIGIBLE_PAYABLE" }),
        ]),
      });
      expect(await BusinessPayoutModel.countDocuments({ businessId: ctx.business._id })).toBe(1);
    });

    it("20 the next positive payout consumes the carried-forward negative rows exactly once", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(1);
      await payout();
      const disputeId = await disputedDeposit(deposits[0] as Source);
      await legacyDeposit(ctx, "13:00");
      await legacyDeposit(ctx, "14:00");
      expect(await payableNet(ctx.business._id)).toBe(500);

      const second = await payout();
      expect(second).toMatchObject({ netPayoutCents: 500, disputeAdjustmentsCents: 3_500 });
      for (const row of await disputeRows(disputeId)) {
        expect(String(row.payoutId)).toBe(String(second._id));
      }
      await expect(payout()).rejects.toMatchObject({ statusCode: 409 });
      const paid = await BusinessPayoutModel.find({ businessId: ctx.business._id }).lean().exec();
      // 3 × €20 deposits − (€20 principal + €15 fee) = €25, paid across both payouts.
      expect(paid.reduce((sum, item) => sum + item.netPayoutCents, 0)).toBe(2_500);
    });

    it("22 a reinstatement before the next payout offsets the carried-forward negative exactly", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(1);
      await payout();
      const disputeId = await disputedDeposit(deposits[0] as Source);
      expect(await payableNet(ctx.business._id)).toBe(-3_500);

      paymentGateway.reinstateDisputeFunds(disputeId);
      paymentGateway.setDisputeStatus(disputeId, "won");
      await sync(disputeId, "charge.dispute.funds_reinstated");
      expect(await payableNet(ctx.business._id)).toBe(0);
      await expect(payout()).rejects.toMatchObject({ statusCode: 409 });

      await legacyDeposit(ctx, "13:00");
      const next = await payout();
      expect(next).toMatchObject({ netPayoutCents: 2_000, disputeAdjustmentsCents: 0 });
      expect(
        (await disputeRows(disputeId)).every((row) => String(row.payoutId) === String(next._id)),
      ).toBe(true);
    });

    it("23 a reinstatement after a later payout is a positive adjustment carried into the following payout", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      const disputeId = await disputedDeposit(deposits[0] as Source);
      const first = await payout();
      expect(first.netPayoutCents).toBe(500);

      paymentGateway.reinstateDisputeFunds(disputeId);
      await sync(disputeId, "charge.dispute.funds_reinstated");
      expect(await payableNet(ctx.business._id)).toBe(3_500);
      const second = await payout();
      expect(second).toMatchObject({ netPayoutCents: 3_500, disputeAdjustmentsCents: -3_500 });
      // Over both payouts the Business received exactly its two deposits.
      expect(first.netPayoutCents + second.netPayoutCents).toBe(4_000);
      const rows = await disputeRows(disputeId);
      expect(new Set(rows.map((row) => String(row.payoutId)))).toEqual(
        new Set([String(first._id), String(second._id)]),
      );
    });
  });

  // ==========================================================================================
  // PHASE 39 — FIRST (24–26)
  // ==========================================================================================

  describe("FIRST isolation", () => {
    it("24/25/26 a disputed then reinstated FIRST PLATFORM_FEE is Bookly accounting only; the relationship stays CONSUMED and no new FIRST opens", async () => {
      const source = await SOURCES.PLATFORM_FEE();
      const relationship = async () =>
        (await BusinessClientModel.findById(source.ctx.client._id).orFail().lean().exec())
          .financialRelationship;
      const before = await relationship();
      expect(before?.state).toBe("CONSUMED");

      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      expect(await relationship()).toEqual(before);
      expect((await booklyTotals()).disputeAdjustmentsCents).toBe(3_500);

      paymentGateway.reinstateDisputeFunds(disputeId);
      paymentGateway.setDisputeStatus(disputeId, "won");
      await sync(disputeId, "charge.dispute.funds_reinstated");
      expect(await relationship()).toEqual(before);
      expect((await booklyTotals()).disputeAdjustmentsCents).toBe(0);

      // An external refund of the PLATFORM_FEE does not reopen FIRST either.
      paymentGateway.createExternalRefund(source.pi, 2_000);
      await webhookService.process(chargeRefundedEvent(source.pi, 2_000));
      expect(await relationship()).toEqual(before);

      const next = await book(source.ctx, source.ctx.customer._id, "15:00");
      expect(next.financialContract?.classification).toBe("RETURNING");
      expect(next.financials.depositCents).toBe(0);
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          bookingId: next._id,
          type: "PLATFORM_FEE",
        }),
      ).toBe(0);
    });
  });

  // ==========================================================================================
  // PHASE 40 — external refunds (27–41)
  // ==========================================================================================

  describe("refunds made outside Bookly", () => {
    const externalRows = (bookingId: Types.ObjectId) =>
      BookingFinancialTransactionModel.find({
        bookingId,
        type: "REFUND",
        "metadata.refundOrigin": "PROVIDER_EXTERNAL",
      })
        .sort({ createdAt: 1 })
        .lean()
        .exec();

    it("27/36 a full external refund of a Business-owned DEPOSIT: one exact row, marked external, Business payable reduced, support + Business notified, no provider call", async () => {
      const source = await SOURCES.DEPOSIT();
      const before = await domainSnapshot();
      const payableBefore = await payableNet(source.ctx.business._id);
      const refund = paymentGateway.createExternalRefund(source.pi, 2_000);

      await webhookService.process(chargeRefundedEvent(source.pi, 2_000));

      const [row, ...extra] = await externalRows(source.bookingId);
      expect(extra).toHaveLength(0);
      expect(row).toMatchObject({
        type: "REFUND",
        direction: "CREDIT",
        status: "SUCCEEDED",
        amountCents: 2_000,
        providerReference: refund.refundId,
        idempotencyKey: externalRefundKey(refund.refundId),
      });
      expect(row?.metadata).toMatchObject({
        refundOrigin: "PROVIDER_EXTERNAL",
        sourceType: "DEPOSIT",
        sourceTransactionId: String(source.principal._id),
      });
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: refund.refundId }).lean().exec(),
      ).toMatchObject({
        state: "ACCOUNTED",
        economicOwner: "BUSINESS",
        amountCents: 2_000,
        detectedVia: "WEBHOOK",
        ledgerTransactionId: row?._id,
      });
      expect(payableBefore - (await payableNet(source.ctx.business._id))).toBe(2_000);
      expect(paymentGateway.refundInputs).toHaveLength(0); // never a second provider refund
      expect(await notifications("FINANCE_SUPPORT_ALERT", "EXTERNAL_REFUND")).toHaveLength(1);
      expect(await notifications("PROVIDER_REVERSAL_BUSINESS", "EXTERNAL_REFUND")).toHaveLength(1);
      expect(await RefundOperationModel.countDocuments({})).toBe(0); // no synthetic RefundOperation
      expect(await domainSnapshot()).toEqual(before); // 38–41
    });

    it("28/29/30/31 partial, multiple partial, duplicate and out-of-order discovery: one row per provider refund id, never the cumulative total", async () => {
      const source = await SOURCES.DEPOSIT();
      const first = paymentGateway.createExternalRefund(source.pi, 500);
      const second = paymentGateway.createExternalRefund(source.pi, 700);

      // 31 the later refund's update arrives first; listing accounts both exactly once.
      await webhookService.process(refundUpdatedEvent(second));
      await webhookService.process(refundUpdatedEvent(first));
      // 30 duplicate cumulative charge.refunded deliveries (€12 total so far).
      await webhookService.process(chargeRefundedEvent(source.pi, 1_200));
      await webhookService.process(chargeRefundedEvent(source.pi, 1_200));

      expect(rowSummary(await externalRows(source.bookingId))).toEqual([
        "REFUND:500",
        "REFUND:700",
      ]);
      expect(await ExternalRefundModel.countDocuments({ state: "ACCOUNTED" })).toBe(2);

      // A further refund beyond the remaining €8 principal is never guessed into the ledger.
      const third = paymentGateway.createExternalRefund(source.pi, 900);
      await webhookService.process(chargeRefundedEvent(source.pi, 2_100));
      expect(rowSummary(await externalRows(source.bookingId))).toEqual([
        "REFUND:500",
        "REFUND:700",
      ]);
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: third.refundId }).lean().exec(),
      ).toMatchObject({ state: "INVESTIGATION" });
      expect(
        await notifications("FINANCE_SUPPORT_ALERT", "EXTERNAL_REFUND_INVESTIGATION"),
      ).toHaveLength(1);
    });

    it("32 the same provider refund seen by webhook and by polling is accounted once", async () => {
      const source = await SOURCES.DEPOSIT();
      paymentGateway.createExternalRefund(source.pi, 800);
      await webhookService.process(chargeRefundedEvent(source.pi, 800));
      await recovery.runOnce();
      await recovery.runOnce();
      expect(rowSummary(await externalRows(source.bookingId))).toEqual(["REFUND:800"]);
    });

    it("33 a Bookly RefundOperation refund is never duplicated as external", async () => {
      const source = await SOURCES.DEPOSIT();
      await lifecycleService.cancelByBusiness(
        String(source.ctx.owner._id),
        OWNER,
        String(source.ctx.business._id),
        String(source.bookingId),
        "Staff emergency",
      );
      await webhookService.process(chargeRefundedEvent(source.pi, 2_000));
      await recovery.runOnce();

      expect(await ExternalRefundModel.countDocuments({})).toBe(0);
      const refundRows = await BookingFinancialTransactionModel.find({
        bookingId: source.bookingId,
        type: "REFUND",
      })
        .lean()
        .exec();
      expect(refundRows).toHaveLength(1);
      expect(refundRows[0]?.metadata?.["refundOrigin"]).toBeUndefined();

      // Support / Finance Log distinguishes the two origins.
      const page = await financeService.listPlatformTransactions(
        allTime(),
        { page: 1, limit: 50 },
        ["REFUND"],
      );
      expect(page.rows.map((row) => row.refundOrigin)).toEqual(["BOOKLY"]);
    });

    it("34/35 an external refund before payout reduces it; after payout it carries forward", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      paymentGateway.createExternalRefund((deposits[0] as Source).pi, 600);
      await webhookService.process(chargeRefundedEvent((deposits[0] as Source).pi, 600));
      const first = await payout();
      expect(first.netPayoutCents).toBe(3_400);

      paymentGateway.createExternalRefund((deposits[1] as Source).pi, 2_000);
      await webhookService.process(chargeRefundedEvent((deposits[1] as Source).pi, 2_000));
      expect(await payableNet(ctx.business._id)).toBe(-2_000);
      await expect(payout()).rejects.toMatchObject({ statusCode: 409 });

      const page = await financeService.listPlatformTransactions(
        allTime(),
        { page: 1, limit: 50 },
        ["REFUND"],
      );
      expect(page.rows.map((row) => row.refundOrigin)).toEqual([
        "PROVIDER_EXTERNAL",
        "PROVIDER_EXTERNAL",
      ]);
    });

    it("37 an external refund of the Bookly PLATFORM_FEE reduces Bookly revenue only, with no Business notification", async () => {
      const source = await SOURCES.PLATFORM_FEE();
      const before = await domainSnapshot();
      const payableBefore = await payableNet(source.ctx.business._id);
      const booklyBefore = await booklyTotals();
      const refund = paymentGateway.createExternalRefund(source.pi, 2_000);
      await webhookService.process(chargeRefundedEvent(source.pi, 2_000));

      expect(
        await ExternalRefundModel.findOne({ providerRefundId: refund.refundId }).lean().exec(),
      ).toMatchObject({ state: "ACCOUNTED", economicOwner: "BOOKLY" });
      expect(await payableNet(source.ctx.business._id)).toBe(payableBefore);
      const booklyAfter = await booklyTotals();
      expect(booklyAfter.refundsCents - booklyBefore.refundsCents).toBe(2_000);
      expect(booklyBefore.netCents - booklyAfter.netCents).toBe(2_000);
      expect(await notifications("PROVIDER_REVERSAL_BUSINESS")).toHaveLength(0);
      expect(await domainSnapshot()).toEqual(before);
    });

    it("38–41 external refunds of penalty / package-extras principals mutate no lifecycle, package, promo or FIRST state", async () => {
      for (const name of ["CANCELLATION_FEE", "NO_SHOW_FEE", "SESSION_EXTRAS"] as const) {
        const source = await SOURCES[name]();
        const before = await domainSnapshot();
        paymentGateway.createExternalRefund(source.pi, 1_000);
        await webhookService.process(chargeRefundedEvent(source.pi, 1_000));
        expect(rowSummary(await externalRows(source.bookingId))).toEqual(["REFUND:1000"]);
        expect(await domainSnapshot()).toEqual(before);
      }
    });

    it("legacy safety: a refund on a PaymentIntent that Bookly cannot correlate is recorded for investigation only", async () => {
      const unknown = paymentGateway.createExternalRefund(await foreignPaymentIntent(), 1_000);
      expect(await providerReversals.ingestProviderRefund(unknown, "POLLING")).toBe(
        "INVESTIGATION",
      );
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: unknown.refundId }).lean().exec(),
      ).toMatchObject({ state: "INVESTIGATION" });
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "REFUND" })).toBe(0);
    });

    it("an accounted external refund later reported failed is surfaced to support, never auto-reversed", async () => {
      const source = await SOURCES.DEPOSIT();
      const refund = paymentGateway.createExternalRefund(source.pi, 900);
      await webhookService.process(chargeRefundedEvent(source.pi, 900));
      paymentGateway.setRefundStatus(refund.refundId, "failed");
      await webhookService.process(refundUpdatedEvent({ ...refund, status: "failed" }));
      expect(rowSummary(await externalRows(source.bookingId))).toEqual(["REFUND:900"]);
      expect(
        await notifications("FINANCE_SUPPORT_ALERT", "EXTERNAL_REFUND_INVESTIGATION"),
      ).toHaveLength(1);
    });
  });

  // ==========================================================================================
  // PHASE 41 — refund / dispute overlap (42–47)
  // ==========================================================================================

  describe("refund / dispute overlap — principal conservation", () => {
    it("42 a dispute after a partial refund is accounted only within the remaining principal", async () => {
      const source = await SOURCES.DEPOSIT();
      paymentGateway.createExternalRefund(source.pi, 500);
      await webhookService.process(chargeRefundedEvent(source.pi, 500));

      const fits = paymentGateway.openDispute(source.pi, 1_500, { withdraw: true });
      await sync(fits, "charge.dispute.created");
      expect(rowSummary(await disputeRows(fits))).toEqual([
        `DISPUTE_FEE:${DISPUTE_FEE}`,
        "DISPUTE_WITHDRAWAL:1500",
      ]);
    });

    it("42/46 a dispute withdrawal beyond the remaining principal is flagged and records nothing", async () => {
      const source = await SOURCES.DEPOSIT();
      paymentGateway.createExternalRefund(source.pi, 500);
      await webhookService.process(chargeRefundedEvent(source.pi, 500));

      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      expect(await disputeRows(disputeId)).toHaveLength(0);
      const record = await disputeRecord(disputeId);
      expect(record.correlation).toBe("CORRELATED");
      expect(record.investigationReason).toMatch(/exceed the principal/);
      expect((await query.getDispute(disputeId))?.reconciliationRequired).toBe(true);
      expect(
        await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_RECONCILIATION_REQUIRED"),
      ).toHaveLength(1);
    });

    it("43 a dispute after a full Bookly refund is never accounted on top of it", async () => {
      const source = await SOURCES.DEPOSIT();
      await lifecycleService.cancelByBusiness(
        String(source.ctx.owner._id),
        OWNER,
        String(source.ctx.business._id),
        String(source.bookingId),
        "Staff emergency",
      );
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      expect(await disputeRows(disputeId)).toHaveLength(0);
      expect((await disputeRecord(disputeId)).investigationReason).toMatch(/exceed the principal/);
    });

    it("44 a Bookly refund that succeeds during an open dispute is surfaced as over-returned principal, never re-accounted", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      expect(await disputeRows(disputeId)).toHaveLength(2);

      await lifecycleService.cancelByBusiness(
        String(source.ctx.owner._id),
        OWNER,
        String(source.ctx.business._id),
        String(source.bookingId),
        "Staff emergency",
      );
      await sync(disputeId);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect((await disputeRecord(disputeId)).investigationReason).toMatch(/over-returned/);
      expect(
        await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_RECONCILIATION_REQUIRED"),
      ).toHaveLength(1);
    });

    it("45/47 an external refund during a withdrawn dispute waits for investigation, then converges once the funds are reinstated", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      const refund = paymentGateway.createExternalRefund(source.pi, 500);
      await webhookService.process(refundUpdatedEvent(refund));
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: refund.refundId }).lean().exec(),
      ).toMatchObject({ state: "INVESTIGATION" });

      paymentGateway.reinstateDisputeFunds(disputeId);
      paymentGateway.setDisputeStatus(disputeId, "won");
      await sync(disputeId, "charge.dispute.closed");
      await webhookService.process(refundUpdatedEvent(refund));
      await webhookService.process(refundUpdatedEvent(refund));
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: refund.refundId }).lean().exec(),
      ).toMatchObject({ state: "ACCOUNTED" });
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          idempotencyKey: externalRefundKey(refund.refundId),
        }),
      ).toBe(1);
    });
  });

  // ==========================================================================================
  // PHASE 42 — webhook / polling (48–59)
  // ==========================================================================================

  describe("webhook / polling convergence and FAILED replay", () => {
    it("51/52 polling alone discovers a dispute and an external refund (no webhook ever arrived)", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 1_000, { withdraw: true });
      const refund = paymentGateway.createExternalRefund(source.pi, 400);

      const counts = await recovery.runOnce();
      expect(counts).toMatchObject({ disputesSwept: 1, refundsSwept: 1, errors: 0 });
      expect(await disputeRecord(disputeId)).toMatchObject({
        lastSyncedVia: "POLLING",
        correlation: "CORRELATED",
      });
      expect(rowSummary(await disputeRows(disputeId))).toEqual([
        `DISPUTE_FEE:${DISPUTE_FEE}`,
        "DISPUTE_WITHDRAWAL:1000",
      ]);
      expect(
        await ExternalRefundModel.findOne({ providerRefundId: refund.refundId }).lean().exec(),
      ).toMatchObject({ state: "ACCOUNTED", detectedVia: "POLLING" });
      expect(await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_NEW")).toHaveLength(1);

      // P6-I17 the late webhook and a later backstop resync converge on the same partial
      // withdrawal (it would still fit the principal, so only movement identity prevents a
      // duplicate).
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      await webhookService.process(refundUpdatedEvent(refund));
      await PaymentDisputeModel.updateOne(
        { providerDisputeId: disputeId },
        { $set: { lastSyncedAt: new Date(Date.now() - 60 * 60_000) } },
      ).exec();
      expect((await recovery.runOnce()).disputesResynced).toBe(1);
      expect(rowSummary(await disputeRows(disputeId))).toEqual([
        `DISPUTE_FEE:${DISPUTE_FEE}`,
        "DISPUTE_WITHDRAWAL:1000",
      ]);
      expect(await externalRefundCount(source.bookingId)).toBe(1);
      expect((await disputeRecord(disputeId)).investigationReason).toBeUndefined();
    });

    it("53/71 webhook vs polling race: one accounting result", async () => {
      const { deposits } = await businessWithDeposits(2);
      const [disputed, refunded] = deposits as [Source, Source];
      const disputeId = paymentGateway.openDispute(disputed.pi, 2_000, { withdraw: true });
      paymentGateway.createExternalRefund(refunded.pi, 400);
      await Promise.all([
        sync(disputeId, "charge.dispute.created"),
        sync(disputeId, "charge.dispute.funds_withdrawn"),
        webhookService.process(chargeRefundedEvent(refunded.pi, 400)),
        webhookService.process(chargeRefundedEvent(refunded.pi, 400)),
        providerReversals.sweepProviderReversals(),
        buildProviderReversals().sweepProviderReversals(),
      ]);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect(await PaymentDisputeModel.countDocuments({})).toBe(1);
      expect(await externalRefundCount(refunded.bookingId)).toBe(1);
      expect(await ExternalRefundModel.countDocuments({})).toBe(1);
    });

    it("54 two recovery workers converge to one accounting result", async () => {
      const { deposits } = await businessWithDeposits(2);
      const [disputed, refunded] = deposits as [Source, Source];
      const disputeId = paymentGateway.openDispute(disputed.pi, 2_000, { withdraw: true });
      paymentGateway.createExternalRefund(refunded.pi, 400);
      await Promise.all([
        buildRecovery(buildProviderReversals()).runOnce(),
        buildRecovery(buildProviderReversals()).runOnce(),
      ]);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect(await PaymentDisputeModel.countDocuments({})).toBe(1);
      expect(await externalRefundCount(refunded.bookingId)).toBe(1);
      expect(await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_NEW")).toHaveLength(1);
      expect(await notifications("FINANCE_SUPPORT_ALERT", "EXTERNAL_REFUND")).toHaveLength(1);
    });

    it("55 a stale webhook after polling converged a final dispute changes nothing", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, {
        withdraw: true,
        status: "lost",
      });
      await recovery.runOnce();
      expect(await disputeRecord(disputeId)).toMatchObject({ final: true, outcome: "LOST" });

      await sync(disputeId, "charge.dispute.created");
      expect(await disputeRecord(disputeId)).toMatchObject({
        final: true,
        outcome: "LOST",
        providerStatus: "lost",
      });
      expect(await disputeRows(disputeId)).toHaveLength(2);
    });

    it("50/58/59 a permanently failed dispute event alerts support; its replay converges without duplicating accounting; completed/leased/unknown events are never replayed", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      const event = disputeEvent("charge.dispute.created", disputeId);

      paymentGateway.failNextDisputeRetrieve();
      await expect(webhookService.process(event)).rejects.toThrow();
      expect(
        await StripeWebhookEventModel.findOne({ eventId: event.id }).lean().exec(),
      ).toMatchObject({
        status: "RETRYABLE",
      });
      // Exhaust the retry budget (the 8th attempt fails too).
      await StripeWebhookEventModel.updateOne(
        { eventId: event.id },
        { $set: { attemptCount: 7, nextAttemptAt: new Date(Date.now() - 1000) } },
      ).exec();
      paymentGateway.failNextDisputeRetrieve();
      expect(await webhookService.recoverDue(5)).toMatchObject({ failed: 1 });
      const failed = await StripeWebhookEventModel.findOne({ eventId: event.id }).lean().exec();
      expect(failed).toMatchObject({ status: "FAILED" });
      expect(failed?.error).toMatch(/Retry limit reached/);
      expect(await notifications("FINANCE_SUPPORT_ALERT", "WEBHOOK_FAILED")).toHaveLength(1);
      expect(await disputeRows(disputeId)).toHaveLength(0);

      const admin = await createAdmin();
      expect(await webhookService.replayEvent(event.id, String(admin._id))).toBe("PROCESSED");
      const replayed = await StripeWebhookEventModel.findOne({ eventId: event.id }).lean().exec();
      expect(replayed).toMatchObject({ status: "PROCESSED", replayCount: 1, eventId: event.id });
      expect(String(replayed?.lastReplayedByUserId)).toBe(String(admin._id));
      expect(await disputeRows(disputeId)).toHaveLength(2);

      // 56 replay after success is a no-op; 59 nothing is ever re-accounted.
      expect(await webhookService.replayEvent(event.id, String(admin._id))).toBe("NOT_FAILED");
      expect(await webhookService.replayEvent("evt_unknown", String(admin._id))).toBe("NOT_FOUND");
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect(await StripeWebhookEventModel.countDocuments({})).toBe(1); // never a new event id
    });

    it("57 replay never bypasses a live processing lease", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000);
      const event = disputeEvent("charge.dispute.created", disputeId);
      expect(
        await eventRepository.claim(event.id, event.type, {
          id: event.id,
          type: event.type,
          data: event.data,
        }),
      ).toBeTruthy();
      const admin = await createAdmin();
      expect(await webhookService.replayEvent(event.id, String(admin._id))).toBe("NOT_FAILED");
      expect(
        await StripeWebhookEventModel.findOne({ eventId: event.id }).lean().exec(),
      ).toMatchObject({
        status: "PROCESSING",
      });
    });

    it("59 replaying a FAILED event whose accounting polling already completed changes nothing", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      const event = disputeEvent("charge.dispute.funds_withdrawn", disputeId);
      paymentGateway.failNextDisputeRetrieve();
      await expect(webhookService.process(event)).rejects.toThrow();
      await StripeWebhookEventModel.updateOne(
        { eventId: event.id },
        { $set: { status: "FAILED", error: "simulated" } },
      ).exec();
      await recovery.runOnce();
      expect(await disputeRows(disputeId)).toHaveLength(2);

      const admin = await createAdmin();
      expect(await webhookService.replayEvent(event.id, String(admin._id))).toBe("PROCESSED");
      expect(await disputeRows(disputeId)).toHaveLength(2);
    });

    it("an uncorrelatable dispute is durable, investigated and never accounted (P6-I3)", async () => {
      const disputeId = paymentGateway.openDispute(await foreignPaymentIntent(), 1_000, {
        withdraw: true,
      });
      await providerReversals.applyDisputeSnapshot(
        await paymentGateway.retrieveDispute(disputeId),
        "POLLING",
      );
      expect(await disputeRecord(disputeId)).toMatchObject({ correlation: "INVESTIGATION" });
      expect(await BookingFinancialTransactionModel.countDocuments({ type: /^DISPUTE_/ })).toBe(0);
      expect(await notifications("FINANCE_SUPPORT_ALERT", "DISPUTE_INVESTIGATION")).toHaveLength(1);
    });
  });

  // ==========================================================================================
  // PHASE 43 — processing-fee backstop (60–65)
  // ==========================================================================================

  describe("processing-fee backstop", () => {
    const age = (bookingId: Types.ObjectId) =>
      BookingFinancialTransactionModel.collection.updateMany(
        { bookingId },
        { $set: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } },
      );
    const feeRows = (pi: string) =>
      BookingFinancialTransactionModel.find({ type: "PROCESSING_FEE", providerReference: pi })
        .lean()
        .exec();

    it("60–65 a lost webhook's processing fee is recovered from the provider exactly once, with its owner preserved", async () => {
      const bookly = await SOURCES.PLATFORM_FEE();
      const business = await SOURCES.DEPOSIT();
      const booklyBefore = await booklyTotals();

      // 60/61 the exact provider fee (never estimated) for a Bookly-owned principal.
      await age(bookly.bookingId);
      paymentGateway.queueNextProcessingFee({ feeCents: 77, currency: "EUR" });
      expect((await recovery.runOnce()).processingFeesRecorded).toBe(1);
      // ... and for a Business-owned one.
      await age(business.bookingId);
      expect((await recovery.runOnce()).processingFeesRecorded).toBe(1);
      expect((await recovery.runOnce()).processingFeesRecorded).toBe(0); // 64 no duplicate

      // 62 exactly one row each, 65 owned by the principal's owner.
      const [booklyFee, ...extraA] = await feeRows(bookly.pi);
      const [businessFee, ...extraB] = await feeRows(business.pi);
      expect([...extraA, ...extraB]).toHaveLength(0);
      expect(booklyFee).toMatchObject({
        amountCents: 77,
        idempotencyKey: `processing-fee:${bookly.pi}`,
      });
      expect(booklyFee?.metadata).toMatchObject({
        sourceType: "PLATFORM_FEE",
        sourceTransactionId: String(bookly.principal._id),
      });
      expect(businessFee).toMatchObject({ amountCents: 55 });
      expect(businessFee?.metadata).toMatchObject({ sourceType: "DEPOSIT" });
      expect((await booklyTotals()).processingFeesCents - booklyBefore.processingFeesCents).toBe(
        77,
      );
      expect(
        (await financeService.getBusinessPayableForSuperAdmin(String(business.ctx.business._id)))
          .processingFeesCents,
      ).toBe(55);

      // 63 the webhook arriving later finds the fee already recorded.
      await webhookService.process(await piSucceededEvent(bookly.pi));
      expect(await feeRows(bookly.pi)).toHaveLength(1);
    });

    it("a young principal (webhook still in its retry window) and an unsettled fee are left alone", async () => {
      const fresh = await SOURCES.PLATFORM_FEE();
      await recovery.runOnce();
      expect(await feeRows(fresh.pi)).toHaveLength(0);

      await age(fresh.bookingId);
      paymentGateway.queueNextProcessingFee(null);
      await providerReversals.reconcileMissingProcessingFees(50);
      expect(await feeRows(fresh.pi)).toHaveLength(0);
      await providerReversals.reconcileMissingProcessingFees(50);
      expect(await feeRows(fresh.pi)).toHaveLength(1);
    });
  });

  // ==========================================================================================
  // PHASE 44 — PROMO_SUBSIDY payout regression (66–69)
  // ==========================================================================================

  describe("PROMO_SUBSIDY payout", () => {
    it("66–69 the preview and the payout claim use the same canonical payable set (legacy PROMO_SUBSIDY included, claimed once)", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(1);
      const deposit = deposits[0] as Source;
      const subsidy = await financialTransactionService.record({
        businessId: ctx.business._id,
        bookingId: deposit.bookingId,
        businessClientId: ctx.client._id,
        customerUserId: ctx.customer._id,
        type: "PROMO_SUBSIDY",
        direction: "CREDIT",
        amountCents: 500,
        currency: "EUR",
        status: "SUCCEEDED",
        idempotencyKey: `legacy-promo-subsidy:${String(deposit.bookingId)}`,
      });
      const preview = await financeService.getBusinessPayableForSuperAdmin(
        String(ctx.business._id),
      );
      expect(preview.netCents).toBe(2_500);
      const pending = await financeService.listPendingPayouts();
      expect(
        pending.items.find((item) => item.businessId === String(ctx.business._id))?.netCents,
      ).toBe(2_500);

      const paid = await payout();
      expect(paid.netPayoutCents).toBe(preview.netCents);
      const claimed = await BookingFinancialTransactionModel.findById(subsidy._id).lean().exec();
      expect(String(claimed?.payoutId)).toBe(String(paid._id));
      await expect(payout()).rejects.toMatchObject({ statusCode: 409 });
      expect(BUSINESS_PAYABLE_TYPES).toContain("PROMO_SUBSIDY");
    });
  });

  // ==========================================================================================
  // PHASE 45 — concurrency (70–77)
  // ==========================================================================================

  describe("concurrency — no duplicate provider-money accounting", () => {
    /** Conservation across a race with a payout claim: what was paid plus what is still payable
     * always equals the Business's total net, and no row is ever claimed twice. */
    const expectConserved = async (businessId: Types.ObjectId, expectedTotal: number) => {
      const paid = await BusinessPayoutModel.find({ businessId }).lean().exec();
      const claimed = paid.flatMap((item) => item.settledTransactionIds.map(String));
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(
        paid.reduce((sum, item) => sum + item.netPayoutCents, 0) + (await payableNet(businessId)),
      ).toBe(expectedTotal);
    };

    it("70 two dispute webhooks at once account each movement once", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await Promise.all([
        sync(disputeId, "charge.dispute.created"),
        sync(disputeId, "charge.dispute.funds_withdrawn"),
        sync(disputeId, "charge.dispute.updated"),
      ]);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect(await notifications("PROVIDER_REVERSAL_BUSINESS", "DISPUTE_OPENED")).toHaveLength(1);
    });

    it("72 dispute withdrawal vs payout claim", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      const disputeId = paymentGateway.openDispute((deposits[0] as Source).pi, 2_000, {
        withdraw: true,
      });
      await Promise.allSettled([sync(disputeId, "charge.dispute.funds_withdrawn"), payout()]);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      await expectConserved(ctx.business._id, 4_000 - 3_500);
    });

    it("73 external refund vs payout claim", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      paymentGateway.createExternalRefund((deposits[0] as Source).pi, 1_000);
      await Promise.allSettled([
        webhookService.process(chargeRefundedEvent((deposits[0] as Source).pi, 1_000)),
        payout(),
      ]);
      await expectConserved(ctx.business._id, 3_000);
    });

    it("74 dispute reinstatement vs payout claim", async () => {
      const { ctx, deposits, payout } = await businessWithDeposits(2);
      const disputeId = paymentGateway.openDispute((deposits[0] as Source).pi, 2_000, {
        withdraw: true,
      });
      await sync(disputeId, "charge.dispute.funds_withdrawn");
      paymentGateway.reinstateDisputeFunds(disputeId);
      await Promise.allSettled([sync(disputeId, "charge.dispute.funds_reinstated"), payout()]);
      expect(await disputeRows(disputeId)).toHaveLength(4);
      await expectConserved(ctx.business._id, 4_000);
    });

    it("75 a Bookly RefundOperation vs provider external-refund detection: never counted as external", async () => {
      const source = await SOURCES.DEPOSIT();
      await Promise.all([
        lifecycleService.cancelByBusiness(
          String(source.ctx.owner._id),
          OWNER,
          String(source.ctx.business._id),
          String(source.bookingId),
          "Staff emergency",
        ),
        providerReversals.reconcileRefundsForPaymentIntent(source.pi, "WEBHOOK"),
        providerReversals.sweepProviderReversals(),
      ]);
      await webhookService.process(chargeRefundedEvent(source.pi, 2_000));
      await recovery.runOnce();
      expect(await ExternalRefundModel.countDocuments({})).toBe(0);
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          bookingId: source.bookingId,
          type: "REFUND",
        }),
      ).toBe(1);
    });

    it("76 dispute update vs support read", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      paymentGateway.setDisputeStatus(disputeId, "lost");
      const [, ...reads] = await Promise.all([
        sync(disputeId, "charge.dispute.closed"),
        query.getDispute(disputeId),
        query.listDisputes({ page: 1, limit: 10 }),
      ]);
      expect(reads).toHaveLength(2);
      const view = await query.getDispute(disputeId);
      expect(view).toMatchObject({ final: true, outcome: "LOST", economicOwner: "BUSINESS" });
      expect(view?.accounting).toMatchObject({
        netLossCents: 2_000 + DISPUTE_FEE,
        unclaimedRowCount: 2,
      });
    });

    it("77 webhook replay vs original processing / recovery", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      const event = disputeEvent("charge.dispute.created", disputeId);
      paymentGateway.failNextDisputeRetrieve();
      await expect(webhookService.process(event)).rejects.toThrow();
      await StripeWebhookEventModel.updateOne(
        { eventId: event.id },
        { $set: { status: "FAILED", error: "simulated" } },
      ).exec();
      const admin = await createAdmin();
      await Promise.allSettled([
        webhookService.replayEvent(event.id, String(admin._id)),
        webhookService.recoverDue(5),
        webhookService.process(event),
      ]);
      await webhookService.recoverDue(5);
      expect(await disputeRows(disputeId)).toHaveLength(2);
      expect(
        await StripeWebhookEventModel.findOne({ eventId: event.id }).lean().exec(),
      ).toMatchObject({
        status: "PROCESSED",
      });
    });
  });

  // ==========================================================================================
  // PHASE 15/16/34/35 — support visibility + authorization
  // ==========================================================================================

  describe("support / Business visibility and authorization", () => {
    const buildApp = () => {
      const app = express();
      app.use(express.json());
      app.use("/super-admin", createSuperAdminRoute());
      app.use("/businesses", createBusinessRoute());
      app.use(createErrorHandler({ isProduction: true }));
      return app;
    };
    const bearer = async (userId: Types.ObjectId, role: "SUPER_ADMIN" | "BUSINESS_OWNER") =>
      `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

    it("Super Admin sees disputes (with accounting + payout effect), external refunds and FAILED webhooks; a Business Owner cannot", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      paymentGateway.createExternalRefund((await SOURCES.DEPOSIT()).pi, 300);
      await recovery.runOnce();
      // A FAILED event whose handler needs no provider call (this route wires the real gateway).
      const failing = {
        id: evtId(),
        type: "setup_intent.succeeded",
        data: { object: { id: "seti_support_replay" } },
      };
      await StripeWebhookEventModel.create({
        eventId: failing.id,
        type: failing.type,
        status: "FAILED",
        attemptCount: 8,
        error: "Retry limit reached: simulated",
        payload: { id: failing.id, type: failing.type, data: failing.data },
      });

      const app = buildApp();
      const admin = await createAdmin();
      const adminAuth = await bearer(admin._id, "SUPER_ADMIN");
      const ownerAuth = await bearer(source.ctx.owner._id, "BUSINESS_OWNER");

      const list = await request(app)
        .get("/super-admin/finance/disputes")
        .set("Authorization", adminAuth);
      expect(list.status).toBe(200);
      const [item] = list.body.data.disputes;
      expect(item).toMatchObject({
        providerDisputeId: disputeId,
        providerPaymentIntentId: source.pi,
        amountCents: 2_000,
        currency: "EUR",
        providerStatus: "needs_response",
        economicOwner: "BUSINESS",
        businessId: String(source.ctx.business._id),
        bookingId: String(source.bookingId),
        reconciliationRequired: false,
        accounting: {
          principalWithdrawnCents: 2_000,
          feeChargedCents: DISPUTE_FEE,
          netLossCents: 3_500,
          unclaimedRowCount: 2,
        },
      });
      expect(item.evidenceDueAt).toBeTypeOf("string");
      expect(item.fundsWithdrawnAt).toBeTypeOf("string");

      const detail = await request(app)
        .get(`/super-admin/finance/disputes/${disputeId}`)
        .set("Authorization", adminAuth);
      expect(detail.status).toBe(200);
      expect(detail.body.data.accounting.rows).toHaveLength(2);
      expect(
        (
          await request(app)
            .get("/super-admin/finance/disputes/dp_missing")
            .set("Authorization", adminAuth)
        ).status,
      ).toBe(404);

      const refundsList = await request(app)
        .get("/super-admin/finance/external-refunds")
        .set("Authorization", adminAuth);
      expect(refundsList.status).toBe(200);
      expect(refundsList.body.data.refunds[0]).toMatchObject({
        refundOrigin: "PROVIDER_EXTERNAL",
        state: "ACCOUNTED",
        amountCents: 300,
      });

      const events = await request(app)
        .get("/super-admin/finance/webhook-events?status=FAILED")
        .set("Authorization", adminAuth);
      expect(events.status).toBe(200);
      expect(events.body.data.events[0]).toMatchObject({
        eventId: failing.id,
        type: "setup_intent.succeeded",
        status: "FAILED",
        attemptCount: 8,
        error: "Retry limit reached: simulated",
        replayable: true,
      });
      expect(events.body.data.events[0].payload).toBeUndefined();

      const replay = await request(app)
        .post(`/super-admin/finance/webhook-events/${failing.id}/replay`)
        .set("Authorization", adminAuth);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ eventId: failing.id, outcome: "PROCESSED" });
      expect(
        (
          await request(app)
            .post(`/super-admin/finance/webhook-events/${failing.id}/replay`)
            .set("Authorization", adminAuth)
        ).status,
      ).toBe(409);

      // Phase 35: a Business Owner can neither read support views nor replay events.
      for (const path of ["/super-admin/finance/disputes", "/super-admin/finance/webhook-events"]) {
        expect((await request(app).get(path).set("Authorization", ownerAuth)).status).toBe(403);
      }
      expect(
        (
          await request(app)
            .post(`/super-admin/finance/webhook-events/${failing.id}/replay`)
            .set("Authorization", ownerAuth)
        ).status,
      ).toBe(403);
      expect(await disputeRows(disputeId)).toHaveLength(2);
    });

    it("a Business Owner sees only reversals its own business bears, without investigation internals", async () => {
      const businessOwned = await SOURCES.DEPOSIT();
      const booklyOwned = await SOURCES.PLATFORM_FEE();
      const ownDispute = paymentGateway.openDispute(businessOwned.pi, 2_000, { withdraw: true });
      const booklyDispute = paymentGateway.openDispute(booklyOwned.pi, 2_000, { withdraw: true });
      await sync(ownDispute, "charge.dispute.created");
      await sync(booklyDispute, "charge.dispute.created");
      await PaymentDisputeModel.updateOne(
        { providerDisputeId: ownDispute },
        { $set: { investigationReason: "internal note" } },
      ).exec();

      const app = buildApp();
      const ownerAuth = await bearer(businessOwned.ctx.owner._id, "BUSINESS_OWNER");
      const own = await request(app)
        .get(`/businesses/${String(businessOwned.ctx.business._id)}/finance/disputes`)
        .set("Authorization", ownerAuth);
      expect(own.status).toBe(200);
      expect(
        own.body.data.disputes.map((d: { providerDisputeId: string }) => d.providerDisputeId),
      ).toEqual([ownDispute]);
      expect(own.body.data.disputes[0]).not.toHaveProperty("investigationReason");

      // The PLATFORM_FEE dispute is Bookly-borne: never shown to (or billed to) its Business.
      const booklyOwnerAuth = await bearer(booklyOwned.ctx.owner._id, "BUSINESS_OWNER");
      const theirs = await request(app)
        .get(`/businesses/${String(booklyOwned.ctx.business._id)}/finance/disputes`)
        .set("Authorization", booklyOwnerAuth);
      expect(theirs.body.data.disputes).toHaveLength(0);

      // Another Owner cannot read this Business's reversals.
      const foreign = await request(app)
        .get(`/businesses/${String(businessOwned.ctx.business._id)}/finance/disputes`)
        .set("Authorization", booklyOwnerAuth);
      expect(foreign.status).toBe(404);
      const foreignRefunds = await request(app)
        .get(`/businesses/${String(businessOwned.ctx.business._id)}/finance/external-refunds`)
        .set("Authorization", booklyOwnerAuth);
      expect(foreignRefunds.status).toBe(404);
    });

    it("notification copy is truthful and never promises an outcome", async () => {
      const source = await SOURCES.DEPOSIT();
      const disputeId = paymentGateway.openDispute(source.pi, 2_000, { withdraw: true });
      await sync(disputeId, "charge.dispute.created");
      const [opened] = await EmailOutboxModel.find({
        templateKey: "PROVIDER_REVERSAL_BUSINESS",
        "payload.kind": "DISPUTE_OPENED",
      })
        .lean()
        .exec();
      const text = renderEmailTemplate("PROVIDER_REVERSAL_BUSINESS", opened?.payload).text;
      expect(text).toContain("€20.00");
      expect(text).toContain("not decided");
      expect(opened?.recipient).toBe(source.ctx.owner.normalizedEmail);
      const customerMail = await EmailOutboxModel.countDocuments({
        recipient: source.ctx.customer.normalizedEmail,
        templateKey: { $in: ["PROVIDER_REVERSAL_BUSINESS", "FINANCE_SUPPORT_ALERT"] },
      });
      expect(customerMail).toBe(0);
    });
  });

  // ==========================================================================================
  // PHASE 21 — non-FIRST Session 2+ extras unsent closure
  // ==========================================================================================

  describe("Session 2+ extras with no PaymentIntent", () => {
    it("a stale unsent extras attempt is strongly proven absent and closed; its same-key retry gets the existing 'expired' answer", async () => {
      const ctx = await firstBooking();
      const key = `extras-unsent-${new Types.ObjectId().toString()}`;
      const metadata = buildPaymentIntentMetadata({
        bookingId: new Types.ObjectId().toString(),
        businessId: String(ctx.business._id),
        businessClientId: String(ctx.client._id),
        purpose: "PACKAGE_SESSION_EXTRAS",
        preTaxChargeCents: 1_500,
        taxCents: 0,
        chargedAmountCents: 1_500,
        taxMode: "PRE_ACTIVATION",
      });
      paymentGateway.queueNextChargeThrowBeforeCreate();
      await expect(
        paymentService.chargeBookingDeposit({
          userId: ctx.customer._id,
          amountCents: 1_500,
          idempotencyKey: key,
          metadata,
        }),
      ).rejects.toBeDefined();
      const attempt = await PaymentAttemptModel.findOne({ logicalIdempotencyKey: key })
        .orFail()
        .lean()
        .exec();
      expect(attempt.purpose).toBe("PACKAGE_SESSION_EXTRAS");
      expect(attempt.providerPaymentIntentId).toBeUndefined();

      // Still inside the in-flight window: untouched.
      await recovery.runOnce();
      expect(
        (await PaymentAttemptModel.findById(attempt._id).orFail().lean().exec()).lastErrorCode,
      ).not.toBe(PROVIDER_NOT_CREATED);

      const old = new Date(Date.now() - 60 * 60_000);
      await PaymentAttemptModel.collection.updateOne(
        { _id: attempt._id },
        { $set: { createdAt: old }, $unset: { nextRecoveryAt: "" } },
      );
      const calls = paymentGateway.customerListCalls;
      const counts = await recovery.runOnce();
      expect(counts.staleSessionExtrasUnsent).toBe(1);
      expect(paymentGateway.customerListCalls).toBeGreaterThan(calls);
      expect(await PaymentAttemptModel.findById(attempt._id).orFail().lean().exec()).toMatchObject({
        providerStatus: "FAILED",
        lastErrorCode: PROVIDER_NOT_CREATED,
      });

      const created = paymentGateway.createdPaymentIntentIds().length;
      await expect(
        paymentService.chargeBookingDeposit({
          userId: ctx.customer._id,
          amountCents: 1_500,
          idempotencyKey: key,
          metadata,
        }),
      ).rejects.toMatchObject({ statusCode: 402 });
      expect(paymentGateway.createdPaymentIntentIds()).toHaveLength(created); // no second charge
    });

    it("an extras attempt whose PaymentIntent exists is recorded, never closed", async () => {
      const ctx = await firstBooking();
      const key = `extras-lost-${new Types.ObjectId().toString()}`;
      const metadata = buildPaymentIntentMetadata({
        bookingId: new Types.ObjectId().toString(),
        businessId: String(ctx.business._id),
        businessClientId: String(ctx.client._id),
        purpose: "PACKAGE_SESSION_EXTRAS",
        preTaxChargeCents: 1_500,
        taxCents: 0,
        chargedAmountCents: 1_500,
        taxMode: "PRE_ACTIVATION",
      });
      paymentGateway.queueNextChargeLostResponse();
      await expect(
        paymentService.chargeBookingDeposit({
          userId: ctx.customer._id,
          amountCents: 1_500,
          idempotencyKey: key,
          metadata,
        }),
      ).rejects.toBeDefined();
      const attempt = await PaymentAttemptModel.findOne({ logicalIdempotencyKey: key })
        .orFail()
        .lean()
        .exec();
      expect(attempt.providerPaymentIntentId).toBeUndefined();
      await PaymentAttemptModel.collection.updateOne(
        { _id: attempt._id },
        { $set: { createdAt: new Date(Date.now() - 60 * 60_000) }, $unset: { nextRecoveryAt: "" } },
      );
      await recovery.runOnce();
      const after = await PaymentAttemptModel.findById(attempt._id).orFail().lean().exec();
      expect(after.providerPaymentIntentId).toBe(paymentGateway.createdPaymentIntentIds().at(-1));
      expect(after.lastErrorCode).not.toBe(PROVIDER_NOT_CREATED);
    });
  });
});
