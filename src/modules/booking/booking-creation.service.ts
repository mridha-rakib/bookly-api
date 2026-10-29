import mongoose, { type ClientSession, Types } from "mongoose";
import type { AppointmentReminderSchedulingPort } from "../appointment-reminder/appointment-reminder-scheduler.js";
import { AvailabilityError } from "../availability/availability.errors.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import {
  type BookingFinancialTransactionDocument,
  BookingFinancialTransactionModel,
} from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../booking-slot-reservation/booking-slot-reservation.model.js";
import type { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import {
  type BusinessCity,
  businessCities,
  normalizeBusinessVisitType,
} from "../business/business.types.js";
import type { BusinessCancellationPolicyRepository } from "../business-cancellation-policy/business-cancellation-policy.repository.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { BusinessClientDocument } from "../client/client.model.js";
import type { ClientRepository } from "../client/client.repository.js";
import { FinancialRelationshipRepository } from "../client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import type { IntegrationService } from "../integration/integration.service.js";
import type { BookingCreatedPaymentEvidence } from "../notification/booking-created.notifier.js";
import {
  buildPackageFulfilmentEntitlement,
  resolvePackageFulfilmentEntitlement,
} from "../package-progress/package-fulfilment-entitlement.js";
import { PackageProgressError } from "../package-progress/package-progress.errors.js";
import type {
  PackageFulfilmentEntitlement,
  PackageProgressDocument,
} from "../package-progress/package-progress.model.js";
import type {
  CreatePackageProgressInput,
  PackageProgressRepository,
} from "../package-progress/package-progress.repository.js";
import { computePackageBalanceSettlement } from "../package-progress/package-progress.rules.js";
import { PaymentError } from "../payment/payment.errors.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { PaymentIntentResult } from "../payment/payment.types.js";
import { isProviderCreationClosed, PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import {
  buildPaymentIntentMetadata,
  type PaymentIntentPurpose,
} from "../payment/payment-intent-metadata.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { TaxError } from "../payment/tax.errors.js";
import type { ComputedTax, CyprusTaxService } from "../payment/tax.service.js";
import { resolveBusinessCategoryKey } from "../platform-settings/business-category.js";
import type { PlatformSettingsService } from "../platform-settings/platform-settings.service.js";
import type { PromoApplicationService, ResolvedPromo } from "../promo/promo-application.service.js";
import type { ServiceDocument } from "../services/service.model.js";
import type { StaffMembershipDocument } from "../staff/staff.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserRole } from "../user/user.types.js";
import { BookingError } from "./booking.errors.js";
import type {
  BookingActor,
  BookingCancellationPolicySnapshot,
  BookingCustomer,
  BookingDocument,
  BookingFinancials,
  BookingFulfilment,
  BookingNoShowEligibilitySnapshot,
  BookingServiceLine,
  BookingServiceLineAddon,
  BookingSessionEndReminderSnapshot,
} from "./booking.model.js";
import { BookingModel } from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";
import type { BookingService } from "./booking.service.js";
import type { BookingActorRole, BookingSource } from "./booking.types.js";
import { generateBookingReference } from "./booking.utils.js";
import type { CreateBookingInput, CreateManualBookingInput } from "./booking-creation.types.js";
import type { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";
import { resolveCustomerBusinessClient } from "./booking-customer-client.js";
import { type BookingPaymentState, bookingPaymentState } from "./booking-payment-status.js";
import {
  acquireSchedulingAdmission,
  validateSchedulingLine,
} from "./booking-scheduling-admission.js";
import {
  calculateFirstUpfrontCents,
  FINANCIAL_CONTRACT_V2,
  FINANCIAL_CONTRACT_V3,
  type FinancialContract,
  type FinancialContractProductKind,
  type FinancialContractVersion,
  findFinancialContractMismatch,
  type RelationshipClassification,
} from "./financial-contract.js";
import type { OrdinaryCalendarJournalPort } from "./ordinary-calendar-journal.js";

type CustomerReplayScope = {
  businessId: Types.ObjectId;
  customerUserId: string;
  idempotencyKey: string;
  kind: FinancialContractProductKind | "PACKAGE_REDEMPTION";
  packageProgressId?: Types.ObjectId;
};

class BookingPersistenceUnresolvedError extends BookingError {
  constructor() {
    super("BOOKING_TRANSACTION_UNAVAILABLE", 503);
  }
}

/**
 * Stage B mailing observer for Triggers 2/3/4. Optional + trailing so every existing
 * construction site is unchanged.
 *
 * F4A Tier 2: the confirmation intent is written INSIDE the Booking transaction via
 * `enqueueBookingCreatedInTransaction` (see recordBookingCreatedIntent). Its outbox insert
 * failure throws and aborts the transaction (Owner decision O1). `notifyBookingCreated` is the
 * legacy best-effort entry point and is no longer called from the post-commit tail (O2).
 */
export type BookingCreatedNotificationPort = {
  notifyBookingCreated(booking: BookingDocument, business: BusinessDocument): Promise<void>;
  enqueueBookingCreatedInTransaction(
    booking: BookingDocument,
    business: BusinessDocument,
    session: ClientSession,
    payment?: BookingCreatedPaymentEvidence,
  ): Promise<void>;
};

const REFERENCE_GENERATION_MAX_ATTEMPTS = 5;
const IDEMPOTENCY_CLAIM_POLL_ATTEMPTS = 6;
const IDEMPOTENCY_CLAIM_POLL_DELAY_MS = 40;

type ResolvedServiceLine = {
  service: ServiceDocument;
  staffMembership: StaffMembershipDocument;
  serviceSnapshot: BookingServiceLine["serviceSnapshot"];
  staffSnapshot: BookingServiceLine["staffSnapshot"];
  pricingInput: BookingServiceLine["pricingInput"];
  addons: BookingServiceLineAddon[];
  amountCents: number;
  discountCents: number;
  capacityMax: number;
  partySize: number;
  endAt: Date;
};

export type BookingCreationPreview = {
  finalizable: true;
  isFirstBooking: boolean;
  business: { id: string; name: string; timezone: string };
  schedule: { timezone: string; startAt: string; endAt: string };
  fulfilment: BookingFulfilment;
  serviceLines: Array<{
    serviceId: string;
    staffMembershipId: string;
    serviceSnapshot: BookingServiceLine["serviceSnapshot"];
    staffSnapshot: BookingServiceLine["staffSnapshot"];
    addons: BookingServiceLineAddon[];
    amountCents: number;
  }>;
  financials: BookingFinancials;
  /** C2 customer-disclosure contract. These four integer-cent values are one atomic,
   * server-authoritative quote: the client formats them but never calculates between them. */
  preTaxChargeCents: number;
  taxCents: number;
  dueNowCents: number;
  balanceDueCents: number;
  requiresSavedCard: boolean;
  hasSavedCard: boolean;
  /** Present only when a valid `promoCode` was supplied. P2: the promo discounts the booking
   * PRICE — `financials` (total, deposit, balance) and `preTaxChargeCents` above are already
   * post-promo; this breakdown lets the frontend show the price before the promo and the
   * discount without recomputing anything in React. */
  promo?: {
    code: string;
    type: "PERCENTAGE" | "FIXED";
    value: number;
    /** services + add-ons − service discount, before the promo (travel excluded). */
    promoEligibleBaseCents: number;
    discountCents: number;
  };
};

export type PackageRedemptionPreview = {
  finalizable: true;
  taxMode: "PRE_ACTIVATION";
  fulfilment: BookingFulfilment;
  packageBaseCents: 0;
  addonsSubtotalCents: number;
  travelFeeCents: number;
  subtotalCents: number;
  totalCents: number;
  depositCents: number;
  customerChargeNowCents: number;
  balanceDueCents: number;
  currency: "EUR";
  requiresSavedCard: boolean;
  hasSavedCard: boolean;
};

type PackageRedemptionSelections = {
  addonIds?: string[] | undefined;
  travelAddress?: CreateBookingInput["travelAddress"];
  customerCity?: CreateBookingInput["customerCity"];
};

type PackageRedemptionPricingContext = {
  business: BusinessDocument;
  progress: PackageProgressDocument;
  originBooking: BookingDocument;
  service: ServiceDocument;
  fulfilmentEntitlement: PackageFulfilmentEntitlement;
  fulfilment: BookingFulfilment;
  addons: BookingServiceLineAddon[];
  financials: BookingFinancials;
};

/** P1 — the authoritative classification-derived money terms for one logical operation. */
type EstablishedFinancialTerms = {
  financials: BookingFinancials;
  resolvedPromo: ResolvedPromo | undefined;
  contract: FinancialContract;
};

export type FinalizeBookingResult =
  | { status: "confirmed"; booking: BookingDocument; computedTax?: ComputedTax }
  | { status: "requires_action"; clientSecret: string; paymentIntentId: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Booking-creation-time-only coordinate snapshot guard — a finite lat/lng within real
 * geographic ranges, never fabricated/coerced. Same validation as discovery.repository.ts's and
 * catalog.dto.ts's own local `validLocation` (kept local here too, matching this codebase's
 * existing per-module convention rather than a shared util). Called exactly once, at the moment
 * a Booking's fulfilment snapshot is built — never again afterward, so a later change to
 * `business.location` can never reach an already-created Booking. */
const resolveValidCoordinate = (
  location: BusinessDocument["location"],
): { lat: number; lng: number } | undefined => {
  if (!location) return undefined;
  const { lat, lng } = location;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return undefined;
  }
  return { lat, lng };
};

/**
 * Batch 3's central orchestration: composes AvailabilityService's write-time re-validation
 * (assertSlotIsBookable / requireServedCity), BookingSlotReservationService's atomic occupancy
 * claim, and BookingService's Batch 1 validation building blocks (never duplicated) into one
 * atomic Booking-creation transaction.
 *
 * MULTI-LINE TIMING: BookingSchedule has exactly one root {timezone, startAt, endAt} — there is
 * no per-line timing field anywhere in the schema (see BookingServiceLine's own comment). Rather
 * than inventing a parallel per-line timing model, every line in one Booking shares the SAME
 * `startAt`; the Booking's own `schedule.endAt` is the MAXIMUM of each line's own computed end
 * (duration+buffer+processing from that line's OWN Service config — no invented data), i.e.
 * every line's provider works on their own line in PARALLEL starting at the same instant. Each
 * line still reserves its OWN [startAt, thatLine'sOwnEndAt) interval against its OWN Staff
 * member's occupancy — a line's own reservation never blocks that Staff member beyond what their
 * own line actually occupies. If two lines happen to name the SAME Staff member, the second
 * line's reservation attempt collides with the first's inside the SAME transaction (the
 * reservation collection's own overlap-safe filter — see booking-slot-reservation.model.ts — is
 * fully session-aware) and the whole Booking-creation transaction fails cleanly; this is the
 * correct outcome (one person cannot provide two simultaneous lines) and needed no special-case
 * code to get right.
 *
 * ATOMICITY: `createManualBooking` is the only path in this batch that actually persists a
 * Booking (see PAYMENT-GATING below for why). It never does "check availability, then create
 * reservations, then create the Booking" as three independent writes — the idempotency claim is
 * pinned first (outside the transaction, see booking-creation-claim.model.ts), then every
 * reservation claim AND the Booking document itself are written inside ONE MongoDB transaction
 * (`dbSession.withTransaction`, the exact pattern staff.service.ts's Staff-creation flow already
 * established). If ANY step fails — a reservation conflict on any line, a validation error, a
 * transient transaction error — the whole transaction aborts: no partial reservations, no
 * Booking with a missing line, no orphaned occupancy. The idempotency claim itself is then
 * explicitly released (deleted) on failure so a genuinely-failed attempt never permanently
 * "poisons" that idempotency key for a real retry — matching the reservation module's own
 * "a failed reservation must not create a Booking" discipline, extended one level up.
 *
 * PAYMENT-GATING (resolved in Batch 4 — see the Batch 3 final report for why it was deferred,
 * and the Batch 4 final report for exactly how it is resolved here): `UPCOMING` is this
 * codebase's confirmed "the customer is expected to actually show up" status. A MANUAL Booking
 * has no payment concept at all (fee/deposit=0 by construction — rule E), so `UPCOMING` never
 * implied "paid" for one. A BOOKLY_MANAGED Customer Booking only ever reaches `UPCOMING` AFTER
 * its required upfront payment (if any) has genuinely succeeded. P3: only a FIRST purchase
 * (normal booking or package purchase — one shared customer↔business relationship) carries an
 * online upfront; every RETURNING purchase is €0 online with the full total payable at the
 * venue, yet still requires a verified saved card (cancellation/no-show policy). See
 * `finalizeCustomerBooking`'s own doc comment and BookingFinancials's own doc comment.
 * `previewCustomerBooking` remains a read-only, side-effect-free, Customer-aware quote of the
 * ACTUAL amount due now and never persists anything.
 */
export class BookingCreationService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly bookingService: BookingService,
    private readonly availabilityService: AvailabilityService,
    private readonly reservationService: BookingSlotReservationService,
    private readonly businessTravelSettingsRepository: BusinessTravelSettingsRepository,
    private readonly businessCancellationPolicyRepository: BusinessCancellationPolicyRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly claimRepository: BookingCreationClaimRepository,
    private readonly userRepository: UserRepository,
    private readonly clientRepository: ClientRepository,
    private readonly paymentService: PaymentService,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly promoApplicationService: PromoApplicationService,
    // Optional (like BusinessService's own trailing optional deps) so the many existing
    // integration test suites that construct this service directly, without Google Calendar in
    // scope, don't all need updating just to pass a mock — see syncBookingCreatedToGoogleCalendar.
    private readonly integrationService?: Pick<IntegrationService, "createEventForBooking">,
    // Optional trailing dep (same rationale). When absent, max-services falls back to the
    // structural Zod ceiling only and no noShowEligibilitySnapshot is written (legacy
    // behavior) — a safe no-op for the pre-existing test suites.
    private readonly platformSettingsService?: Pick<
      PlatformSettingsService,
      "getMaxServicesPerBooking" | "resolveNoShowWindow"
    >,
    // Optional trailing dep (same rationale as integrationService above). Stage B mailing:
    // writes booking-creation notifications inside the Booking transaction (F4A Tier 2). Absent
    // in the many integration suites that construct this service directly — a safe no-op there.
    private readonly bookingCreatedNotifier?: BookingCreatedNotificationPort,
    // Optional trailing dep (same rationale). Appointment reminders: schedules the 24h reminder
    // row from the post-commit tail. Best-effort, never throws — a reminder problem can never
    // roll back a committed booking. Absent in suites that construct this service directly.
    private readonly appointmentReminderScheduler?: AppointmentReminderSchedulingPort,
    // Optional trailing dep (same rationale) — required only by the three Package-purchase/
    // redemption methods below (previewPackagePurchase/finalizePackagePurchase/
    // redeemPackageSession). Absent in every pre-existing suite that constructs this service
    // directly without exercising Package Deals.
    private readonly packageProgressRepository?: PackageProgressRepository,
    // Optional trailing dep (same rationale as every other optional dep above — the many
    // pre-existing integration test suites that construct this service directly, without VAT in
    // scope, must keep working unmodified). Checkpoint B (Cyprus VAT, compute-only): when
    // present, every customer-facing charge point below also COMPUTES (never charges) Cyprus VAT
    // via Stripe Tax. Absent in production would be a real bug — booking.route.ts's composition
    // root always wires the real CyprusTaxService; optionality here exists purely for
    // test-construction compatibility, matching this constructor's existing pattern.
    private readonly taxService?: Pick<CyprusTaxService, "computeForCharge">,
    // P1 — the customer↔business financial relationship (the ONLY first/returning authority).
    // Optional trailing dep for the same test-construction reason as every dep above; when
    // absent it is assembled from the same repositories, so no construction site can end up
    // classifying from a different source.
    financialRelationshipService?: FinancialRelationshipService,
    // P4B-2A — durable ordinary Calendar desired state, written in the Booking transaction.
    // Optional trailing dep; absent in suites that construct this service directly.
    private readonly ordinaryCalendarJournal?: OrdinaryCalendarJournalPort,
  ) {
    this.relationships =
      financialRelationshipService ??
      new FinancialRelationshipService(
        new FinancialRelationshipRepository(),
        new PaymentAttemptRepository(),
        new RefundOperationRepository(),
        bookingRepository,
        claimRepository,
        clientRepository,
      );
  }

  private readonly relationships: FinancialRelationshipService;

  /**
   * Checkpoint B (Cyprus VAT, compute-only) — the single call site every customer-facing charge
   * point below goes through. Returns `undefined` (never a guessed zero) when no `taxService` was
   * injected — the many pre-existing test suites that construct this class directly without VAT
   * in scope. `amountCents` must already be the final, canonical online charge amount
   * (`customerChargeNowCents` — post-clamp, post-promo); this never re-derives it. Propagates
   * `TaxError` untouched for a positive amount Stripe Tax fails to calculate — the caller must
   * never proceed as though the booking were tax-free (locked rule: never invent VAT).
   */
  private async computeCyprusTax(
    amountCents: number,
    reference: string,
    idempotencyKey?: string | undefined,
  ): Promise<ComputedTax | undefined> {
    if (!this.taxService) {
      return undefined;
    }
    return this.taxService.computeForCharge({ amountCents, reference, idempotencyKey });
  }

  /** Maps the one accepted Stripe Tax result into C2's public preview vocabulary. Production
   * always wires `taxService`; failing when it is absent prevents a positive-charge preview from
   * silently masquerading as VAT-free. `dueNowCents` is Stripe's `amount_total` verbatim. */
  private toPreviewFinancialCommitment(
    preTaxChargeCents: number,
    balanceDueCents: number,
    computedTax: ComputedTax | undefined,
  ): Pick<
    BookingCreationPreview,
    "preTaxChargeCents" | "taxCents" | "dueNowCents" | "balanceDueCents"
  > {
    if (!computedTax || computedTax.preTaxAmountCents !== preTaxChargeCents) {
      throw new TaxError("TAX_CALCULATION_FAILED", 502);
    }
    return {
      preTaxChargeCents: computedTax.preTaxAmountCents,
      taxCents: computedTax.taxCents,
      dueNowCents: computedTax.dueNowWithTaxCents,
      balanceDueCents,
    };
  }

  /**
   * Product-limit enforcement for how many service lines one booking may contain — the
   * server-authoritative check (the structural Zod `serviceLines.max(...)` is only an abuse
   * ceiling). Applied on EVERY creation path (manual, customer preview, customer finalize).
   * No-ops when platform settings are unavailable (legacy/test construction).
   */
  private async enforceMaxServicesPerBooking(lineCount: number): Promise<void> {
    if (!this.platformSettingsService) {
      return;
    }
    const max = await this.platformSettingsService.getMaxServicesPerBooking();
    if (lineCount > max) {
      throw new BookingError("BOOKING_TOO_MANY_SERVICE_LINES", 400, [
        {
          message: `A booking may include at most ${max} service${max === 1 ? "" : "s"}`,
          code: "BOOKING_TOO_MANY_SERVICE_LINES",
        },
      ]);
    }
  }

  /**
   * Booking-time snapshot of the no-show eligibility window (see
   * BookingNoShowEligibilitySnapshot). Returns undefined — preserving legacy status-only
   * markNoShow behavior — when platform settings are unavailable or the Business category
   * cannot be safely resolved to a canonical key.
   */
  private async resolveNoShowEligibilitySnapshot(
    business: BusinessDocument,
  ): Promise<BookingNoShowEligibilitySnapshot | undefined> {
    if (!this.platformSettingsService) {
      return undefined;
    }
    const categoryKey = business.categoryKey ?? resolveBusinessCategoryKey(business.category);
    if (!categoryKey) {
      return undefined;
    }
    const window = await this.platformSettingsService.resolveNoShowWindow(categoryKey);
    return {
      categoryKey,
      opensAfterMinutes: window.opensAfterMinutes,
      closesAfterMinutes: window.closesAfterMinutes,
    };
  }

  /**
   * Booking-time snapshot of Service.sessionExpiryAlert (see
   * BookingSessionEndReminderSnapshot's own doc comment) — ALWAYS taken, even when `enabled` is
   * false, so a legacy Booking (no snapshot at all) stays unambiguously distinguishable from a
   * new Booking whose alert simply happens to be off. Never re-derived from the live Service
   * later. A multi-line booking has one root `schedule.endAt` shared by every line (see
   * booking.model.ts); the line that actually ends at that instant is the one whose setting
   * governs the whole Booking's reminder — ties/first match wins deterministically.
   */
  private buildSessionEndReminderSnapshot(
    lines: ResolvedServiceLine[],
    overallEndAt: Date,
  ): BookingSessionEndReminderSnapshot {
    const governingLine =
      lines.find((line) => line.endAt.getTime() === overallEndAt.getTime()) ?? lines[0];
    const alert = (governingLine as ResolvedServiceLine).service.sessionExpiryAlert;
    return {
      enabled: alert.enabled,
      ...(alert.minutesBeforeSessionEnds !== undefined
        ? { minutesBeforeSessionEnds: alert.minutesBeforeSessionEnds }
        : {}),
    };
  }

  // --- Manual (real, persisted) --------------------------------------------------------------

  public async createManualBooking(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    input: CreateManualBookingInput,
  ): Promise<BookingDocument> {
    this.requireIdempotencyKey(input.idempotencyKey);

    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const existingClaim = await this.claimRepository.findForCustomerReplay(
      input.idempotencyKey,
      business._id,
      actorUserId,
    );
    if (existingClaim)
      return this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey, manualActorUserId: actorUserId },
        existingClaim.bookingId,
      );
    await this.enforceMaxServicesPerBooking(input.serviceLines.length);
    const client = await this.bookingService.validateCustomerReference(
      business,
      input.businessClientId,
    );

    const startAt = this.parseStartAt(input.startAt);
    const lines = await this.resolveServiceLines(business, startAt, input);
    const fulfilment = await this.resolveFulfilment(business, input);
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      lines,
      input.customerCity,
    );
    // A MANUAL booking never touches the customer↔business financial relationship (it can never
    // claim or consume first status) and carries no Bookly fee/deposit — rule E.
    const financials = this.assembleFinancials("MANUAL", lines, travelFeeCents);
    this.bookingService.validateManualBookingHasNoBooklyFee("MANUAL", {
      platformFeeCents: financials.platformFeeCents,
      depositCents: financials.depositCents,
    });

    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(actorUserId),
      actorRole: actorRole as BookingActorRole,
    };

    return this.persistBooking({
      business,
      source: "MANUAL",
      customer,
      createdBy,
      fulfilment,
      lines,
      financials,
      cancellationPolicySnapshot,
      noShowEligibilitySnapshot,
      startAt,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
      actorUserId,
    });
  }

  // --- Customer: read-only quote -------------------------------------------------------------

  /**
   * A real, side-effect-free quote — Customer-aware (unlike Batch 3's version) so it can show
   * the ACTUAL amount due now: the FIRST upfront (20%, €5 floor, €35 cap, never above the
   * basis) for a first purchase, €0 for a RETURNING one (P3). Never reserves or persists
   * anything; `finalizeCustomerBooking` is the only path that does.
   */
  public async previewCustomerBooking(
    customerUserId: string,
    businessId: string,
    input: CreateBookingInput,
  ): Promise<BookingCreationPreview> {
    const business = await this.requireBusiness(businessId);
    await this.enforceMaxServicesPerBooking(input.serviceLines.length);

    const startAt = this.parseStartAt(input.startAt);
    const lines = await this.resolveServiceLines(business, startAt, input);
    const fulfilment = await this.resolveFulfilment(business, input);
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      lines,
      input.customerCity,
    );

    const existingClient = await this.clientRepository.findByBusinessIdAndLinkedUserId(
      business._id,
      customerUserId,
    );
    // P1 — a read-only ESTIMATE from the same relationship authority finalize claims against
    // (never `activatedAt` directly); finalize remains authoritative.
    const classification = this.relationships.peekClassification(existingClient);
    const isFirstBooking = classification === "FIRST";

    // P2 — read-only, side-effect-free promo preview: the promo discounts the booking price
    // BEFORE the upfront is computed (same calculation finalize uses), but never claims a
    // redemption — see PromoApplicationService's own doc comment. A retried/duplicate preview
    // call can never consume usage.
    const resolvedPromo = input.promoCode
      ? await this.promoApplicationService.resolve({
          code: input.promoCode,
          business,
          customerUserId,
          isFirstBooking,
          promoEligibleBaseCents: this.assembleFinancials("BOOKLY_MANAGED", lines, travelFeeCents)
            .eligiblePlatformFeeBasisCents,
        })
      : undefined;
    const { financials } = this.assembleCustomerFinancials(
      lines,
      travelFeeCents,
      classification,
      undefined,
      resolvedPromo?.promoDiscountCents,
    );
    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);

    const overallEndAt = lines.reduce(
      (max, line) => (line.endAt > max ? line.endAt : max),
      lines[0]?.endAt ?? startAt,
    );

    // Checkpoint B (Cyprus VAT, compute-only) — the SAME canonical amount the customer would
    // actually be charged (P2: the upfront on the promo-discounted price). Read-only, like the
    // rest of this preview: no PaymentIntent, no persistence, and (per this checkpoint's own
    // scope) the ACTUAL PaymentIntent amount in finalize remains this same pre-tax value.
    const customerChargeNowCents = financials.depositCents;
    const computedTax = await this.computeCyprusTax(
      customerChargeNowCents,
      `preview-${new Types.ObjectId().toHexString()}`,
    );
    const financialCommitment = this.toPreviewFinancialCommitment(
      customerChargeNowCents,
      financials.balanceDueCents,
      computedTax,
    );

    return {
      finalizable: true,
      isFirstBooking,
      business: { id: String(business._id), name: business.name, timezone: business.timezone },
      schedule: {
        timezone: business.timezone,
        startAt: startAt.toISOString(),
        endAt: overallEndAt.toISOString(),
      },
      fulfilment,
      serviceLines: lines.map((line) => ({
        serviceId: String(line.service._id),
        staffMembershipId: String(line.staffMembership._id),
        serviceSnapshot: line.serviceSnapshot,
        staffSnapshot: line.staffSnapshot,
        addons: line.addons,
        amountCents: line.amountCents,
      })),
      financials,
      // Batch 6.5: the amount actually charged online is ALWAYS the deposit, first booking or
      // returning — never platformFeeCents, which is 0 for a returning customer even though a
      // real deposit is still due (see BookingFinancials's own doc comment). P2: with a promo,
      // that deposit is computed from the promo-discounted price.
      ...financialCommitment,
      requiresSavedCard: true,
      hasSavedCard: cardStatus.hasSavedCard,
      ...(resolvedPromo
        ? {
            promo: {
              code: resolvedPromo.promo.code,
              type: resolvedPromo.promo.type,
              value: resolvedPromo.promo.value,
              promoEligibleBaseCents: resolvedPromo.promoEligibleBaseCents,
              discountCents: resolvedPromo.promoDiscountCents,
            },
          }
        : {}),
    };
  }

  // --- Customer: real finalize (Batch 4) -----------------------------------------------------

  /**
   * The real Customer BOOKLY_MANAGED persistence path (resolves the PAYMENT-GATING deferral —
   * see this class's own module doc comment). Sequence, matching the confirmed saga design (see
   * the Batch 4 final report's own "First-booking payment flow" section, corrected by Batch 6.5
   * for deposit-vs-platform-fee — see BookingFinancials's own doc comment):
   *
   *  1. Fast idempotent-retry check (BEFORE any payment) — a retried/duplicate request with a
   *     claim already on file resolves to that claim's Booking, never re-charges.
   *  2. Resolve/validate everything read-only: service lines, fulfilment, travel eligibility,
   *     the Customer's BusinessClient row (see resolveOrCreateCustomerClient — this is exactly
   *     the gap Batch 3 flagged and deferred for TRAVEL_TO_CUSTOMER; AT_BUSINESS_LOCATION with
   *     no existing Client row remains a genuine, still-unresolved product gap — see the report).
   *  3. Require a saved card regardless of classification or amount (confirmed rule:
   *     "returning customers also need a saved card" — P3 keeps it for a €0 RETURNING
   *     purchase: the card backs the cancellation/no-show policy).
   *  4. Claim the idempotency key (pre-generated bookingId, same pattern as Batch 3's
   *     `persistBooking`).
   *  5. P1 — establishFinancialTerms: atomically claim/resume the customer↔business first
   *     relationship (ELIGIBLE -> FIRST_PENDING) BEFORE any money moves, or classify RETURNING
   *     from a CONSUMED relationship; a competing unresolved first operation gets
   *     BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS with nothing charged. Then record the immutable
   *     Financial Contract (V3 normal / V2 package) on the claim (a resumed operation must match
   *     it or fail closed — a pre-P3 RETURNING deposit contract therefore never resumes as €0).
   *  6. Whenever the contract's online charge is nonzero (FIRST only — a RETURNING purchase is
   *     €0 online since P3: no PaymentIntent, no PaymentAttempt): charge it ON-session, saving the card
   *     for future off-session use in the same call. A FIRST charge binds its PaymentAttempt to
   *     the relationship claim before dispatch. `requires_action` retains the claim, the durable
   *     PaymentAttempt and FIRST_PENDING, returns a clientSecret for 3DS, then the same
   *     idempotencyKey resumes the same PaymentIntent and first claim. A definitive failure
   *     releases FIRST_PENDING; an ambiguous one keeps it protected for reconciliation.
   *  7. Reserve every line, persist the Booking, write the PLATFORM_FEE ledger row for a
   *     nonzero FIRST upfront (a €0 RETURNING purchase writes none), and — for FIRST — consume
   *     the relationship (FIRST_PENDING -> CONSUMED), all inside ONE MongoDB transaction.
   *  8. If step 7 fails AFTER a successful charge, retain the claim and durable PaymentAttempt,
   *     record compensation-required, and create/resume a durable RefundOperation; a FIRST
   *     relationship moves to RESTORATION_PENDING and only returns to ELIGIBLE once that exact
   *     full refund is confirmed. The same logical key can never create a replacement PI.
   */
  /** Customer-owned, read-only ordinary operation recovery. No provider, admission or money
   * calls. Deliberately available even when the Business stops accepting new bookings. */
  public async readCustomerBookingPayment(customerUserId: string, businessId: string, key: string) {
    this.requireIdempotencyKey(key);
    const scope: CustomerReplayScope = {
      businessId: new Types.ObjectId(businessId),
      customerUserId,
      idempotencyKey: key,
      kind: "NORMAL_BOOKING",
    };
    const { claim, booking } = await this.readCustomerReplay(scope, undefined, false);
    const attempt = await PaymentAttemptModel.findOne({ logicalIdempotencyKey: key })
      .select("+clientSecret")
      .read("primary")
      .readConcern("majority")
      .maxTimeMS(2000);
    const conflict = () => new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    if (
      attempt &&
      (String(attempt.customerUserId) !== customerUserId ||
        String(attempt.businessId) !== String(scope.businessId) ||
        attempt.productKind !== "NORMAL_BOOKING" ||
        attempt.purpose !== "BOOKING_DEPOSIT" ||
        attempt.packageBatchBinding ||
        attempt.packageLifecycleBinding ||
        (claim && String(attempt.bookingId) !== String(claim.bookingId)))
    )
      throw conflict();
    const contract = claim?.financialContract;
    if (
      attempt &&
      contract &&
      (attempt.expectedAmountCents !== contract.onlineChargeCents ||
        attempt.currency !== contract.currency ||
        attempt.financialContractVersion !== contract.version ||
        attempt.relationshipClassification !== contract.classification ||
        String(attempt.businessClientId) !== String(contract.businessClientId))
    )
      throw conflict();
    let state: BookingPaymentState =
      !claim && !attempt ? "NOT_OBSERVED" : bookingPaymentState(attempt);
    let committed = false;
    const durableBooking =
      booking && contract
        ? await BookingModel.findOne({
            _id: booking._id,
            businessId: scope.businessId,
            "customer.customerUserId": scope.customerUserId,
          })
            .read("primary")
            .readConcern("majority")
            .maxTimeMS(2000)
        : null;
    if (
      durableBooking &&
      contract &&
      durableBooking.financialContract &&
      !findFinancialContractMismatch(contract, durableBooking.financialContract)
    ) {
      if (contract.onlineChargeCents === 0) committed = !attempt;
      else if (
        attempt?.providerStatus === "SUCCEEDED" &&
        attempt.persistenceStatus === "COMPLETED" &&
        attempt.compensationStatus === "NOT_REQUIRED" &&
        attempt.succeededTransactionId &&
        attempt.providerPaymentIntentId
      ) {
        const ledger = await BookingFinancialTransactionModel.findOne({
          _id: attempt.succeededTransactionId,
          bookingId: durableBooking._id,
          businessId: scope.businessId,
          businessClientId: contract.businessClientId,
          customerUserId: scope.customerUserId,
          type: contract.upfrontLedgerType,
          direction: "DEBIT",
          status: "SUCCEEDED",
          amountCents: contract.onlineChargeCents,
          currency: contract.currency,
          providerReference: attempt.providerPaymentIntentId,
          idempotencyKey: `${key}:deposit`,
        })
          .read("primary")
          .readConcern("majority")
          .maxTimeMS(2000);
        committed = Boolean(ledger);
      }
    }
    if (committed) state = "COMMITTED";
    const canDismiss =
      committed ||
      state === "REFUNDED" ||
      Boolean(
        attempt &&
          state === "PAYMENT_FAILED" &&
          (attempt.providerStatus === "CANCELED" || isProviderCreationClosed(attempt)),
      );
    const business = await this.businessRepository.findById(scope.businessId);
    const businessAvailable = Boolean(
      business && ["APPROVED", "WARNING"].includes(business.status),
    );
    const canResume =
      businessAvailable &&
      !canDismiss &&
      !["REFUND_PENDING", "RECONCILIATION_REQUIRED"].includes(state);
    return {
      state,
      businessId,
      idempotencyKey: key,
      canDismiss,
      canResume,
      ...(!businessAvailable ? { resumeBlockedReason: "BUSINESS_UNAVAILABLE" as const } : {}),
      ...(committed && booking
        ? { bookingId: String(booking._id), reference: booking.reference }
        : {}),
      ...(attempt
        ? {
            providerStatus: attempt.providerStatus,
            persistenceStatus: attempt.persistenceStatus,
            compensationStatus: attempt.compensationStatus,
          }
        : {}),
      // An exact owned claim/contract is mandatory before exposing the ephemeral SCA secret.
      ...(claim &&
      contract &&
      canResume &&
      ["AUTHENTICATION_REQUIRED", "PAYMENT_FAILED"].includes(state) &&
      attempt?.providerPaymentIntentId &&
      attempt.clientSecret
        ? { clientSecret: attempt.clientSecret }
        : {}),
    };
  }

  public async finalizeCustomerBooking(
    customerUserId: string,
    businessId: string,
    input: CreateBookingInput,
  ): Promise<FinalizeBookingResult> {
    this.requireIdempotencyKey(input.idempotencyKey);
    const business = await this.requireBusiness(businessId);

    const customerReplay: CustomerReplayScope = {
      businessId: business._id,
      customerUserId,
      idempotencyKey: input.idempotencyKey,
      kind: "NORMAL_BOOKING",
    };
    const replay = await this.readCustomerReplay(customerReplay);
    const existingClaim = replay.claim;
    if (existingClaim) {
      if (replay.booking) return { status: "confirmed", booking: replay.booking };
      if (!replay.attempt || this.persistenceLeaseActive(replay.attempt)) {
        const pendingBooking = await this.awaitIdempotentBooking(
          { business, idempotencyKey: input.idempotencyKey, customerReplay },
          existingClaim.bookingId,
        );
        return { status: "confirmed", booking: pendingBooking };
      }
    }

    await this.enforceMaxServicesPerBooking(input.serviceLines.length);
    const startAt = this.parseStartAt(input.startAt);
    const lines = await this.resolveServiceLines(business, startAt, input);
    const fulfilment = await this.resolveFulfilment(business, input);
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      lines,
      input.customerCity,
    );
    const client = await this.resolveOrCreateCustomerClient(business, customerUserId, fulfilment);

    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    if (!cardStatus.hasSavedCard) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
    };

    const bookingId = existingClaim?.bookingId ?? new Types.ObjectId();
    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });

    if (!claimResult.isNew && !existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey, customerReplay },
        claimResult.bookingId,
      );
      return { status: "confirmed", booking };
    }

    let terms: EstablishedFinancialTerms;
    try {
      terms = await this.establishFinancialTerms({
        business,
        client,
        customerUserId,
        idempotencyKey: input.idempotencyKey,
        bookingId,
        productKind: "NORMAL_BOOKING",
        existingContract: existingClaim?.financialContract,
        lines,
        travelFeeCents,
        promoCode: input.promoCode,
      });
    } catch (error) {
      if (!existingClaim)
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: input.idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(customerUserId),
          bookingId,
        });
      throw error;
    }

    return this.chargeAndPersistContract({
      customerUserId,
      business,
      client,
      existingClaim: Boolean(existingClaim),
      purpose: "BOOKING_DEPOSIT",
      terms,
      persist: (paymentResult, persistenceLeaseToken) =>
        this.persistCustomerBooking({
          bookingId,
          business,
          customer,
          createdBy,
          fulfilment,
          lines,
          financials: terms.financials,
          cancellationPolicySnapshot,
          noShowEligibilitySnapshot,
          startAt,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          client,
          contract: terms.contract,
          paymentResult,
          resolvedPromo: terms.resolvedPromo,
          customerChargeNowCents: terms.contract.onlineChargeCents,
          persistenceLeaseToken,
        }),
    });
  }

  /**
   * Shared tail of normal-booking and package-purchase finalize, after the contract exists:
   * Cyprus VAT compute (dark), the upfront charge, and transactional persistence — with P1
   * relationship-aware failure handling at every money boundary:
   *  - before/at the charge, a definitive failure releases a FIRST claim (unbound -> released
   *    now; bound -> only if the PaymentAttempt is terminally FAILED);
   *  - `requires_action`/ambiguous keeps FIRST_PENDING for the same logical retry;
   *  - after a successful charge, failed persistence runs P0 compensation and moves a FIRST
   *    relationship to RESTORATION_PENDING (and on to ELIGIBLE only on the exact full refund).
   */
  private async chargeAndPersistContract(params: {
    customerUserId: string;
    business: BusinessDocument;
    client: BusinessClientDocument;
    existingClaim: boolean;
    purpose: Extract<PaymentIntentPurpose, "BOOKING_DEPOSIT" | "PACKAGE_PURCHASE">;
    terms: { contract: FinancialContract };
    persist: (
      paymentResult: PaymentIntentResult | undefined,
      persistenceLeaseToken: string | undefined,
    ) => Promise<BookingDocument>;
  }): Promise<FinalizeBookingResult> {
    const { business, client, terms } = params;
    const { contract } = terms;
    const isFirst = contract.classification === "FIRST";
    const idempotencyKey = contract.idempotencyKey;
    const customerChargeNowCents = contract.onlineChargeCents;

    // Checkpoint B (Cyprus VAT, compute-only) — computed from the contract's authoritative
    // online charge BEFORE the real charge below. `TaxError` propagates untouched: the claim is
    // released and the booking is never charged/persisted with an unknown tax outcome (locked
    // rule: never invent VAT). The live PaymentIntent amount stays the pre-tax online charge.
    let computedTax: ComputedTax | undefined;
    try {
      computedTax = await this.computeCyprusTax(
        customerChargeNowCents,
        String(contract.bookingId),
        `${idempotencyKey}:tax`,
      );
    } catch (error) {
      if (isFirst) await this.releaseFirstClaimAfterPreMoneyFailure(client, idempotencyKey);
      if (!params.existingClaim)
        await this.claimRepository.releaseUncommitted({
          idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(params.customerUserId),
          bookingId: contract.bookingId,
        });
      throw error;
    }

    let paymentResult: PaymentIntentResult | undefined;

    // The ACTUAL Stripe charge amount/gate is the contract's online charge — a FIRST zero basis
    // (P2: including a promo that zeroes the price) is a zero obligation, never a fake €0
    // PaymentIntent; the saved-card requirement still applies either way.
    if (customerChargeNowCents > 0) {
      try {
        paymentResult = await this.chargeContractUpfront({
          customerUserId: params.customerUserId,
          business,
          client,
          contract,
          purpose: params.purpose,
          computedTax,
        });
      } catch (error) {
        if (isFirst) await this.releaseFirstClaimAfterPreMoneyFailure(client, idempotencyKey);
        throw error;
      }

      if (paymentResult.status === "requires_action") {
        return {
          status: "requires_action",
          clientSecret: paymentResult.clientSecret as string,
          paymentIntentId: paymentResult.paymentIntentId,
        };
      }

      if (paymentResult.status !== "succeeded") {
        if (isFirst) await this.releaseFirstClaimAfterPreMoneyFailure(client, idempotencyKey);
        throw new PaymentError(
          "PAYMENT_FAILED",
          402,
          paymentResult.failureMessage
            ? [{ message: paymentResult.failureMessage, code: "PAYMENT_FAILED" }]
            : undefined,
        );
      }
    }

    const persistenceLeaseToken = await this.paymentService.claimPaymentPersistence(
      paymentResult?.paymentAttemptId,
    );
    try {
      if (persistenceLeaseToken === null) {
        const booking = await this.awaitIdempotentBooking(
          {
            business,
            idempotencyKey,
            customerReplay: {
              businessId: business._id,
              customerUserId: params.customerUserId,
              idempotencyKey,
              kind: contract.productKind,
            },
          },
          contract.bookingId,
        );
        return { status: "confirmed", booking, ...(computedTax ? { computedTax } : {}) };
      }
      const booking = await params.persist(paymentResult, persistenceLeaseToken);
      return { status: "confirmed", booking, ...(computedTax ? { computedTax } : {}) };
    } catch (error) {
      if (error instanceof BookingPersistenceUnresolvedError || persistenceLeaseToken === null)
        throw error;
      if (paymentResult) {
        const ownsCompensation = await this.paymentService.markPaymentCompensationRequired(
          paymentResult.paymentAttemptId,
          error,
          persistenceLeaseToken ?? undefined,
        );
        // Batch 13 — refunds the amount ACTUALLY charged to Stripe (post-promo), never the
        // pre-promo `financials.depositCents` entitlement: Stripe can only refund what it
        // actually collected.
        if (ownsCompensation) {
          await this.compensateFailedBookingAfterPayment(
            business,
            contract.bookingId,
            client,
            customerChargeNowCents,
            paymentResult,
          );
        }
        // FIRST_PENDING -> RESTORATION_PENDING (-> ELIGIBLE if the exact refund already
        // confirmed). Derived from durable state, so a lease-loss/duplicate caller is harmless.
        if (isFirst) await this.relationships.reconcileQuietly(client._id);
      } else {
        await this.claimRepository.releaseUncommitted({
          idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(params.customerUserId),
          bookingId: contract.bookingId,
        });
        if (isFirst) await this.releaseFirstClaimAfterPreMoneyFailure(client, idempotencyKey);
      }
      throw error;
    }
  }

  // --- Customer: Package purchase / session redemption --------------------------------------
  //
  // Package Deal audit (see the Phase A report): a Package is multiple sessions of the SAME
  // Service — never a bundle of distinct Services (packagePricing has exactly one durationMin/
  // bundlePriceCents for the whole package, structurally ruling that out). The Booking schema
  // has exactly one root {timezone, startAt, endAt} shared by every line, so a multi-session
  // Package can never be ONE Booking — each session is its own, normal Booking, linked back to
  // a small PackageProgress entitlement via the packageProgressId/sessionIndex fields
  // booking.model.ts already reserved for this ("confirmed rule K").
  //
  // CONFIRMED PRODUCT ANSWERS this implementation is built on (Phase 4B approved-rules
  // corrections supersede the original Phase 2 clarification round where they differ):
  //  - Payment: deposit-now/balance-at-venue at purchase (KEPT — never a full Stripe charge;
  //    see PackagePricing's own comment for why). Sessions 2..N never redeem until that ORIGIN
  //    Booking's own venue balance is recorded settled (computePackageBalanceSettlement,
  //    package-progress.rules.ts) — no second payment-status system. The Package base session
  //    itself is ALWAYS $0 once unlocked — never re-run through calculateBookingDepositCents
  //    for the base price, which floors at DEPOSIT_MIN_CENTS even for a €0 basis (the exact
  //    double-charge landmine the Phase 3 audit found). A redemption's Add-ons/travel fee ARE
  //    real, separately payable money and DO go through the normal deposit formula.
  //  - Scheduling: incremental — purchasing books ONLY session 1; sessions 2..N are booked
  //    later, one at a time, via redeemPackageSession.
  //  - Cancellation/no-show: on-time cancellation returns the session to the balance, no
  //    penalty; LATE cancellation or a genuine NO_SHOW FORFEITS the session (the lost session
  //    IS the penalty — no additional percentage fee on the package base). Wired via
  //    BookingLifecycleService/NoShowResolutionService's own sync hooks — see
  //    package-progress.rules.ts's packageSessionOutcomeForBookingStatus.
  //  - Expiry: none (no field, no rule).
  //  - Whole-package refund/void: allowed only while completely unused (no session ever
  //    COMPLETED/FORFEITED, no unresolved SCHEDULED session) — see voidUnusedPackage in
  //    BookingLifecycleService. No partial/prorated refunds.
  //
  // Deliberately still deferred (not silently invented):
  //  - Owner/Supervisor manual Package purchase or redemption on a Customer's behalf.
  //  - Promo Code support on a Package purchase.

  /** Read-only Package purchase quote — mirrors previewCustomerBooking exactly (same shared
   * private helpers, same shape), scoped to exactly one Package Deal service line. Never
   * reserves or persists anything. */
  public async previewPackagePurchase(
    customerUserId: string,
    businessId: string,
    input: CreateBookingInput,
  ): Promise<BookingCreationPreview> {
    this.requirePackagePurchaseShape(input);
    const business = await this.requireBusiness(businessId);

    const startAt = this.parseStartAt(input.startAt);
    const lines = await this.resolveServiceLines(business, startAt, input, { allowPackage: true });
    this.requirePackageServiceLine(lines[0] as ResolvedServiceLine);
    const fulfilment = await this.resolveFulfilment(business, input);
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      lines,
      input.customerCity,
    );

    const existingClient = await this.clientRepository.findByBusinessIdAndLinkedUserId(
      business._id,
      customerUserId,
    );
    // P1 — estimate only (see previewCustomerBooking). A FIRST package quote uses the bundle
    // price alone as its upfront basis.
    const classification = this.relationships.peekClassification(existingClient);
    const isFirstBooking = classification === "FIRST";
    const line = lines[0] as ResolvedServiceLine;
    const { financials } = this.assembleCustomerFinancials(
      lines,
      travelFeeCents,
      classification,
      (line.service.packagePricing as NonNullable<ServiceDocument["packagePricing"]>)
        .bundlePriceCents,
    );
    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    const computedTax = await this.computeCyprusTax(
      financials.depositCents,
      `preview-${new Types.ObjectId().toHexString()}`,
    );
    const financialCommitment = this.toPreviewFinancialCommitment(
      financials.depositCents,
      financials.balanceDueCents,
      computedTax,
    );

    return {
      finalizable: true,
      isFirstBooking,
      business: { id: String(business._id), name: business.name, timezone: business.timezone },
      schedule: {
        timezone: business.timezone,
        startAt: startAt.toISOString(),
        endAt: line.endAt.toISOString(),
      },
      fulfilment,
      serviceLines: [
        {
          serviceId: String(line.service._id),
          staffMembershipId: String(line.staffMembership._id),
          serviceSnapshot: line.serviceSnapshot,
          staffSnapshot: line.staffSnapshot,
          addons: line.addons,
          amountCents: line.amountCents,
        },
      ],
      financials,
      ...financialCommitment,
      requiresSavedCard: true,
      hasSavedCard: cardStatus.hasSavedCard,
    };
  }

  /**
   * The real Package purchase: books and pays for session 1 exactly like
   * finalizeCustomerBooking (same idempotency-claim / relationship-claim / Financial Contract V2
   * / payment / ledger machinery, reused via establishFinancialTerms, chargeAndPersistContract and
   * persistCustomerBooking), then creates the linked PackageProgress entitlement with
   * `remainingSessions = sessionsInPackage - 1`. The entitlement, origin Booking, ledger row and
   * (for FIRST) relationship consumption are written in the SAME Mongo transaction so none can
   * become durably visible without the others.
   */
  public async finalizePackagePurchase(
    customerUserId: string,
    businessId: string,
    input: CreateBookingInput,
  ): Promise<FinalizeBookingResult> {
    this.requirePackageProgressRepository();
    this.requirePackagePurchaseShape(input);
    this.requireIdempotencyKey(input.idempotencyKey);
    const business = await this.requireBusiness(businessId);

    const customerReplay: CustomerReplayScope = {
      businessId: business._id,
      customerUserId,
      idempotencyKey: input.idempotencyKey,
      kind: "PACKAGE_PURCHASE",
    };
    const replay = await this.readCustomerReplay(customerReplay);
    const existingClaim = replay.claim;
    if (existingClaim) {
      if (replay.booking) return { status: "confirmed", booking: replay.booking };
      if (!replay.attempt || this.persistenceLeaseActive(replay.attempt)) {
        const pendingBooking = await this.awaitIdempotentBooking(
          { business, idempotencyKey: input.idempotencyKey, customerReplay },
          existingClaim.bookingId,
        );
        return { status: "confirmed", booking: pendingBooking };
      }
    }

    const startAt = this.parseStartAt(input.startAt);
    const lines = await this.resolveServiceLines(business, startAt, input, { allowPackage: true });
    const line = this.requirePackageServiceLine(lines[0] as ResolvedServiceLine);
    const packagePricing = line.service.packagePricing as NonNullable<
      ServiceDocument["packagePricing"]
    >;

    const fulfilment = await this.resolveFulfilment(business, input);
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      lines,
      input.customerCity,
    );
    const packageTravelSettings =
      fulfilment.mode === "TRAVEL_TO_CUSTOMER"
        ? await this.businessTravelSettingsRepository.findByBusinessId(business._id)
        : null;
    const fulfilmentEntitlement = buildPackageFulfilmentEntitlement(
      { fulfilment },
      line.service,
      packageTravelSettings,
    );

    const client = await this.resolveOrCreateCustomerClient(business, customerUserId, fulfilment);

    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    if (!cardStatus.hasSavedCard) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
    };

    const bookingId = existingClaim?.bookingId ?? new Types.ObjectId();
    const packageProgressId = new Types.ObjectId();

    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });

    if (!claimResult.isNew && !existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey, customerReplay },
        claimResult.bookingId,
      );
      return { status: "confirmed", booking };
    }

    // Stamp the entitlement linkage onto the single resolved line now that both ids exist —
    // resolvePricingAndTiming (called inside resolveServiceLines above) deliberately left this
    // empty, since it runs before either id is generated.
    line.pricingInput = {
      sessionsInPackage: packagePricing.sessionsInPackage,
      sessionIndex: 1,
      packageProgressId,
    };

    // P1 — shares the SAME customer↔business relationship as a normal booking: whichever
    // qualifying operation consumes it first is the first; a FIRST package's upfront basis is
    // the bundle price only. Package promo remains unsupported.
    let terms: EstablishedFinancialTerms;
    try {
      terms = await this.establishFinancialTerms({
        business,
        client,
        customerUserId,
        idempotencyKey: input.idempotencyKey,
        bookingId,
        productKind: "PACKAGE_PURCHASE",
        existingContract: existingClaim?.financialContract,
        lines,
        travelFeeCents,
        packageBundlePriceCents: packagePricing.bundlePriceCents,
      });
    } catch (error) {
      if (!existingClaim)
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: input.idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(customerUserId),
          bookingId,
        });
      throw error;
    }

    const packageProgressCreate: CreatePackageProgressInput = {
      _id: packageProgressId,
      businessId: business._id,
      customerUserId: new Types.ObjectId(customerUserId),
      businessClientId: client._id,
      serviceId: line.service._id,
      totalSessions: packagePricing.sessionsInPackage,
      remainingSessions: packagePricing.sessionsInPackage - 1,
      completedSessions: 0,
      sessions: [{ sessionIndex: 1, bookingId, status: "SCHEDULED" }],
      originBookingId: bookingId,
      purchaseSnapshot: {
        name: line.service.name,
        packageServicesName: line.service.packageServicesName,
        bundlePriceCents: packagePricing.bundlePriceCents,
        durationMin: packagePricing.durationMin,
        sessionsInPackage: packagePricing.sessionsInPackage,
        discountPercent: packagePricing.discountPercent,
        fulfilmentEntitlement,
      },
    };

    return this.chargeAndPersistContract({
      customerUserId,
      business,
      client,
      existingClaim: Boolean(existingClaim),
      purpose: "PACKAGE_PURCHASE",
      terms,
      persist: (paymentResult, persistenceLeaseToken) =>
        this.persistCustomerBooking({
          bookingId,
          business,
          customer,
          createdBy,
          fulfilment,
          lines,
          financials: terms.financials,
          cancellationPolicySnapshot,
          noShowEligibilitySnapshot,
          startAt,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          client,
          contract: terms.contract,
          paymentResult,
          resolvedPromo: undefined,
          customerChargeNowCents: terms.contract.onlineChargeCents,
          packageProgressCreate,
          persistenceLeaseToken,
        }),
    });
  }

  /** Authoritative, side-effect-free quote used by both at-business and travel redemption. It
   * deliberately exposes the current pre-activation charge only; VAT calculation remains dark
   * until PaymentIntent amount and disclosure can switch atomically in the activation checkpoint. */
  public async previewPackageRedemption(
    customerUserId: string,
    businessId: string,
    packageProgressId: string,
    input: PackageRedemptionSelections,
  ): Promise<PackageRedemptionPreview> {
    const { fulfilment, financials } = await this.computePackageRedemptionPricing(
      customerUserId,
      businessId,
      packageProgressId,
      input,
    );
    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    return {
      finalizable: true,
      taxMode: "PRE_ACTIVATION",
      fulfilment,
      packageBaseCents: 0,
      addonsSubtotalCents: financials.addonsSubtotalCents,
      travelFeeCents: financials.travelFeeCents,
      subtotalCents: financials.totalCents,
      totalCents: financials.totalCents,
      depositCents: financials.depositCents,
      customerChargeNowCents: financials.depositCents,
      balanceDueCents: financials.balanceDueCents,
      currency: "EUR",
      requiresSavedCard: financials.depositCents > 0,
      hasSavedCard: cardStatus.hasSavedCard,
    };
  }

  /**
   * Redeems ONE remaining session of an already-purchased Package. The base session itself is
   * ALWAYS $0 (its price was already collected at purchase) — approved rule — but a selected
   * Add-on or (for a TRAVEL_TO_CUSTOMER business) this visit's real travel fee remain separately
   * payable via the exact same deposit/3DS/ledger machinery any normal booking already uses.
   * Blocked entirely (PACKAGE_PROGRESS_BALANCE_NOT_SETTLED) until the ORIGIN purchase Booking's
   * own venue balance is recorded settled — see computePackageBalanceSettlement's own doc
   * comment for why this reuses that Booking's existing financial state rather than a second,
   * separately-tracked payment-status field. Reuses every generic booking-creation primitive
   * (staff eligibility, availability re-validation, atomic slot reservation, notifications,
   * Google Calendar sync, appointment reminders) exactly as-is; the only Package-specific step
   * is the atomic PackageProgressRepository.claimSession guard, which prevents two concurrent
   * redemption requests from both consuming the SAME last remaining session (see that method's
   * own doc comment for why a single guarded `findOneAndUpdate` — never a naive
   * read-then-decrement — makes this safe).
   */
  public async redeemPackageSession(
    customerUserId: string,
    businessId: string,
    packageProgressId: string,
    input: {
      staffMembershipId: string;
      startAt: string;
      addonIds?: string[] | undefined;
      travelAddress?: CreateBookingInput["travelAddress"];
      customerCity?: CreateBookingInput["customerCity"];
      notes?: string | undefined;
      idempotencyKey: string;
    },
  ): Promise<FinalizeBookingResult> {
    this.requirePackageProgressRepository();
    this.requireIdempotencyKey(input.idempotencyKey);
    const pricing = await this.computePackageRedemptionPricing(
      customerUserId,
      businessId,
      packageProgressId,
      input,
    );
    const { business, progress, service, fulfilment, addons, financials } = pricing;

    const customerReplay: CustomerReplayScope = {
      businessId: business._id,
      customerUserId,
      idempotencyKey: input.idempotencyKey,
      kind: "PACKAGE_REDEMPTION",
      packageProgressId: progress._id,
    };
    const replay = await this.readCustomerReplay(customerReplay);
    const existingClaim = replay.claim;
    if (existingClaim) {
      if (replay.booking) return { status: "confirmed", booking: replay.booking };
      if (!replay.attempt || this.persistenceLeaseActive(replay.attempt)) {
        const pendingBooking = await this.awaitIdempotentBooking(
          { business, idempotencyKey: input.idempotencyKey, customerReplay },
          existingClaim.bookingId,
        );
        return { status: "confirmed", booking: pendingBooking };
      }
    }

    const startAt = this.parseStartAt(input.startAt);

    const { service: staffValidatedService, staffMembership } =
      await this.bookingService.validateResponsibleStaff(
        business,
        String(progress.serviceId),
        input.staffMembershipId,
      );
    if (!staffValidatedService._id.equals(service._id)) {
      throw new PackageProgressError("PACKAGE_PROGRESS_SERVICE_MISMATCH", 409);
    }
    // Approved Service-status rule: ACTIVE and INACTIVE both still allow redeeming an
    // ALREADY-purchased session (only new purchases are blocked for INACTIVE — see
    // ServiceService's own createService/updateService guard); only ARCHIVED blocks it, matching
    // validateResponsibleStaff's own ARCHIVED-only check above — no stricter gate here anymore.
    if (service.status === "ARCHIVED") {
      throw new BookingError("BOOKING_SERVICE_ARCHIVED", 409);
    }
    const packagePricing = service.packagePricing;
    if (!packagePricing) {
      throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 409);
    }

    // Snapshot vs live (approved rule): WHAT was purchased — the per-session duration — stays
    // exactly as it was at purchase time, even if the Owner later edits the Service's live
    // duration; a later purchase of the SAME (edited) Service gets the new live duration
    // instead (see finalizePackagePurchase, which always reads the CURRENT packagePricing).
    // Buffer/processing time are operational scheduling detail, not part of what was
    // contractually sold, so they stay LIVE like every other operational rule below (staff,
    // hours, schedule, availability, served city).
    const durationMin = progress.purchaseSnapshot.durationMin;
    const endAt = new Date(
      startAt.getTime() +
        (durationMin +
          (packagePricing.bufferAfterMin ?? 0) +
          (packagePricing.processingTimeMin ?? 0)) *
          60_000,
    );

    await this.availabilityService.assertSlotIsBookable({
      business,
      service,
      staffMembership,
      startAt,
      endAt,
      partySize: 1,
    });

    const client = await this.resolveOrCreateCustomerClient(business, customerUserId, fulfilment);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
    };
    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);
    // A redemption is always exactly one Service line, so it alone governs the reminder
    // snapshot — same rule as buildSessionEndReminderSnapshot's multi-line tie-break, trivially
    // satisfied here.
    const sessionEndReminderSnapshot: BookingSessionEndReminderSnapshot = {
      enabled: service.sessionExpiryAlert.enabled,
      ...(service.sessionExpiryAlert.minutesBeforeSessionEnds !== undefined
        ? { minutesBeforeSessionEnds: service.sessionExpiryAlert.minutesBeforeSessionEnds }
        : {}),
    };

    // Same staffSnapshot convention resolveServiceLines already establishes for a normal
    // booking (booking.model.ts's own doc comment: snapshots survive a later profile change) —
    // resolved once here rather than batched, since a redemption is always exactly one line.
    const staffProfile = await this.userRepository.findProfileByUserId(staffMembership.userId);
    const staffSnapshot = staffProfile
      ? { firstName: staffProfile.firstName, lastName: staffProfile.lastName }
      : undefined;

    const resolvedLine: ResolvedServiceLine = {
      service,
      staffMembership,
      serviceSnapshot: {
        name: service.name,
        pricingMode: "PACKAGE",
        durationMin,
        ...(progress.purchaseSnapshot.discountPercent !== undefined
          ? { discountPercent: progress.purchaseSnapshot.discountPercent }
          : {}),
      },
      staffSnapshot,
      // sessionIndex/packageProgressId are stamped in below, once the atomic claim (inside the
      // transaction) reveals which numbered session this actually is — mirrors
      // finalizePackagePurchase's own "stamp after both ids/claims exist" comment.
      pricingInput: { sessionsInPackage: progress.totalSessions },
      addons,
      // The Package base service itself is ALWAYS $0 (already paid for at purchase) —
      // approved rule — regardless of whether Add-ons/travel are also selected.
      amountCents: 0,
      discountCents: 0,
      capacityMax: 1,
      partySize: 1,
      endAt,
    };

    if (financials.depositCents > 0) {
      const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
      if (!cardStatus.hasSavedCard) {
        throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
      }
    }

    const bookingId = existingClaim?.bookingId ?? new Types.ObjectId();
    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });
    if (!claimResult.isNew && !existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey, customerReplay },
        claimResult.bookingId,
      );
      return { status: "confirmed", booking };
    }

    const customerChargeNowCents = financials.depositCents;

    // Checkpoint B (Cyprus VAT, compute-only) — see finalizeCustomerBooking's identical comment
    // for the full rationale. A redemption's base session is always $0 (nothing to tax there);
    // this only ever calculates against real Add-on/travel-fee extras. PaymentIntent amount
    // immediately below is UNCHANGED in this checkpoint.
    let computedTax: ComputedTax | undefined;
    try {
      computedTax = await this.computeCyprusTax(
        customerChargeNowCents,
        String(bookingId),
        `${input.idempotencyKey}:tax`,
      );
    } catch (error) {
      if (!existingClaim)
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: input.idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(customerUserId),
          bookingId,
        });
      throw error;
    }

    let paymentResult: PaymentIntentResult | undefined;

    if (customerChargeNowCents > 0) {
      paymentResult = await this.paymentService.chargeBookingDeposit({
        userId: customerUserId,
        amountCents: customerChargeNowCents,
        idempotencyKey: input.idempotencyKey,
        metadata: buildPaymentIntentMetadata({
          bookingId: String(bookingId),
          businessId: String(business._id),
          businessClientId: String(client._id),
          purpose: "PACKAGE_SESSION_EXTRAS",
          preTaxChargeCents: customerChargeNowCents,
          taxCents: computedTax?.taxCents ?? 0,
          chargedAmountCents: customerChargeNowCents,
          taxCalculationId: computedTax?.taxCalculationId,
          taxMode: "PRE_ACTIVATION",
        }),
      });

      if (paymentResult.status === "requires_action") {
        return {
          status: "requires_action",
          clientSecret: paymentResult.clientSecret as string,
          paymentIntentId: paymentResult.paymentIntentId,
        };
      }

      if (paymentResult.status !== "succeeded") {
        throw new PaymentError(
          "PAYMENT_FAILED",
          402,
          paymentResult.failureMessage
            ? [{ message: paymentResult.failureMessage, code: "PAYMENT_FAILED" }]
            : undefined,
        );
      }
    }

    const dbSession = await mongoose.startSession().catch(async (error) => {
      if (!paymentResult)
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: input.idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(customerUserId),
          bookingId,
        });
      throw error;
    });
    let created: BookingDocument | undefined;
    let succeededTransactionId: Types.ObjectId | undefined;
    let succeededTransaction: BookingFinancialTransactionDocument | undefined;
    const persistenceLeaseToken = await this.paymentService.claimPaymentPersistence(
      paymentResult?.paymentAttemptId,
    );

    try {
      if (persistenceLeaseToken === null) {
        const booking = await this.awaitIdempotentBooking(
          { business, idempotencyKey: input.idempotencyKey, customerReplay },
          bookingId,
        );
        return { status: "confirmed", booking, ...(computedTax ? { computedTax } : {}) };
      }
      const recovered = await this.runBookingTransaction(
        dbSession,
        async () => {
          const currentBusiness = await acquireSchedulingAdmission(business, dbSession);
          await validateSchedulingLine(
            {
              business: currentBusiness,
              serviceId: service._id,
              staffMembershipId: staffMembership._id,
              startAt,
              endAt,
              partySize: 1,
              capacityMax: 1,
              allowInactive: true,
              expectedService: service,
              fulfilment,
              legacyPurchase: {
                progressId: progress._id,
                businessClientId: progress.businessClientId,
                customerUserId: progress.customerUserId,
              },
            },
            this.availabilityService,
            dbSession,
          );
          const afterClaim = await (
            this.packageProgressRepository as PackageProgressRepository
          ).claimSession(progress._id, dbSession);
          if (!afterClaim) {
            throw new PackageProgressError("PACKAGE_PROGRESS_NO_SESSIONS_REMAINING", 409);
          }
          const claimedSessionIndex = afterClaim.totalSessions - afterClaim.remainingSessions;

          const reservation = await this.reservationService.reserveOrJoin(
            {
              businessId: business._id,
              staffMembershipId: staffMembership._id,
              serviceId: service._id,
              timezone: business.timezone,
              startAt,
              endAt,
              capacityMax: 1,
              partySize: 1,
              idempotencyKey: `${input.idempotencyKey}:0`,
            },
            dbSession,
          );

          const reference = await this.generateUniqueReference();

          const serviceLine: BookingServiceLine = {
            serviceId: service._id,
            serviceSnapshot: resolvedLine.serviceSnapshot,
            pricingInput: {
              sessionsInPackage: afterClaim.totalSessions,
              sessionIndex: claimedSessionIndex,
              packageProgressId: progress._id,
            },
            responsibleStaffMembershipId: staffMembership._id,
            ...(staffSnapshot ? { staffSnapshot } : {}),
            addons,
            amountCents: 0,
            reservationId: reservation.reservationId,
            reservationOperationKey: `${input.idempotencyKey}:0`,
          };

          created = await this.bookingRepository.create(
            {
              _id: bookingId,
              businessId: business._id,
              reference,
              source: "BOOKLY_MANAGED",
              status: "UPCOMING",
              customer,
              createdBy,
              fulfilment,
              serviceLines: [serviceLine],
              financials,
              schedule: { timezone: business.timezone, startAt, endAt },
              customerRescheduleCount: 0,
              rescheduleHistory: [],
              eventHistory: [
                {
                  type: "CREATED",
                  nextStatus: "UPCOMING",
                  actorUserId: createdBy.actorUserId,
                  actorRole: createdBy.actorRole,
                  createdAt: new Date(),
                },
              ],
              ...(cancellationPolicySnapshot ? { cancellationPolicySnapshot } : {}),
              ...(noShowEligibilitySnapshot ? { noShowEligibilitySnapshot } : {}),
              sessionEndReminderSnapshot,
              ...(input.notes ? { notes: input.notes } : {}),
            },
            dbSession,
          );

          await (
            this.packageProgressRepository as PackageProgressRepository
          ).recordScheduledSession(progress._id, claimedSessionIndex, bookingId, dbSession);

          // Real money was actually charged (Add-ons/travel) — ledger it exactly like any other
          // BOOKLY_MANAGED deposit (never PLATFORM_FEE here: isFirstBooking is always false for a
          // redemption, matching the confirmed "already activated" reasoning above).
          if (customerChargeNowCents > 0) {
            const transaction = await this.financialTransactionService.record(
              {
                businessId: business._id,
                bookingId,
                businessClientId: client._id,
                customerUserId: createdBy.actorUserId,
                type: "DEPOSIT",
                direction: "DEBIT",
                amountCents: customerChargeNowCents,
                currency: financials.currency,
                status: "SUCCEEDED",
                ...(paymentResult ? { providerReference: paymentResult.paymentIntentId } : {}),
                idempotencyKey: `${input.idempotencyKey}:deposit`,
              },
              dbSession,
            );
            succeededTransactionId = transaction._id;
            succeededTransaction = transaction;
          }

          // F4A Tier 2 — confirmation intent commits with the Booking (last domain write,
          // before the PaymentAttempt completion fence; a failure takes the existing abort path).
          // Tier 3 — plus the payment facts this transaction holds (package credits are not money).
          await this.recordBookingCreatedIntent(
            created,
            business,
            dbSession,
            await this.bookingPaymentEvidence(
              paymentResult,
              succeededTransaction,
              "PACKAGE_SESSION_EXTRAS",
            ),
          );

          const completed = await this.paymentService.markPaymentCompleted(
            paymentResult?.paymentAttemptId,
            {
              bookingId,
              packageProgressId: progress._id,
              ...(succeededTransactionId ? { succeededTransactionId } : {}),
            },
            persistenceLeaseToken ?? undefined,
            dbSession,
          );
          if (!completed) throw new Error("Payment persistence lease was lost");
        },
        () => this.resolveCommittedBooking(customerReplay, bookingId),
      );
      if (recovered) created = recovered;
    } catch (error) {
      if (error instanceof BookingPersistenceUnresolvedError || persistenceLeaseToken === null)
        throw error;
      if (paymentResult) {
        const ownsCompensation = await this.paymentService.markPaymentCompensationRequired(
          paymentResult.paymentAttemptId,
          error,
          persistenceLeaseToken ?? undefined,
        );
        if (ownsCompensation) {
          await this.compensateFailedBookingAfterPayment(
            business,
            bookingId,
            client,
            customerChargeNowCents,
            paymentResult,
          );
        }
      } else
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: input.idempotencyKey,
          businessId: business._id,
          actorUserId: new Types.ObjectId(customerUserId),
          bookingId,
        });
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession().catch(() => undefined);
    }

    if (!created) {
      throw new Error("Package session booking failed without throwing");
    }

    await this.afterBookingCommitted(created, business);

    return { status: "confirmed", booking: created, ...(computedTax ? { computedTax } : {}) };
  }

  private requirePackageProgressRepository(): PackageProgressRepository {
    if (!this.packageProgressRepository) {
      throw new Error(
        "PackageProgressRepository must be injected to use Package purchase/redemption",
      );
    }
    return this.packageProgressRepository;
  }

  /** Single package-redemption pricing authority. Preview and finalization both call this exact
   * function with customer selections only; no client money value is accepted. */
  private async computePackageRedemptionPricing(
    customerUserId: string,
    businessId: string,
    packageProgressId: string,
    input: PackageRedemptionSelections,
  ): Promise<PackageRedemptionPricingContext> {
    this.requirePackageProgressRepository();
    const business = await this.requireBusiness(businessId);
    const progress = await (
      this.packageProgressRepository as PackageProgressRepository
    ).findByIdForCustomerAndBusiness(packageProgressId, business._id, customerUserId);
    if (!progress) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }
    if (progress.voidedAt) {
      throw new PackageProgressError("PACKAGE_PROGRESS_VOIDED", 409);
    }
    if (progress.remainingSessions <= 0) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NO_SESSIONS_REMAINING", 409);
    }

    const originBooking = await this.bookingRepository.findById(
      business._id,
      progress.originBookingId,
    );
    if (!originBooking) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }
    if (!computePackageBalanceSettlement(originBooking).balanceSettled) {
      throw new PackageProgressError("PACKAGE_PROGRESS_BALANCE_NOT_SETTLED", 409);
    }

    const service = await this.bookingService.requirePackageRedemptionService(
      business,
      String(progress.serviceId),
    );
    if (
      !service.isPackageDeal ||
      !service._id.equals(progress.serviceId) ||
      !service.packagePricing
    ) {
      throw new PackageProgressError("PACKAGE_PROGRESS_SERVICE_MISMATCH", 409);
    }

    const fulfilmentEntitlement = resolvePackageFulfilmentEntitlement(progress, originBooking);
    const { fulfilment, travelFeeCents } = this.resolvePackageRedemptionFulfilment(
      business,
      fulfilmentEntitlement,
      input,
    );
    this.bookingService.validateFulfilmentSnapshot(
      business,
      fulfilment,
      fulfilmentEntitlement.mode,
    );

    const addons = await this.bookingService.resolveAddonSnapshots(
      business,
      String(service._id),
      input.addonIds ?? [],
    );
    const addonsSubtotalCents = addons.reduce((sum, addon) => sum + addon.priceCents, 0);
    const financials: BookingFinancials =
      addonsSubtotalCents > 0 || travelFeeCents > 0
        ? // Session 2+ is never a first/returning consumer: its extras use the unchanged legacy
          // deposit path and never read or write the financial relationship (P7 owns cleanup).
          this.assembleFinancials(
            "BOOKLY_MANAGED",
            [{ amountCents: 0, discountCents: 0, addons }],
            travelFeeCents,
          )
        : {
            currency: "EUR",
            servicesSubtotalCents: 0,
            addonsSubtotalCents: 0,
            serviceDiscountCents: 0,
            travelFeeCents: 0,
            eligiblePlatformFeeBasisCents: 0,
            platformFeeCents: 0,
            depositCents: 0,
            balanceDueCents: 0,
            totalCents: 0,
          };

    return {
      business,
      progress,
      originBooking,
      service,
      fulfilmentEntitlement,
      fulfilment,
      addons,
      financials,
    };
  }

  private resolvePackageRedemptionFulfilment(
    business: BusinessDocument,
    entitlement: PackageFulfilmentEntitlement,
    input: PackageRedemptionSelections,
  ): { fulfilment: BookingFulfilment; travelFeeCents: number } {
    if (entitlement.mode === "AT_BUSINESS_LOCATION") {
      const city = business.address.city;
      if (!businessCities.includes(city as BusinessCity)) {
        throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 500);
      }
      return {
        fulfilment: {
          mode: "AT_BUSINESS_LOCATION",
          businessLocation: {
            city: city as BusinessCity,
            area: business.address.area,
            streetName: business.address.streetName,
            streetNumber: business.address.streetNumber,
            floorUnit: business.address.floorUnit,
            aptRoom: business.address.aptRoom,
            location: resolveValidCoordinate(business.location),
          },
        },
        travelFeeCents: 0,
      };
    }

    if (!input.customerCity) {
      throw new AvailabilityError("AVAILABILITY_CITY_REQUIRED", 400);
    }
    if (!input.travelAddress || input.travelAddress.city !== input.customerCity) {
      throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 400);
    }
    const cityEntitlement = entitlement.travelCities?.find(
      (entry) => entry.city === input.customerCity,
    );
    if (!cityEntitlement) {
      throw new AvailabilityError("AVAILABILITY_CITY_NOT_SERVED", 409);
    }

    return {
      fulfilment: {
        mode: "TRAVEL_TO_CUSTOMER",
        travelAddress: {
          city: input.travelAddress.city,
          propertyType: input.travelAddress.propertyType,
          area: input.travelAddress.area,
          streetName: input.travelAddress.streetName,
          streetNumber: input.travelAddress.streetNumber,
          floorUnit: input.travelAddress.floorUnit,
          aptRoom: input.travelAddress.aptRoom,
          additionalDirections: input.travelAddress.additionalDirections,
        },
      },
      travelFeeCents: cityEntitlement.feeCents,
    };
  }

  private requirePackagePurchaseShape(input: CreateBookingInput): void {
    if (input.serviceLines.length !== 1) {
      throw new BookingError("BOOKING_PACKAGE_PURCHASE_INVALID_LINES", 400);
    }
  }

  private requirePackageServiceLine(line: ResolvedServiceLine): ResolvedServiceLine {
    if (!line.service.isPackageDeal) {
      throw new BookingError("BOOKING_PACKAGE_PURCHASE_INVALID_LINES", 400);
    }
    return line;
  }

  /**
   * Resolves the Customer's BusinessClient row for this Business — reuses an existing linked
   * row if one already exists (created earlier by the Business, or by a prior travel booking).
   * For a genuinely first-time Customer at this Business:
   *  - TRAVEL_TO_CUSTOMER: the travel address the Customer is already supplying is a
   *    reasonable, evidence-based source for the Client's `address` field, so a new Client row
   *    is created from it.
   *  - AT_BUSINESS_LOCATION (Batch 9 — confirmed product decision, corrects the Batch 3 gap
   *    this method previously threw BOOKING_CUSTOMER_CLIENT_PROFILE_REQUIRED for): there is NO
   *    structured address source anywhere in this codebase for a self-service Customer
   *    (CustomerProfile.address is free-text, not the structured city/area/street shape
   *    BusinessClientAddress requires) — asking the Customer for one purely to satisfy the
   *    schema would be irrelevant friction for a service that happens AT the venue. The Client
   *    row is created with `address` omitted (see BusinessClientDocument's own doc comment on
   *    why the field is optional) rather than blocking the booking; the Business can fill in a
   *    real address later if they choose to manage this Client manually.
   *
   * CONCURRENCY (Batch 9 completion pass — a real bug found and fixed here): two genuinely
   * concurrent first-booking attempts for the SAME Customer+Business (e.g. a double-click that
   * outraces the idempotency claim, or two browser tabs) both read "no existing Client" and both
   * attempt `create()`. Exactly one write wins — `client.model.ts`'s own unique indexes on
   * `(businessId, normalizedEmail)`, `(businessId, phone.e164)`, and the partial
   * `(businessId, linkedUserId)` index all guarantee that — but the LOSING call previously let a
   * raw, uncaught `MongoServerError` (code 11000) propagate all the way to the customer as an
   * opaque 500, even though its own money-safe ordering (this method runs BEFORE any Stripe
   * charge — see finalizeCustomerBooking) meant nothing was actually lost. This now mirrors the
   * exact self-healing idiom BookingCreationClaimRepository.claim() already established
   * elsewhere in this file's own module: catch the duplicate-key error and re-fetch. Re-fetching
   * by `linkedUserId` only (never by email/phone) is deliberate — a collision on email/phone
   * against a row NOT linked to this Customer is a genuinely different situation (e.g. the
   * Business separately holds an unrelated/unlinked walk-in Client with the same contact info)
   * that must never be silently auto-linked, since that would silently decide this Customer's
   * first-vs-returning relationship at this Business without any real evidence it's the same
   * person — a clear, distinct error is thrown instead.
   */
  private async resolveOrCreateCustomerClient(
    business: BusinessDocument,
    customerUserId: string,
    fulfilment: BookingFulfilment,
  ): Promise<BusinessClientDocument> {
    return resolveCustomerBusinessClient(
      this.clientRepository,
      this.userRepository,
      business,
      customerUserId,
      fulfilment,
    );
  }
  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  /**
   * Reserve-all-lines + persist the Booking (+ PackageProgress for a purchase) + write the upfront
   * ledger row typed by the Financial Contract (PLATFORM_FEE for a nonzero FIRST upfront; a P3
   * RETURNING purchase is €0 online and writes none — a pre-P3 RETURNING deposit was DEPOSIT)
   * + for FIRST consume the customer↔business relationship (FIRST_PENDING -> CONSUMED) + fence
   * the PaymentAttempt completion — all inside ONE transaction, the same pattern as
   * `persistBooking` (Manual). If the relationship consume CAS fails (ownership lost), the whole
   * transaction aborts: no Booking ever commits without consuming the first claim it was
   * charged under.
   */
  private async persistCustomerBooking(params: {
    bookingId: Types.ObjectId;
    business: BusinessDocument;
    customer: BookingCustomer;
    createdBy: BookingActor;
    fulfilment: BookingFulfilment;
    lines: ResolvedServiceLine[];
    financials: BookingFinancials;
    cancellationPolicySnapshot: BookingCancellationPolicySnapshot | undefined;
    noShowEligibilitySnapshot: BookingNoShowEligibilitySnapshot | undefined;
    startAt: Date;
    notes: string | undefined;
    idempotencyKey: string;
    client: BusinessClientDocument;
    contract: FinancialContract;
    paymentResult: PaymentIntentResult | undefined;
    resolvedPromo: ResolvedPromo | undefined;
    customerChargeNowCents: number;
    packageProgressCreate?: CreatePackageProgressInput | undefined;
    persistenceLeaseToken: string | undefined;
  }): Promise<BookingDocument> {
    const isFirst = params.contract.classification === "FIRST";
    const dbSession = await mongoose.startSession();
    let created: BookingDocument | undefined;
    let succeededTransactionId: Types.ObjectId | undefined;
    let succeededTransaction: BookingFinancialTransactionDocument | undefined;

    try {
      const recovered = await this.runBookingTransaction(
        dbSession,
        async () => {
          const currentBusiness = await acquireSchedulingAdmission(params.business, dbSession);
          for (const line of params.lines) {
            await validateSchedulingLine(
              {
                business: currentBusiness,
                serviceId: line.service._id,
                staffMembershipId: line.staffMembership._id,
                startAt: params.startAt,
                endAt: line.endAt,
                partySize: line.partySize,
                capacityMax: line.capacityMax,
                allowInactive: false,
                expectedService: line.service,
                fulfilment: params.fulfilment,
              },
              this.availabilityService,
              dbSession,
            );
          }
          const reservationsByLineIndex = new Map<number, Types.ObjectId>();

          for (const [index, line] of [...params.lines.entries()].sort(
            (a, b) =>
              String(a[1].staffMembership._id).localeCompare(String(b[1].staffMembership._id)) ||
              a[1].endAt.getTime() - b[1].endAt.getTime() ||
              a[0] - b[0],
          )) {
            const reservation = await this.reservationService.reserveOrJoin(
              {
                businessId: params.business._id,
                staffMembershipId: line.staffMembership._id,
                serviceId: line.service._id,
                timezone: params.business.timezone,
                startAt: params.startAt,
                endAt: line.endAt,
                capacityMax: line.capacityMax,
                partySize: line.partySize,
                idempotencyKey: `${params.idempotencyKey}:${index}`,
              },
              dbSession,
            );
            reservationsByLineIndex.set(index, reservation.reservationId);
          }

          const reference = await this.generateUniqueReference();
          const overallEndAt = params.lines.reduce(
            (max, line) => (line.endAt > max ? line.endAt : max),
            params.lines[0]?.endAt ?? params.startAt,
          );
          const sessionEndReminderSnapshot = this.buildSessionEndReminderSnapshot(
            params.lines,
            overallEndAt,
          );

          const serviceLines: BookingServiceLine[] = params.lines.map((line, index) => ({
            serviceId: line.service._id,
            serviceSnapshot: line.serviceSnapshot,
            ...(line.staffSnapshot ? { staffSnapshot: line.staffSnapshot } : {}),
            pricingInput: line.pricingInput,
            responsibleStaffMembershipId: line.staffMembership._id,
            addons: line.addons,
            amountCents: line.amountCents,
            reservationId: reservationsByLineIndex.get(index) as Types.ObjectId,
            reservationOperationKey: `${params.idempotencyKey}:${index}`,
          }));

          // P1 — first/returning was decided atomically BEFORE the charge (the relationship claim)
          // and frozen in the Financial Contract, so there is no post-charge race left to
          // resolve here: the previous `markActivated`-decides-the-ledger-after-money-moved
          // pattern is gone. A concurrent competing first operation never reached a charge.
          // `hasDepositObligation` (not `paymentResult` truthiness) gates ledger-writing: a zero
          // obligation (P2: e.g. a 100% promo on a FIRST booking) writes no ledger row.
          const hasDepositObligation = params.financials.depositCents > 0;
          const financials = params.financials;

          // The authoritative, atomic usage consumption — only here, inside the persistence
          // transaction (no pre-payment reservation); an ALL_FIRST_BOOKINGS promo re-validates
          // against the authoritative classification. A rollback removes the consumption.
          if (params.resolvedPromo) {
            await this.promoApplicationService.claimRedemption(
              {
                resolved: params.resolvedPromo,
                requiredUpfrontCents: params.contract.requiredUpfrontCents,
                bookingId: params.bookingId,
                businessId: params.business._id,
                customerUserId: params.createdBy.actorUserId,
                isFirstBooking: isFirst,
              },
              dbSession,
            );
          }

          created = await this.bookingRepository.create(
            {
              _id: params.bookingId,
              businessId: params.business._id,
              reference,
              source: "BOOKLY_MANAGED",
              status: "UPCOMING",
              customer: params.customer,
              createdBy: params.createdBy,
              fulfilment: params.fulfilment,
              serviceLines,
              financials,
              schedule: {
                timezone: params.business.timezone,
                startAt: params.startAt,
                endAt: overallEndAt,
              },
              customerRescheduleCount: 0,
              rescheduleHistory: [],
              eventHistory: [
                {
                  type: "CREATED",
                  nextStatus: "UPCOMING",
                  actorUserId: params.createdBy.actorUserId,
                  actorRole: params.createdBy.actorRole,
                  createdAt: new Date(),
                },
              ],
              ...(params.cancellationPolicySnapshot
                ? { cancellationPolicySnapshot: params.cancellationPolicySnapshot }
                : {}),
              ...(params.noShowEligibilitySnapshot
                ? { noShowEligibilitySnapshot: params.noShowEligibilitySnapshot }
                : {}),
              sessionEndReminderSnapshot,
              ...(params.notes ? { notes: params.notes } : {}),
              ...(params.resolvedPromo
                ? {
                    promo: {
                      promoId: params.resolvedPromo.promo._id,
                      code: params.resolvedPromo.promo.code,
                      type: params.resolvedPromo.promo.type,
                      value: params.resolvedPromo.promo.value,
                      discountCents: params.resolvedPromo.promoDiscountCents,
                      chargeCents: params.customerChargeNowCents,
                      // P2 — only a V3 contract can carry a promo (see establishFinancialTerms).
                      fundingOwner: "BUSINESS" as const,
                      appliedAt: new Date(),
                    },
                  }
                : {}),
              financialContract: params.contract,
            },
            dbSession,
          );

          if (params.packageProgressCreate) {
            await this.requirePackageProgressRepository().create(
              params.packageProgressCreate,
              dbSession,
            );
          }

          if (hasDepositObligation) {
            // The upfront charge — the ledger TYPE alone records who economically owns it (see
            // BookingFinancials's own doc comment): PLATFORM_FEE for the genuine first purchase.
            // Since P3 a RETURNING purchase has no upfront at all (depositCents 0), so this block
            // never runs for it; DEPOSIT remains the contract's ledger type for RETURNING and is
            // only ever found on pre-P3 history. `amountCents` is the amount ACTUALLY charged
            // (P2: the full upfront computed on the promo-discounted price, never upfront − promo)
            // — every downstream reader of "the customer's upfront payment" (cancellation/no-show
            // netting, refunds — see BookingFinancialTransactionService.findSucceededUpfrontPayment)
            // reads this real ledger amount. Skipped entirely for a zero charge: the ledger
            // schema's own `amountCents` invariant requires a positive amount (a real, immutable
            // financial event must represent SOME money movement), so a fake €0 row is never
            // written.
            if (params.customerChargeNowCents > 0) {
              const transaction = await this.financialTransactionService.record(
                {
                  businessId: params.business._id,
                  bookingId: params.bookingId,
                  businessClientId: params.client._id,
                  customerUserId: params.createdBy.actorUserId,
                  // FIRST upfront is always Bookly's PLATFORM_FEE — exactly as the contract
                  // recorded before the charge (a P3 RETURNING contract never reaches here).
                  type: params.contract.upfrontLedgerType,
                  direction: "DEBIT",
                  amountCents: params.customerChargeNowCents,
                  currency: params.financials.currency,
                  status: "SUCCEEDED",
                  ...(params.paymentResult
                    ? { providerReference: params.paymentResult.paymentIntentId }
                    : {}),
                  idempotencyKey: `${params.idempotencyKey}:deposit`,
                },
                dbSession,
              );
              succeededTransactionId = transaction._id;
              succeededTransaction = transaction;
            }
            // P2 — no PROMO_SUBSIDY: the Business funds the promo (its booking price, and so its
            // entitlement, is already discounted). The ledger type stays readable for Batch 13
            // history only.
          }

          // P1 — FIRST_PENDING -> CONSUMED in this SAME transaction, fenced on this exact logical
          // operation and its bound PaymentAttempt (none for a zero-upfront FIRST). Losing the
          // claim aborts the whole transaction (the caller then compensates any charge).
          if (isFirst) {
            const consumed = await this.relationships.consumeFirst(
              params.client._id,
              {
                idempotencyKey: params.idempotencyKey,
                bookingId: params.bookingId,
                productKind: params.contract.productKind,
                paymentAttemptId: params.paymentResult?.paymentAttemptId,
                financialTransactionId: succeededTransactionId,
              },
              dbSession,
            );
            if (!consumed) throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
          }

          // F4A Tier 2 — confirmation intent commits with the Booking (last domain write,
          // before the PaymentAttempt completion fence; a failure takes the existing abort path).
          // Tier 3 — plus the payment facts this transaction actually holds.
          await this.recordBookingCreatedIntent(
            created,
            params.business,
            dbSession,
            await this.bookingPaymentEvidence(
              params.paymentResult,
              succeededTransaction,
              params.packageProgressCreate ? "PACKAGE_PURCHASE" : "BOOKING",
            ),
          );

          const completed = await this.paymentService.markPaymentCompleted(
            params.paymentResult?.paymentAttemptId,
            {
              bookingId: params.bookingId,
              ...(params.packageProgressCreate
                ? { packageProgressId: params.packageProgressCreate._id }
                : {}),
              ...(succeededTransactionId ? { succeededTransactionId } : {}),
            },
            params.persistenceLeaseToken,
            dbSession,
          );
          if (!completed) throw new Error("Payment persistence lease was lost");
        },
        () =>
          this.resolveCommittedBooking(
            {
              businessId: params.business._id,
              customerUserId: String(params.createdBy.actorUserId),
              idempotencyKey: params.idempotencyKey,
              kind: params.contract.productKind,
            },
            params.bookingId,
          ),
      );
      if (recovered) created = recovered;
    } catch (error) {
      if (error instanceof BookingPersistenceUnresolvedError) throw error;
      if (!params.paymentResult?.paymentAttemptId) {
        await this.claimRepository.releaseUncommitted({
          idempotencyKey: params.idempotencyKey,
          businessId: params.business._id,
          actorUserId: params.createdBy.actorUserId,
          bookingId: params.bookingId,
        });
      }

      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession().catch(() => undefined);
    }

    if (!created) {
      throw new Error("Booking creation failed without throwing");
    }

    await this.afterBookingCommitted(created, params.business);

    return created;
  }

  /**
   * The saga's compensating action: a real charge succeeded but the Booking could not be
   * persisted (a genuine post-payment reservation conflict, or any other failure). It first
   * records compensation-required, then creates/resumes a durable RefundOperation. Provider or
   * local persistence ambiguity remains recoverable by the money-recovery worker and never
   * masks the original booking error.
   */
  private async compensateFailedBookingAfterPayment(
    business: BusinessDocument,
    bookingId: Types.ObjectId,
    client: BusinessClientDocument,
    amountCents: number,
    paymentResult: PaymentIntentResult,
  ): Promise<void> {
    try {
      const refund = await this.paymentService.refund({
        paymentIntentId: paymentResult.paymentIntentId,
        amountCents,
        currency: "EUR",
        idempotencyKey: `refund:${paymentResult.paymentIntentId}:compensation`,
        reason: "requested_by_customer",
        domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
        sourcePaymentAttemptId: paymentResult.paymentAttemptId,
        bookingId,
        businessId: business._id,
        businessClientId: client._id,
        customerUserId: client.linkState === "LINKED" ? client.linkedUserId : undefined,
      });

      const ledger = await this.financialTransactionService.record({
        businessId: business._id,
        bookingId,
        businessClientId: client._id,
        customerUserId: client.linkState === "LINKED" ? client.linkedUserId : undefined,
        type: "REFUND",
        direction: "CREDIT",
        amountCents,
        currency: "EUR",
        status: refund.status === "succeeded" ? "SUCCEEDED" : "PENDING",
        providerReference: refund.refundId,
        idempotencyKey: `refund-operation:${refund.refundOperationId ?? refund.refundId}:ledger`,
        // Batch 8 — this refund unwinds a charge whose own ledger entry never durably
        // persisted (persistCustomerBooking's transaction rolled back before writing it), so
        // there is no sourceTransactionId to link to. Deliberately NOT attributed to either
        // Bookly or the Business (see finance-ownership.ts's own comment): the corresponding
        // charge was never counted as anyone's revenue in the first place, so nothing needs
        // reversing against either party's total.
        metadata: { sourceType: "COMPENSATION" },
      });
      if (refund.status === "succeeded") {
        await this.paymentService.markRefundLedgerSucceeded(refund.refundOperationId, ledger._id);
      }
    } catch {
      // Best-effort — a failed compensation is a real operational issue (an uncollectable/
      // orphan charge) that must be resolved by manual reconciliation using the
      // BookingFinancialTransaction ledger's PENDING PLATFORM_FEE row plus Stripe's own
      // dashboard, never by silently pretending the refund happened.
    }
  }

  // --- Shared: service-line resolution --------------------------------------------------------

  private async resolveServiceLines(
    business: BusinessDocument,
    startAt: Date,
    input: CreateBookingInput,
    // Additive, defaults to false for every pre-existing call site (createManualBooking,
    // previewCustomerBooking, finalizeCustomerBooking) — the BOOKING_PACKAGE_SERVICE_NOT_SUPPORTED_YET
    // guard below stays fully intact there. Only finalizePackagePurchase/previewPackagePurchase
    // pass `allowPackage: true`, and only for the one, single-line Package purchase path — never
    // for a normal multi-service booking mixing a package with anything else.
    options: { allowPackage?: boolean } = {},
  ): Promise<ResolvedServiceLine[]> {
    if (input.serviceLines.length === 0) {
      throw new BookingError("BOOKING_NO_SERVICE_LINES", 400);
    }

    const resolvedBeforeSnapshot: Array<Omit<ResolvedServiceLine, "staffSnapshot">> = [];

    for (const lineInput of input.serviceLines) {
      const { service, staffMembership } = await this.bookingService.validateResponsibleStaff(
        business,
        lineInput.serviceId,
        lineInput.staffMembershipId,
      );

      if (service.status !== "ACTIVE") {
        throw new BookingError("BOOKING_SERVICE_ARCHIVED", 409);
      }

      if (service.isPackageDeal && !options.allowPackage) {
        throw new BookingError("BOOKING_PACKAGE_SERVICE_NOT_SUPPORTED_YET", 409);
      }

      const addons = await this.bookingService.resolveAddonSnapshots(
        business,
        lineInput.serviceId,
        lineInput.addonIds,
      );

      const resolved = this.resolvePricingAndTiming(service, lineInput.pricingInput);
      const endAt = new Date(startAt.getTime() + resolved.occupiedMin * 60_000);

      await this.availabilityService.assertSlotIsBookable({
        business,
        service,
        staffMembership,
        startAt,
        endAt,
        partySize: resolved.partySize,
      });

      resolvedBeforeSnapshot.push({
        service,
        staffMembership,
        serviceSnapshot: {
          name: service.name,
          pricingMode: resolved.pricingMode,
          durationMin: resolved.occupiedMin,
          ...(resolved.discountPercent !== undefined
            ? { discountPercent: resolved.discountPercent }
            : {}),
        },
        pricingInput: resolved.pricingInputSnapshot,
        addons,
        amountCents: resolved.amountCents,
        discountCents: resolved.discountCents,
        capacityMax: resolved.capacityMax,
        partySize: resolved.partySize,
        endAt,
      });
    }

    // Batched — one profile lookup regardless of how many lines/staff this Booking has, never
    // one query per line (matches this codebase's established batched-lookup convention; see
    // ClientService.toClientDtos for the same pattern).
    const staffUserIds = [
      ...new Set(resolvedBeforeSnapshot.map((line) => String(line.staffMembership.userId))),
    ];
    const profiles = await this.userRepository.findProfilesByUserIds(staffUserIds);
    const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

    return resolvedBeforeSnapshot.map((line) => {
      const profile = profileByUserId.get(String(line.staffMembership.userId));
      return {
        ...line,
        staffSnapshot: profile
          ? { firstName: profile.firstName, lastName: profile.lastName }
          : undefined,
      };
    });
  }

  private resolvePricingAndTiming(
    service: ServiceDocument,
    pricingInput: CreateBookingInput["serviceLines"][number]["pricingInput"],
  ): {
    pricingMode: BookingServiceLine["serviceSnapshot"]["pricingMode"];
    pricingInputSnapshot: BookingServiceLine["pricingInput"];
    amountCents: number;
    discountCents: number;
    discountPercent?: number | undefined;
    occupiedMin: number;
    capacityMax: number;
    partySize: number;
  } {
    // A Package Deal Service has no `pricingMode` at all (forbidden by service.schema.ts when
    // isPackageDeal is true) — checked here, before the switch below, exactly the same way
    // AvailabilityService.resolveServiceConfig already branches on isPackageDeal first (see
    // availability.service.ts). `pricingInputSnapshot` is intentionally empty here — the real
    // sessionsInPackage/sessionIndex/packageProgressId are stamped onto the resolved line by
    // the caller (finalizePackagePurchase) only once the entitlement's ids are known, which
    // happens after this method returns.
    if (service.isPackageDeal) {
      const pricing = service.packagePricing;
      if (!pricing) {
        throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 409);
      }
      if (pricingInput.hours !== undefined || pricingInput.personCount !== undefined) {
        throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
      }

      // bundlePriceCents is ALREADY the final discounted package price the customer agreed to
      // pay (see service.model.ts's own doc comment on packagePricing.normalPricePerSessionCents,
      // and ServiceForm's "Bundle / discounted price" field) — unlike FIXED pricing's priceCents,
      // which is a pre-discount base price that discountPercent legitimately reduces further.
      // Applying discountCents here on top of bundlePriceCents would discount the package a
      // SECOND time (bundlePriceCents was already discounted from the normal total when the
      // Owner set it). discountPercent is still returned below — unaffected — as the
      // serviceSnapshot's display/historical metadata; it deliberately does not feed
      // `discountCents`, so assembleFinancials's `serviceDiscountCents` never touches a Package
      // line's amount.
      const amountCents = pricing.bundlePriceCents;

      return {
        pricingMode: "PACKAGE",
        pricingInputSnapshot: {},
        amountCents,
        discountCents: 0,
        ...(pricing.discountPercent !== undefined
          ? { discountPercent: pricing.discountPercent }
          : {}),
        occupiedMin:
          pricing.durationMin + (pricing.bufferAfterMin ?? 0) + (pricing.processingTimeMin ?? 0),
        capacityMax: 1,
        partySize: 1,
      };
    }

    switch (service.pricingMode) {
      case "FIXED": {
        const pricing = service.fixedPricing;
        if (!pricing) {
          throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 409);
        }
        if (pricingInput.hours !== undefined || pricingInput.personCount !== undefined) {
          throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
        }

        const amountCents = pricing.priceCents;
        const discountCents = pricing.discountPercent
          ? Math.round((amountCents * pricing.discountPercent) / 100)
          : 0;

        return {
          pricingMode: "FIXED",
          pricingInputSnapshot: {},
          amountCents,
          discountCents,
          ...(pricing.discountPercent !== undefined
            ? { discountPercent: pricing.discountPercent }
            : {}),
          occupiedMin:
            pricing.durationMin + (pricing.bufferAfterMin ?? 0) + (pricing.processingTimeMin ?? 0),
          capacityMax: 1,
          partySize: 1,
        };
      }
      case "HOURLY": {
        const pricing = service.hourlyPricing;
        if (!pricing) {
          throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 409);
        }
        if (pricingInput.personCount !== undefined) {
          throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
        }
        const hours = pricingInput.hours;
        if (typeof hours !== "number" || hours < pricing.minHours || hours > pricing.maxHours) {
          throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
        }

        return {
          pricingMode: "HOURLY",
          pricingInputSnapshot: { hours },
          amountCents: Math.round(pricing.ratePerHourCents * hours),
          discountCents: 0,
          occupiedMin: hours * 60 + (pricing.bufferAfterMin ?? 0),
          capacityMax: 1,
          partySize: 1,
        };
      }
      case "PER_PERSON": {
        const pricing = service.perPersonPricing;
        if (!pricing) {
          throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 409);
        }
        if (pricingInput.hours !== undefined) {
          throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
        }
        const personCount = pricingInput.personCount;
        if (
          typeof personCount !== "number" ||
          !Number.isInteger(personCount) ||
          personCount < pricing.minPersons ||
          personCount > pricing.maxPersons
        ) {
          throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
        }

        return {
          pricingMode: "PER_PERSON",
          pricingInputSnapshot: { personCount },
          amountCents: pricing.ratePerPersonCents * personCount,
          discountCents: 0,
          occupiedMin: pricing.durationMin + (pricing.bufferAfterMin ?? 0),
          capacityMax: pricing.maxPersons,
          partySize: personCount,
        };
      }
      default:
        throw new BookingError("BOOKING_PRICING_INPUT_INVALID", 400);
    }
  }

  // --- Shared: fulfilment / financials / policy snapshot -------------------------------------

  private async resolveFulfilment(
    business: BusinessDocument,
    input: CreateBookingInput,
  ): Promise<BookingFulfilment> {
    const mode = normalizeBusinessVisitType(business.visitType);

    if (mode === "AT_BUSINESS_LOCATION") {
      const city = business.address.city;
      if (!businessCities.includes(city as BusinessCity)) {
        throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 500);
      }

      return {
        mode,
        businessLocation: {
          city: city as BusinessCity,
          area: business.address.area,
          streetName: business.address.streetName,
          streetNumber: business.address.streetNumber,
          floorUnit: business.address.floorUnit,
          aptRoom: business.address.aptRoom,
          // Frozen at booking-creation time only — see BookingLocationSnapshot's own doc
          // comment. Never re-read/re-derived after this; a later Business.location change
          // must never reach an already-created Booking.
          location: resolveValidCoordinate(business.location),
        },
      };
    }

    if (!input.travelAddress) {
      throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 400);
    }

    return {
      mode,
      travelAddress: {
        city: input.travelAddress.city,
        propertyType: input.travelAddress.propertyType,
        area: input.travelAddress.area,
        streetName: input.travelAddress.streetName,
        streetNumber: input.travelAddress.streetNumber,
        floorUnit: input.travelAddress.floorUnit,
        aptRoom: input.travelAddress.aptRoom,
        additionalDirections: input.travelAddress.additionalDirections,
        // No real customer/travel coordinate is ever supplied at booking creation today (see
        // CreateBookingTravelAddressInput — address text only) — deliberately NOT geocoded here
        // to manufacture one; `location` simply stays undefined until a real source exists.
      },
    };
  }

  /**
   * Mandatory write-time re-validation of travel eligibility and fee (item — never trusts a
   * client-supplied fee, and never trusts an earlier Availability read: both could be stale by
   * the time this write actually happens). Reuses AvailabilityService.requireServedCity
   * verbatim per service line — never duplicated. Returns 0 for an AT_BUSINESS_LOCATION
   * Business (no travel occurs) without any lookup.
   */
  private async requireTravelEligibilityAndFee(
    business: BusinessDocument,
    lines: ResolvedServiceLine[],
    customerCity: BusinessCity | undefined,
  ): Promise<number> {
    if (normalizeBusinessVisitType(business.visitType) !== "TRAVEL_TO_CUSTOMER") {
      return 0;
    }

    for (const line of lines) {
      await this.availabilityService.requireServedCity(business, line.service, customerCity);
    }

    const settings = await this.businessTravelSettingsRepository.findByBusinessId(business._id);
    const citySetting = settings?.cities.find((entry) => entry.city === customerCity);
    return citySetting?.feeCents ?? 0;
  }

  /**
   * The shared price snapshot (totals, the eligible basis, and the legacy clamp(20%, €5, €35)
   * deposit). Used as-is for MANUAL (no deposit — rule E) and package Session 2+ extras (their
   * unchanged legacy deposit). For relationship-classified purchases it is only the starting
   * point — see assembleCustomerFinancials, which sets the FIRST upfront or the P3 €0
   * RETURNING upfront from the relationship's authoritative classification.
   */
  private assembleFinancials(
    source: BookingSource,
    lines: Array<Pick<ResolvedServiceLine, "amountCents" | "discountCents" | "addons">>,
    travelFeeCents: number,
    promoDiscountCents?: number | undefined,
  ): BookingFinancials {
    const servicesSubtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
    const addonsSubtotalCents = lines.reduce(
      (sum, line) => sum + line.addons.reduce((s, a) => s + a.priceCents, 0),
      0,
    );
    const serviceDiscountCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
    // P2 — a (normal-booking-only) promo discounts the price AFTER the service discount and
    // BEFORE any deposit is computed; travel is never discounted. Without a promo this is the
    // unchanged legacy basis.
    const eligiblePlatformFeeBasisCents =
      servicesSubtotalCents +
      addonsSubtotalCents -
      serviceDiscountCents -
      (promoDiscountCents ?? 0);

    // The deposit: charged online for EVERY BOOKLY_MANAGED booking (confirmed rule, Batch 6.5)
    // — never gated on first/returning. A MANUAL Booking never has one (rule E).
    const depositCents =
      source === "MANUAL"
        ? 0
        : this.bookingService.calculateBookingDepositCents(eligiblePlatformFeeBasisCents);

    // Bookly's own economic claim — only ever set for a FIRST operation, by
    // assembleCustomerFinancials. Every snapshot built here is Business-owned or MANUAL.
    const platformFeeCents = 0;

    // Customer-facing total deliberately excludes platformFeeCents (see this service's own
    // module doc comment and the Batch 3 final report): the platform fee is Bookly's own cut of
    // money the customer already pays via the deposit (or, for a returning customer, is a cut
    // Bookly does NOT take at all) — never an extra line the customer pays on top.
    // travelFeeCents IS included: unlike the platform fee, it belongs to the Business/provider
    // (see BookingFinancials's own model comment), i.e. it is genuinely part of what the
    // customer owes for this appointment.
    const totalCents = eligiblePlatformFeeBasisCents + travelFeeCents;
    const balanceDueCents = totalCents - depositCents;

    return {
      currency: "EUR",
      servicesSubtotalCents,
      addonsSubtotalCents,
      serviceDiscountCents,
      ...(promoDiscountCents !== undefined ? { promoDiscountCents } : {}),
      travelFeeCents,
      eligiblePlatformFeeBasisCents,
      platformFeeCents,
      depositCents,
      balanceDueCents,
      totalCents,
    };
  }

  /**
   * P1 — customer booking / package purchase financials from the relationship classification
   * (ONE shared customer↔business relationship — whichever purchase kind consumes it first is
   * FIRST; every later normal booking AND package purchase is RETURNING).
   *
   *  - RETURNING (P3): €0 online for BOTH a normal booking and a package purchase — no deposit,
   *    no platform fee; the full total (incl. add-ons and travel) is the venue balance. The
   *    eligible basis is unchanged (normal: the promo-discounted price; package: bundle +
   *    add-ons) and stays the cancellation/no-show basis.
   *  - FIRST uses the canonical first upfront (calculateFirstUpfrontCents — 20%, €5 floor, €35
   *    cap, never above the basis) on the FIRST basis: normal = services + eligible add-ons −
   *    service discount; package = `Service.packagePricing.bundlePriceCents` ONLY (add-ons and
   *    travel never expand Bookly's first upfront). Bookly-owned: platformFeeCents = upfront.
   *
   * Travel is excluded from every basis. Add-ons/travel remain in totalCents/balanceDueCents as
   * the Business-collected balance. `eligiblePlatformFeeBasisCents` is the cancellation/no-show
   * basis; the FIRST basis is returned separately and recorded in the Financial Contract.
   *
   * P2 — `promoDiscountCents` (normal bookings only; never with `packageBundlePriceCents`)
   * discounts the normal price first, so the FIRST upfront is computed from the discounted
   * price, and that discounted price is also the stored cancellation/no-show basis and the
   * booking total (plus travel).
   *
   * Never used by MANUAL or package Session 2+ (both call assembleFinancials directly).
   */
  private assembleCustomerFinancials(
    lines: Array<Pick<ResolvedServiceLine, "amountCents" | "discountCents" | "addons">>,
    travelFeeCents: number,
    classification: RelationshipClassification,
    packageBundlePriceCents: number | undefined,
    promoDiscountCents?: number | undefined,
  ): { financials: BookingFinancials; eligibleBasisCents: number } {
    const returning = this.assembleFinancials(
      "BOOKLY_MANAGED",
      lines,
      travelFeeCents,
      promoDiscountCents,
    );
    if (classification === "RETURNING") {
      return {
        financials: {
          ...returning,
          depositCents: 0,
          platformFeeCents: 0,
          balanceDueCents: returning.totalCents,
        },
        eligibleBasisCents: returning.eligiblePlatformFeeBasisCents,
      };
    }

    const eligibleBasisCents = packageBundlePriceCents ?? returning.eligiblePlatformFeeBasisCents;
    const upfrontCents = calculateFirstUpfrontCents(eligibleBasisCents);
    return {
      financials: {
        ...returning,
        depositCents: upfrontCents,
        platformFeeCents: upfrontCents,
        balanceDueCents: returning.totalCents - upfrontCents,
      },
      eligibleBasisCents,
    };
  }

  /** V3 for every new NORMAL booking (P2 promo economics). A package purchase stays V2 (it never
   * carries a promo); a normal operation recorded under V2 before P2 resumes under V2. */
  private financialContractVersionFor(
    productKind: FinancialContractProductKind,
    existingContract: FinancialContract | undefined,
  ): FinancialContractVersion {
    if (productKind === "PACKAGE_PURCHASE") return FINANCIAL_CONTRACT_V2;
    return existingContract?.version === FINANCIAL_CONTRACT_V2
      ? FINANCIAL_CONTRACT_V2
      : FINANCIAL_CONTRACT_V3;
  }

  /**
   * P1 — the authoritative classification + immutable Financial Contract for one logical
   * operation, established AFTER the BookingCreationClaim exists and BEFORE any tax compute or
   * provider charge. The relationship claim (ELIGIBLE -> FIRST_PENDING) happens first; a
   * competing first operation gets BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS here with nothing
   * charged. Any later failure in this stage is a proven pre-money failure and releases a FIRST
   * claim this operation holds (a bound one defers to its durable PaymentAttempt state).
   *
   * P2 — the promo is re-resolved from scratch on every attempt (an expired/deactivated/
   * exhausted promo fails here) and its identity + economics are frozen in the V3 contract, so a
   * resumed operation whose promo was edited or replaced — even by an equal discount — fails
   * closed in recordFinancialContract. Never repriced: a captured charge is left to P0
   * compensation.
   */
  private async establishFinancialTerms(params: {
    business: BusinessDocument;
    client: BusinessClientDocument;
    customerUserId: string;
    idempotencyKey: string;
    bookingId: Types.ObjectId;
    productKind: FinancialContractProductKind;
    existingContract: FinancialContract | undefined;
    lines: ResolvedServiceLine[];
    travelFeeCents: number;
    packageBundlePriceCents?: number | undefined;
    promoCode?: string | undefined;
  }): Promise<EstablishedFinancialTerms> {
    const customerUserId = new Types.ObjectId(params.customerUserId);
    const classification = await this.relationships.resolveForFinalize({
      client: params.client,
      identity: {
        idempotencyKey: params.idempotencyKey,
        bookingId: params.bookingId,
        customerUserId,
        productKind: params.productKind,
      },
      existingContract: params.existingContract,
    });

    try {
      const version = this.financialContractVersionFor(params.productKind, params.existingContract);
      // A pre-P2 (V2) promo operation discounted only its upfront — terms P2 no longer produces.
      // It can never be reproduced exactly, so it fails closed (P0 compensates any capture).
      if (
        version === FINANCIAL_CONTRACT_V2 &&
        (params.promoCode !== undefined || (params.existingContract?.promoDiscountCents ?? 0) > 0)
      ) {
        throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
      }

      // The normal promo-eligible price: services + add-ons − service discount (travel excluded).
      const promoEligibleBaseCents = this.assembleFinancials(
        "BOOKLY_MANAGED",
        params.lines,
        params.travelFeeCents,
      ).eligiblePlatformFeeBasisCents;
      // Re-validated from scratch against the AUTHORITATIVE classification (never a prior
      // preview), so an ALL_FIRST_BOOKINGS promo can never be resolved against an optimistic
      // guess that a race later disproves.
      const resolvedPromo = params.promoCode
        ? await this.promoApplicationService.resolve({
            code: params.promoCode,
            business: params.business,
            customerUserId: params.customerUserId,
            isFirstBooking: classification === "FIRST",
            promoEligibleBaseCents,
          })
        : undefined;

      const { financials, eligibleBasisCents } = this.assembleCustomerFinancials(
        params.lines,
        params.travelFeeCents,
        classification,
        params.packageBundlePriceCents,
        resolvedPromo?.promoDiscountCents,
      );

      const contract: FinancialContract = {
        version,
        productKind: params.productKind,
        classification,
        idempotencyKey: params.idempotencyKey,
        bookingId: params.bookingId,
        customerUserId,
        businessId: params.business._id,
        businessClientId: params.client._id,
        currency: financials.currency,
        eligibleBasisCents,
        ...(version === FINANCIAL_CONTRACT_V3 ? { promoEligibleBaseCents } : {}),
        requiredUpfrontCents: financials.depositCents,
        promoDiscountCents: resolvedPromo?.promoDiscountCents ?? 0,
        // P2 — the promo already lowered the price, so the whole upfront is charged online.
        onlineChargeCents: financials.depositCents,
        travelFeeCents: financials.travelFeeCents,
        ...(params.packageBundlePriceCents !== undefined
          ? { packageBundlePriceCents: params.packageBundlePriceCents }
          : {}),
        bookingTotalCents: financials.totalCents,
        upfrontLedgerType: classification === "FIRST" ? "PLATFORM_FEE" : "DEPOSIT",
        ...(resolvedPromo
          ? {
              promo: {
                promoId: resolvedPromo.promo._id,
                normalizedCode: resolvedPromo.promo.normalizedCode,
                type: resolvedPromo.promo.type,
                value: resolvedPromo.promo.value,
                fundingOwner: "BUSINESS" as const,
              },
            }
          : {}),
      };
      await this.claimRepository.recordFinancialContract(params.idempotencyKey, contract);
      return { financials, resolvedPromo, contract };
    } catch (error) {
      if (classification === "FIRST") {
        await this.releaseFirstClaimAfterPreMoneyFailure(params.client, params.idempotencyKey);
      }
      throw error;
    }
  }

  /** Never masks the caller's original error. An unbound claim is released immediately; a bound
   * one defers to durable PaymentAttempt state (ambiguous/requires_action stays protected). */
  private async releaseFirstClaimAfterPreMoneyFailure(
    client: BusinessClientDocument,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await this.relationships.releaseAfterPreMoneyFailure(client._id, idempotencyKey);
    } catch {
      await this.relationships.reconcileQuietly(client._id);
    }
  }

  /** The upfront charge for a contract-bearing operation. A FIRST charge binds its PaymentAttempt
   * to the relationship claim BEFORE any provider dispatch (fencing: an operation that lost its
   * claim can never create a PaymentIntent). */
  private async chargeContractUpfront(params: {
    customerUserId: string;
    business: BusinessDocument;
    client: BusinessClientDocument;
    contract: FinancialContract;
    purpose: Extract<PaymentIntentPurpose, "BOOKING_DEPOSIT" | "PACKAGE_PURCHASE">;
    computedTax: ComputedTax | undefined;
  }): Promise<PaymentIntentResult> {
    const { contract, client } = params;
    const correlation = {
      version: contract.version,
      classification: contract.classification,
      productKind: contract.productKind,
    };
    return this.paymentService.chargeBookingDeposit({
      userId: params.customerUserId,
      amountCents: contract.onlineChargeCents,
      idempotencyKey: contract.idempotencyKey,
      metadata: buildPaymentIntentMetadata({
        bookingId: String(contract.bookingId),
        businessId: String(params.business._id),
        businessClientId: String(client._id),
        purpose: params.purpose,
        preTaxChargeCents: contract.onlineChargeCents,
        taxCents: params.computedTax?.taxCents ?? 0,
        chargedAmountCents: contract.onlineChargeCents,
        taxCalculationId: params.computedTax?.taxCalculationId,
        taxMode: "PRE_ACTIVATION",
        financialContract: correlation,
      }),
      financialContract: { ...correlation, businessClientId: client._id },
      ...(contract.classification === "FIRST"
        ? {
            beforeProviderDispatch: (attempt: { _id: Types.ObjectId }) =>
              this.relationships.bindPaymentAttempt(
                client._id,
                contract.idempotencyKey,
                attempt._id,
              ),
          }
        : {}),
    });
  }

  private async resolveCancellationPolicySnapshot(
    business: BusinessDocument,
  ): Promise<BookingCancellationPolicySnapshot | undefined> {
    const policy = await this.businessCancellationPolicyRepository.findByBusinessId(business._id);
    if (!policy) {
      return undefined;
    }

    return {
      tiers: policy.tiers.map((tier) => ({
        tier: tier.tier,
        mode: tier.mode,
        ...(tier.percentage !== undefined ? { percentage: tier.percentage } : {}),
      })),
      noShowPercentage: policy.noShowPercentage,
    };
  }

  private buildCustomerSnapshot(client: BusinessClientDocument): BookingCustomer {
    return {
      businessClientId: client._id,
      customerUserId: client.linkState === "LINKED" ? client.linkedUserId : undefined,
      contact: {
        firstName: client.firstName,
        lastName: client.lastName,
        normalizedEmail: client.normalizedEmail,
        phone: client.phone,
      },
    };
  }

  // --- Persistence (Manual only) --------------------------------------------------------------

  private async persistBooking(params: {
    business: BusinessDocument;
    source: BookingSource;
    customer: BookingCustomer;
    createdBy: BookingActor;
    fulfilment: BookingFulfilment;
    lines: ResolvedServiceLine[];
    financials: BookingFinancials;
    cancellationPolicySnapshot: BookingCancellationPolicySnapshot | undefined;
    noShowEligibilitySnapshot: BookingNoShowEligibilitySnapshot | undefined;
    startAt: Date;
    notes: string | undefined;
    idempotencyKey: string;
    actorUserId: string;
  }): Promise<BookingDocument> {
    const bookingId = new Types.ObjectId();

    const claimResult = await this.claimRepository.claim({
      idempotencyKey: params.idempotencyKey,
      businessId: params.business._id,
      actorUserId: new Types.ObjectId(params.actorUserId),
      bookingId,
    });

    if (!claimResult.isNew) {
      return this.awaitIdempotentBooking(
        { ...params, manualActorUserId: params.actorUserId },
        claimResult.bookingId,
      );
    }

    const dbSession = await mongoose.startSession().catch(async (error) => {
      await this.claimRepository.releaseUncommitted({
        idempotencyKey: params.idempotencyKey,
        businessId: params.business._id,
        actorUserId: new Types.ObjectId(params.actorUserId),
        bookingId,
      });
      throw error;
    });
    let created: BookingDocument | undefined;

    try {
      const recovered = await this.runBookingTransaction(
        dbSession,
        async () => {
          const currentBusiness = await acquireSchedulingAdmission(params.business, dbSession);
          for (const line of params.lines) {
            await validateSchedulingLine(
              {
                business: currentBusiness,
                serviceId: line.service._id,
                staffMembershipId: line.staffMembership._id,
                startAt: params.startAt,
                endAt: line.endAt,
                partySize: line.partySize,
                capacityMax: line.capacityMax,
                allowInactive: false,
                expectedService: line.service,
                fulfilment: params.fulfilment,
              },
              this.availabilityService,
              dbSession,
            );
          }
          const reservationsByLineIndex = new Map<number, Types.ObjectId>();

          for (const [index, line] of [...params.lines.entries()].sort(
            (a, b) =>
              String(a[1].staffMembership._id).localeCompare(String(b[1].staffMembership._id)) ||
              a[1].endAt.getTime() - b[1].endAt.getTime() ||
              a[0] - b[0],
          )) {
            const reservation = await this.reservationService.reserveOrJoin(
              {
                businessId: params.business._id,
                staffMembershipId: line.staffMembership._id,
                serviceId: line.service._id,
                timezone: params.business.timezone,
                startAt: params.startAt,
                endAt: line.endAt,
                capacityMax: line.capacityMax,
                partySize: line.partySize,
                idempotencyKey: `${params.idempotencyKey}:${index}`,
              },
              dbSession,
            );
            reservationsByLineIndex.set(index, reservation.reservationId);
          }

          const reference = await this.generateUniqueReference();
          const overallEndAt = params.lines.reduce(
            (max, line) => (line.endAt > max ? line.endAt : max),
            params.lines[0]?.endAt ?? params.startAt,
          );
          const sessionEndReminderSnapshot = this.buildSessionEndReminderSnapshot(
            params.lines,
            overallEndAt,
          );

          const serviceLines: BookingServiceLine[] = params.lines.map((line, index) => ({
            serviceId: line.service._id,
            serviceSnapshot: line.serviceSnapshot,
            ...(line.staffSnapshot ? { staffSnapshot: line.staffSnapshot } : {}),
            pricingInput: line.pricingInput,
            responsibleStaffMembershipId: line.staffMembership._id,
            addons: line.addons,
            amountCents: line.amountCents,
            reservationId: reservationsByLineIndex.get(index) as Types.ObjectId,
            reservationOperationKey: `${params.idempotencyKey}:${index}`,
          }));

          created = await this.bookingRepository.create(
            {
              _id: bookingId,
              businessId: params.business._id,
              reference,
              source: params.source,
              status: "UPCOMING",
              customer: params.customer,
              createdBy: params.createdBy,
              fulfilment: params.fulfilment,
              serviceLines,
              financials: params.financials,
              schedule: {
                timezone: params.business.timezone,
                startAt: params.startAt,
                endAt: overallEndAt,
              },
              customerRescheduleCount: 0,
              rescheduleHistory: [],
              eventHistory: [
                {
                  type: "CREATED",
                  nextStatus: "UPCOMING",
                  actorUserId: params.createdBy.actorUserId,
                  actorRole: params.createdBy.actorRole,
                  createdAt: new Date(),
                },
              ],
              ...(params.cancellationPolicySnapshot
                ? { cancellationPolicySnapshot: params.cancellationPolicySnapshot }
                : {}),
              ...(params.noShowEligibilitySnapshot
                ? { noShowEligibilitySnapshot: params.noShowEligibilitySnapshot }
                : {}),
              sessionEndReminderSnapshot,
              ...(params.notes ? { notes: params.notes } : {}),
            },
            dbSession,
          );

          // F4A Tier 2 — confirmation intent commits with the Booking (last write).
          // Tier 3 — a MANUAL Booking never creates a PaymentIntent.
          await this.recordBookingCreatedIntent(created, params.business, dbSession, {
            kind: "NONE",
          });
        },
        () =>
          this.resolveManualBooking(
            params.business._id,
            params.idempotencyKey,
            params.actorUserId,
            bookingId,
            true,
          ),
      );
      if (recovered) created = recovered;
    } catch (error) {
      if (error instanceof BookingPersistenceUnresolvedError) throw error;
      await this.claimRepository.releaseUncommitted({
        idempotencyKey: params.idempotencyKey,
        businessId: params.business._id,
        actorUserId: new Types.ObjectId(params.actorUserId),
        bookingId,
      });

      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession().catch(() => undefined);
    }

    if (!created) {
      throw new Error("Booking creation failed without throwing");
    }

    await this.afterBookingCommitted(created, params.business);

    return created;
  }

  private persistenceLeaseActive(attempt: {
    persistenceStatus: string;
    persistenceLeaseExpiresAt?: Date | undefined;
  }) {
    return (
      attempt.persistenceStatus === "PERSISTING" &&
      !!attempt.persistenceLeaseExpiresAt &&
      attempt.persistenceLeaseExpiresAt.getTime() > Date.now()
    );
  }

  /** Driver owns callback/commit retries. Our callbacks never commit themselves. Once
   * a callback finishes, an exception is NOT proof of abort (including an unlabelled
   * timeout). Preserve the operation unless an authorized complete winner is readable. */
  private async runBookingTransaction(
    session: ClientSession,
    work: () => Promise<void>,
    resolveWinner: () => Promise<BookingDocument | null>,
  ): Promise<BookingDocument | undefined> {
    let callbackCompleted = false;
    try {
      await session.withTransaction(async () => {
        // The driver only restarts the callback after a definite transient abort;
        // unknown commit results retry commit, not the application callback.
        callbackCompleted = false;
        await work();
        callbackCompleted = true;
      });
      return undefined;
    } catch (error) {
      const unknown =
        error instanceof mongoose.mongo.MongoError &&
        error.hasErrorLabel("UnknownTransactionCommitResult");
      if (!callbackCompleted && !unknown) throw error;
      try {
        const winner = await resolveWinner();
        if (winner) return winner;
      } catch {
        // Read failure, absence or conflicting evidence cannot establish rollback.
      }
      throw new BookingPersistenceUnresolvedError();
    }
  }

  private async hasLegacyResult(booking: BookingDocument): Promise<boolean> {
    const line = booking.serviceLines.length === 1 ? booking.serviceLines[0] : undefined;
    if (line?.serviceSnapshot.pricingMode !== "PACKAGE") return true;
    if (!line.pricingInput.packageProgressId || !booking.customer.customerUserId) return false;
    const progress = await this.requirePackageProgressRepository().findByIdForCustomerAndBusiness(
      line.pricingInput.packageProgressId,
      booking.businessId,
      booking.customer.customerUserId,
    );
    return (
      !!progress &&
      String(progress.businessClientId) === String(booking.customer.businessClientId) &&
      String(progress.serviceId) === String(line.serviceId) &&
      (line.pricingInput.sessionIndex !== 1 ||
        String(progress.originBookingId) === String(booking._id)) &&
      progress.sessions.some(
        (entry) =>
          String(entry.bookingId) === String(booking._id) &&
          entry.sessionIndex === line.pricingInput.sessionIndex,
      )
    );
  }

  private async hasCommittedReservations(booking: BookingDocument): Promise<boolean> {
    for (const line of booking.serviceLines) {
      const row = await BookingSlotReservationModel.exists({
        businessId: booking.businessId,
        staffMembershipId: line.responsibleStaffMembershipId,
        intervals: { $elemMatch: { reservationId: line.reservationId, serviceId: line.serviceId } },
      }).read("primary");
      if (!row) return false;
    }
    return true;
  }

  private async resolveCommittedBooking(scope: CustomerReplayScope, bookingId: Types.ObjectId) {
    const { booking } = await this.readCustomerReplay(scope, bookingId, false);
    if (!booking || !(await this.hasCommittedReservations(booking))) return null;
    const attempt = await this.paymentService.findPaymentAttempt(scope.idempotencyKey);
    if (
      attempt &&
      (attempt.persistenceStatus !== "COMPLETED" ||
        attempt.providerStatus !== "SUCCEEDED" ||
        attempt.compensationStatus !== "NOT_REQUIRED" ||
        String(attempt.bookingId) !== String(bookingId) ||
        String(attempt.businessId) !== String(scope.businessId) ||
        String(attempt.customerUserId) !== scope.customerUserId)
    )
      return null;
    if (
      (booking.financialContract?.onlineChargeCents ?? booking.financials.depositCents) > 0 &&
      !attempt
    )
      return null;
    return booking;
  }

  private async resolveManualBooking(
    businessId: Types.ObjectId,
    key: string,
    actorUserId: string,
    bookingId: Types.ObjectId,
    verifyReservations = false,
  ) {
    const claim = await this.claimRepository.findForCustomerReplay(key, businessId, actorUserId);
    if (!claim) return null;
    if (String(claim.bookingId) !== String(bookingId) || claim.financialContract)
      throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    const booking = await this.bookingRepository.findById(businessId, bookingId);
    if (!booking) return null;
    if (
      booking.source !== "MANUAL" ||
      String(booking.createdBy.actorUserId) !== actorUserId ||
      String(booking.businessId) !== String(businessId) ||
      String(booking._id) !== String(bookingId) ||
      !booking.customer.businessClientId ||
      booking.financialContract
    )
      throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    return !verifyReservations || (await this.hasCommittedReservations(booking)) ? booking : null;
  }

  /** These ports are documented best-effort. Their failure follows commit and must
   * never enter abort cleanup or paid compensation. Delivery recovery is unchanged.
   * F4A Tier 2 (O2): booking-created email is no longer dispatched here — its outbox rows are
   * written inside the Booking transaction by recordBookingCreatedIntent. */
  private async afterBookingCommitted(booking: BookingDocument, _business: BusinessDocument) {
    await this.syncBookingCreatedToGoogleCalendar(booking).catch(() => undefined);
    await this.dispatchAppointmentReminderScheduling(booking).catch(() => undefined);
  }

  /**
   * F4A Tier 2 (O1) — writes the booking-created EmailOutbox rows with the Booking transaction
   * session, as the callback's last domain write. Rows commit if and only if the Booking
   * commits; nothing is visible to the email worker before commit. An outbox insert failure
   * throws and aborts the transaction; the caller's existing abort handling (claim release or
   * paid compensation) applies. A rollback is never itself a refund. No-op without a notifier.
   */
  private async recordBookingCreatedIntent(
    created: BookingDocument | undefined,
    business: BusinessDocument,
    session: ClientSession,
    payment?: BookingCreatedPaymentEvidence,
  ): Promise<void> {
    if (created)
      await this.appointmentReminderScheduler?.onBookingCreatedInTransaction?.(created, session);
    // P4B-2A — the Calendar desired state commits iff this Booking (and any paid completion
    // fence later in the same transaction) commits. A failure aborts like any other intent.
    if (created) await this.ordinaryCalendarJournal?.recordCreatedInTransaction(created, session);
    if (!this.bookingCreatedNotifier) return;
    if (!created) throw new Error("Booking-created intent requires the persisted Booking");
    await this.bookingCreatedNotifier.enqueueBookingCreatedInTransaction(
      created,
      business,
      session,
      payment,
    );
  }

  /**
   * F4A Tier 3 — read-only payment facts for the confirmation's receipt section. No payment,
   * ledger or attempt state is written here. `paymentResult` exists only when a PaymentIntent
   * was created; persistence is reached only after it `succeeded` (automatic capture). The
   * attempt read is best-effort: a failure leaves the receipt UNVERIFIED and never aborts.
   */
  private async bookingPaymentEvidence(
    paymentResult: PaymentIntentResult | undefined,
    ledger: BookingFinancialTransactionDocument | undefined,
    paymentFor: "BOOKING" | "PACKAGE_PURCHASE" | "PACKAGE_SESSION_EXTRAS",
  ): Promise<BookingCreatedPaymentEvidence | undefined> {
    if (!this.bookingCreatedNotifier) return undefined;
    if (!paymentResult) return { kind: "NONE" };
    const attempt = paymentResult.paymentAttemptId
      ? await this.paymentService
          .findPaymentAttemptById(paymentResult.paymentAttemptId)
          .catch(() => null)
      : null;
    return { kind: "CHARGED", paymentFor, ledger, attempt };
  }

  /** Check the canonical claim BEFORE reading/returning a Booking or resuming money.
   * Bare pending pre-contract/redemption claims have no persisted kind: wait for evidence;
   * never infer a kind from the caller's key. Completed legacy rows use their stored shape. */
  private async readCustomerReplay(
    scope: CustomerReplayScope,
    expectedBookingId?: Types.ObjectId,
    readAttempt = true,
  ) {
    const conflict = () => new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    const claim = await this.claimRepository.findForCustomerReplay(
      scope.idempotencyKey,
      scope.businessId,
      scope.customerUserId,
    );
    if (!claim) return { claim: null, booking: null, attempt: null };
    if (expectedBookingId && String(claim.bookingId) !== String(expectedBookingId))
      throw conflict();
    const contract = claim.financialContract;
    if (
      contract &&
      (contract.productKind !== scope.kind ||
        contract.idempotencyKey !== scope.idempotencyKey ||
        String(contract.businessId) !== String(scope.businessId) ||
        String(contract.customerUserId) !== scope.customerUserId ||
        String(contract.bookingId) !== String(claim.bookingId) ||
        !contract.businessClientId)
    )
      throw conflict();
    const booking = await this.bookingRepository.findById(scope.businessId, claim.bookingId);
    if (booking) {
      if (
        String(booking._id) !== String(claim.bookingId) ||
        String(booking.businessId) !== String(scope.businessId) ||
        String(booking.customer?.customerUserId) !== scope.customerUserId ||
        !booking.customer?.businessClientId ||
        booking.source !== "BOOKLY_MANAGED"
      )
        throw conflict();
      const lines = booking.serviceLines;
      const packageLine = lines.length === 1 ? lines[0] : undefined;
      const legacy =
        packageLine?.serviceSnapshot.pricingMode === "PACKAGE" &&
        !!packageLine.pricingInput.packageProgressId &&
        !packageLine.pricingInput.packageItemId &&
        !packageLine.packageContext;
      const matchesKind =
        scope.kind === "NORMAL_BOOKING"
          ? lines.length > 0 &&
            lines.every(
              (line) =>
                line.serviceSnapshot.pricingMode !== "PACKAGE" &&
                !line.pricingInput.packageProgressId &&
                !line.pricingInput.packageItemId &&
                !line.packageContext,
            )
          : legacy &&
            (scope.kind === "PACKAGE_PURCHASE"
              ? packageLine.pricingInput.sessionIndex === 1
              : (packageLine.pricingInput.sessionIndex ?? 0) > 1 &&
                String(packageLine.pricingInput.packageProgressId) ===
                  String(scope.packageProgressId));
      if (!matchesKind || Boolean(contract) !== Boolean(booking.financialContract))
        throw conflict();
      if (
        contract &&
        (String(contract.businessClientId) !== String(booking.customer.businessClientId) ||
          !booking.financialContract ||
          findFinancialContractMismatch(contract, booking.financialContract))
      )
        throw conflict();
      if (legacy && !(await this.hasLegacyResult(booking)))
        throw new BookingPersistenceUnresolvedError();
      return { claim, booking, attempt: null };
    }
    const attempt = readAttempt
      ? await this.paymentService.findPaymentAttempt(scope.idempotencyKey)
      : null;
    if (attempt) {
      const purpose =
        scope.kind === "NORMAL_BOOKING"
          ? "BOOKING_DEPOSIT"
          : scope.kind === "PACKAGE_PURCHASE"
            ? "PACKAGE_PURCHASE"
            : "PACKAGE_SESSION_EXTRAS";
      if (
        attempt.logicalIdempotencyKey !== scope.idempotencyKey ||
        attempt.purpose !== purpose ||
        String(attempt.customerUserId) !== scope.customerUserId ||
        String(attempt.businessId) !== String(scope.businessId) ||
        String(attempt.bookingId) !== String(claim.bookingId) ||
        (scope.kind !== "PACKAGE_REDEMPTION" &&
          (!contract || attempt.productKind !== scope.kind)) ||
        (scope.kind === "PACKAGE_REDEMPTION" && (contract || attempt.productKind))
      )
        throw conflict();
    }
    return { claim, booking: null, attempt };
  }

  /** Idempotent-retry resolution: the claim already belongs to a prior (this call's own retry,
   * or a concurrent duplicate) attempt. Bounded poll for the winner's Booking to become visible;
   * if the claim disappears (the earlier attempt failed and released it) before a Booking ever
   * appears, this is a fresh slot — recurse into a brand-new persist attempt exactly once. */
  private async awaitIdempotentBooking(
    params: {
      business: BusinessDocument;
      idempotencyKey: string;
      customerReplay?: CustomerReplayScope;
      manualActorUserId?: string;
    },
    bookingId: Types.ObjectId,
  ): Promise<BookingDocument> {
    for (let attempt = 0; attempt < IDEMPOTENCY_CLAIM_POLL_ATTEMPTS; attempt += 1) {
      // Manual management replay keeps its existing contract. Every Customer call supplies scope.
      const replay = params.customerReplay
        ? await this.readCustomerReplay(params.customerReplay, bookingId, false)
        : undefined;
      const claimStillPresent = replay
        ? replay.claim
        : await this.claimRepository.findByIdempotencyKey(params.idempotencyKey);
      const existing = replay
        ? replay.booking
        : params.manualActorUserId
          ? await this.resolveManualBooking(
              params.business._id,
              params.idempotencyKey,
              params.manualActorUserId,
              bookingId,
            )
          : null;
      if (existing) return existing;

      if (!claimStillPresent) {
        // The earlier attempt failed and released its claim — this call can now become the
        // winner. Caller (persistBooking) already validated everything; a bare re-throw here
        // would be wrong since the caller's own retry path re-enters persistBooking cleanly.
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503, [
          {
            message: "The prior attempt for this idempotency key failed — please retry",
            code: "BOOKING_TRANSACTION_UNAVAILABLE",
          },
        ]);
      }

      await sleep(IDEMPOTENCY_CLAIM_POLL_DELAY_MS);
    }

    throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503, [
      {
        message: "Timed out waiting for a concurrent identical booking request to complete",
        code: "BOOKING_TRANSACTION_UNAVAILABLE",
      },
    ]);
  }

  /**
   * Best-effort, post-commit Google Calendar sync (product scope: one-way Bookly -> Google,
   * UPCOMING creates the event). Runs strictly AFTER the booking transaction has already
   * committed, and never throws — a Google API failure must not corrupt a valid Booking (ground
   * rule). IntegrationService.createEventForBooking itself swallows all provider errors and
   * records them for the owner instead of propagating.
   */
  private async syncBookingCreatedToGoogleCalendar(created: BookingDocument): Promise<void> {
    if (!this.integrationService) {
      return;
    }
    // P4B-2A — an AUTHORITATIVE journal owns this Booking's event; never add a second writer.
    if (
      this.ordinaryCalendarJournal &&
      !(await this.ordinaryCalendarJournal.legacySyncPermitted(created))
    )
      return;

    const eventId = await this.integrationService.createEventForBooking(created.businessId, {
      summary: `Bookly — ${created.reference}`,
      description: `Booking ${created.reference} (${created.serviceLines.length} service line(s))`,
      startAt: created.schedule.startAt,
      endAt: created.schedule.endAt,
      timezone: created.schedule.timezone,
    });

    if (!eventId) {
      return;
    }

    // CAS-scoped to UPCOMING: if the booking was already cancelled by the time this best-effort
    // call lands (e.g. a fast concurrent cancellation), leave it alone rather than resurrecting
    // a googleCalendarEventId onto a booking whose event may already be in the process of being
    // deleted by the cancellation path.
    await this.bookingRepository.casUpdate(created.businessId, created._id, ["UPCOMING"], {
      set: { googleCalendarEventId: eventId },
    });
  }

  /**
   * Post-commit tail — schedule the 24h appointment reminder. Same best-effort discipline as the
   * mailing / Google Calendar side effects: the scheduler itself never throws (it swallows and
   * logs its own errors), so a reminder problem can never roll back a committed booking. No-op
   * when no scheduler was injected.
   */
  private async dispatchAppointmentReminderScheduling(created: BookingDocument): Promise<void> {
    if (!this.appointmentReminderScheduler) {
      return;
    }
    if (!this.appointmentReminderScheduler.onBookingCreatedInTransaction)
      await this.appointmentReminderScheduler.onBookingCreated(created);
  }

  private async generateUniqueReference(): Promise<string> {
    for (let attempt = 0; attempt < REFERENCE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      const candidate = generateBookingReference();
      const existing = await this.bookingRepository.findByReference(candidate);
      if (!existing) {
        return candidate;
      }
    }
    throw new BookingError("BOOKING_REFERENCE_GENERATION_FAILED", 500);
  }

  // --- Guards -----------------------------------------------------------------------------

  private requireIdempotencyKey(idempotencyKey: string | undefined): void {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BookingError("BOOKING_IDEMPOTENCY_KEY_REQUIRED", 400);
    }
  }

  private parseStartAt(startAt: string): Date {
    const parsed = new Date(startAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw new BookingError("BOOKING_SCHEDULE_INVALID", 400);
    }
    return parsed;
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    }
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    }
    return business;
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }
}
