import mongoose, { Types } from "mongoose";
import type { AppointmentReminderSchedulingPort } from "../appointment-reminder/appointment-reminder-scheduler.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
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
import type { IntegrationService } from "../integration/integration.service.js";
import { PackageProgressError } from "../package-progress/package-progress.errors.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import { computePackageBalanceSettlement } from "../package-progress/package-progress.rules.js";
import { PaymentError } from "../payment/payment.errors.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { PaymentIntentResult } from "../payment/payment.types.js";
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
} from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";
import type { BookingService } from "./booking.service.js";
import type { BookingActorRole, BookingSource } from "./booking.types.js";
import { generateBookingReference } from "./booking.utils.js";
import type { CreateBookingInput, CreateManualBookingInput } from "./booking-creation.types.js";
import type { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";

/**
 * Stage B mailing observer for Triggers 2/3/4. Optional + trailing so every existing
 * construction site is unchanged; invoked only from the post-commit tail and must never throw
 * (the implementation swallows its own errors, exactly like syncBookingCreatedToGoogleCalendar).
 */
export type BookingCreatedNotificationPort = {
  notifyBookingCreated(booking: BookingDocument, business: BusinessDocument): Promise<void>;
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
  amountDueNowCents: number;
  requiresSavedCard: boolean;
  hasSavedCard: boolean;
  /** Batch 13 — present only when a valid `promoCode` was supplied. `amountDueNowCents` above
   * already reflects the discount (== `promo.chargeCents`); this breakdown is what the frontend
   * displays as "Deposit before promo / Promo discount / Due now" — never recomputed in React. */
  promo?: {
    code: string;
    type: "PERCENTAGE" | "FIXED";
    value: number;
    depositBeforePromoCents: number;
    discountCents: number;
  };
};

export type FinalizeBookingResult =
  | { status: "confirmed"; booking: BookingDocument }
  | { status: "requires_action"; clientSecret: string; paymentIntentId: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * implied "paid" for one. A BOOKLY_MANAGED Customer Booking now only ever reaches `UPCOMING`
 * AFTER its required deposit payment has genuinely succeeded — charged online for EVERY
 * BOOKLY_MANAGED booking, first or returning (Batch 6.5 correction; a returning Customer is
 * NEVER "nothing beyond a verified saved card" — see PAYMENT-GATING's continuation in
 * `finalizeCustomerBooking`'s own doc comment, and BookingFinancials's own doc comment for the
 * full deposit-vs-platform-fee distinction). `previewCustomerBooking` remains a read-only,
 * side-effect-free quote (now Customer-aware, so it can show the ACTUAL applicable amount — the
 * real clamp(20%, €5, €35) deposit formula for both a first and a returning Customer, never €0
 * for either) and never persists anything.
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
    // enqueues booking-creation notifications from the post-commit tail. Absent in the many
    // integration suites that construct this service directly — a safe no-op there.
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
  ) {}

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

  // --- Manual (real, persisted) --------------------------------------------------------------

  public async createManualBooking(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    input: CreateManualBookingInput,
  ): Promise<BookingDocument> {
    this.requireIdempotencyKey(input.idempotencyKey);
    await this.enforceMaxServicesPerBooking(input.serviceLines.length);

    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
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

    const financials = this.assembleFinancials("MANUAL", lines, travelFeeCents, false);
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
   * the ACTUAL amount due now: the clamp(20%, €5, €35) booking deposit, charged online for
   * EVERY BOOKLY_MANAGED booking — first or returning (Batch 6.5 correction: never €0 for a
   * returning Customer; see BookingFinancials's own doc comment for the full deposit-vs-
   * platform-fee distinction). Never reserves or persists anything; `finalizeCustomerBooking`
   * is the only path that does.
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
    const isFirstBooking = !existingClient?.activatedAt;

    const financials = this.assembleFinancials(
      "BOOKLY_MANAGED",
      lines,
      travelFeeCents,
      isFirstBooking,
    );
    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);

    const overallEndAt = lines.reduce(
      (max, line) => (line.endAt > max ? line.endAt : max),
      lines[0]?.endAt ?? startAt,
    );

    // Batch 13 — read-only, side-effect-free promo preview: resolves and computes the discount
    // against the ALREADY-canonical deposit (never a second pricing engine), but never claims a
    // redemption — see PromoApplicationService's own doc comment. A retried/duplicate preview
    // call can never consume usage.
    const resolvedPromo = input.promoCode
      ? await this.promoApplicationService.resolve({
          code: input.promoCode,
          business,
          customerUserId,
          isFirstBooking,
          depositBeforePromoCents: financials.depositCents,
        })
      : undefined;

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
      // real deposit is still due (see BookingFinancials's own doc comment). Batch 13: when a
      // valid promo is supplied, this becomes the promo-discounted amount instead.
      amountDueNowCents: resolvedPromo
        ? resolvedPromo.customerChargeNowCents
        : financials.depositCents,
      requiresSavedCard: true,
      hasSavedCard: cardStatus.hasSavedCard,
      ...(resolvedPromo
        ? {
            promo: {
              code: resolvedPromo.promo.code,
              type: resolvedPromo.promo.type,
              value: resolvedPromo.promo.value,
              depositBeforePromoCents: resolvedPromo.depositBeforePromoCents,
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
   *  3. Read `isFirstBooking` (`BusinessClient.activatedAt`) as an OPTIMISTIC snapshot and
   *     assemble financials from it — this is only a pre-charge estimate; step 7 below
   *     determines the TRUE, race-safe outcome atomically and corrects it if needed.
   *  4. Require a saved card regardless of activation state (confirmed rule: "returning
   *     customers also need a saved card").
   *  5. Claim the idempotency key (pre-generated bookingId, same pattern as Batch 3's
   *     `persistBooking`).
   *  6. Whenever the deposit is nonzero (essentially always, for BOOKLY_MANAGED — Batch 6.5:
   *     charged for EVERY booking, first or returning, never gated on `isFirstBooking`): charge
   *     the deposit ON-session, saving the card for future off-session use in the same call.
   *     `requires_action` releases the claim (nothing to compensate — no reservation/Booking
   *     exists yet) and returns a clientSecret for the frontend to complete 3DS, then retry this
   *     same call with the same idempotencyKey. A hard failure releases the claim and throws —
   *     no Booking, no charge.
   *  7. Reserve every line, then — inside the SAME transaction — attempt `markActivated`
   *     UNCONDITIONALLY (CAS-gated, safe/idempotent either way) and use its REAL result as the
   *     single source of truth for who economically keeps this deposit (closes a genuine
   *     concurrency race two truly-simultaneous finalize calls could otherwise hit — see
   *     persistCustomerBooking's own comment), correcting `financials.platformFeeCents` if the
   *     step-3 snapshot turns out to have guessed wrong. Then persist the Booking with the
   *     TRUE financials, write the PLATFORM_FEE (won activation) or DEPOSIT (didn't) ledger
   *     entry accordingly, all inside one MongoDB transaction (session-threaded throughout).
   *  8. If step 7 fails AFTER a successful charge (a genuine post-payment reservation conflict,
   *     or any other persistence failure) — refund the just-collected deposit (best-effort,
   *     itself ledgered), release the claim, and throw. The customer is never left charged
   *     without a Booking, and a fresh retry with the same idempotencyKey gets a clean new
   *     charge attempt rather than being stuck.
   */
  public async finalizeCustomerBooking(
    customerUserId: string,
    businessId: string,
    input: CreateBookingInput,
  ): Promise<FinalizeBookingResult> {
    this.requireIdempotencyKey(input.idempotencyKey);
    await this.enforceMaxServicesPerBooking(input.serviceLines.length);
    const business = await this.requireBusiness(businessId);

    const existingClaim = await this.claimRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
        existingClaim.bookingId,
      );
      return { status: "confirmed", booking };
    }

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
    const isFirstBooking = !client.activatedAt;
    const financials = this.assembleFinancials(
      "BOOKLY_MANAGED",
      lines,
      travelFeeCents,
      isFirstBooking,
    );

    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    if (!cardStatus.hasSavedCard) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    // Batch 13 — re-validated here from scratch (never trusts a prior preview call). Resolves
    // BEFORE any charge, using the same optimistic `isFirstBooking` snapshot the rest of this
    // method already relies on for the pre-charge amount; `persistCustomerBooking`'s transaction
    // re-checks scope eligibility against the REAL, race-resolved outcome before ever consuming
    // the redemption (see PromoApplicationService.claimRedemption's own comment).
    const resolvedPromo = input.promoCode
      ? await this.promoApplicationService.resolve({
          code: input.promoCode,
          business,
          customerUserId,
          isFirstBooking,
          depositBeforePromoCents: financials.depositCents,
        })
      : undefined;
    const customerChargeNowCents = resolvedPromo
      ? resolvedPromo.customerChargeNowCents
      : financials.depositCents;

    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
    };

    const bookingId = new Types.ObjectId();
    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });

    if (!claimResult.isNew) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
        claimResult.bookingId,
      );
      return { status: "confirmed", booking };
    }

    let paymentResult: PaymentIntentResult | undefined;

    // Batch 6.5: the deposit is charged online for EVERY BOOKLY_MANAGED booking, first or
    // returning — never gated on `isFirstBooking` (that only decides who economically keeps
    // it, resolved below, atomically, inside persistCustomerBooking's own transaction).
    // Batch 13: the ACTUAL Stripe charge amount/gate uses `customerChargeNowCents` — a Promo
    // may fully cover the deposit (rule #7: never a fake €0 charge, but the saved-card
    // requirement above still applies unconditionally either way).
    if (customerChargeNowCents > 0) {
      try {
        paymentResult = await this.paymentService.chargeBookingDeposit({
          userId: customerUserId,
          amountCents: customerChargeNowCents,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            bookingId: String(bookingId),
            businessId: String(business._id),
            purpose: "BOOKING_DEPOSIT",
          },
        });
      } catch (error) {
        await this.claimRepository.release(input.idempotencyKey);
        throw error;
      }

      if (paymentResult.status === "requires_action") {
        await this.claimRepository.release(input.idempotencyKey);
        return {
          status: "requires_action",
          clientSecret: paymentResult.clientSecret as string,
          paymentIntentId: paymentResult.paymentIntentId,
        };
      }

      if (paymentResult.status !== "succeeded") {
        await this.claimRepository.release(input.idempotencyKey);
        throw new PaymentError(
          "PAYMENT_FAILED",
          402,
          paymentResult.failureMessage
            ? [{ message: paymentResult.failureMessage, code: "PAYMENT_FAILED" }]
            : undefined,
        );
      }
    }

    try {
      const booking = await this.persistCustomerBooking({
        bookingId,
        business,
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
        client,
        isFirstBooking,
        paymentResult,
        resolvedPromo,
        customerChargeNowCents,
      });
      return { status: "confirmed", booking };
    } catch (error) {
      if (paymentResult) {
        // Batch 13 — refunds the amount ACTUALLY charged to Stripe (post-promo), never the
        // pre-promo `financials.depositCents` entitlement: Stripe can only refund what it
        // actually collected.
        await this.compensateFailedBookingAfterPayment(
          business,
          bookingId,
          client,
          customerChargeNowCents,
          paymentResult,
        );
      } else {
        await this.claimRepository.release(input.idempotencyKey);
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
    const isFirstBooking = !existingClient?.activatedAt;
    const financials = this.assembleFinancials(
      "BOOKLY_MANAGED",
      lines,
      travelFeeCents,
      isFirstBooking,
    );
    const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
    const line = lines[0] as ResolvedServiceLine;

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
      amountDueNowCents: financials.depositCents,
      requiresSavedCard: true,
      hasSavedCard: cardStatus.hasSavedCard,
    };
  }

  /**
   * The real Package purchase: books and pays for session 1 exactly like
   * finalizeCustomerBooking (same idempotency-claim/payment/activation/ledger machinery,
   * reused via persistCustomerBooking, completely unmodified), then creates the linked
   * PackageProgress entitlement with `remainingSessions = sessionsInPackage - 1`. The
   * entitlement is written BEFORE persistCustomerBooking (both keyed off pre-generated ids,
   * the same "pre-generate then link" pattern this class already uses for bookingId) so a
   * failure in the Booking write can be cleanly compensated by deleting the just-created,
   * not-yet-referenced-by-anything-else entitlement row — never leaving a paid Booking with
   * no entitlement, and never leaving an entitlement with no origin Booking.
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

    const existingClaim = await this.claimRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
        existingClaim.bookingId,
      );
      return { status: "confirmed", booking };
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

    const client = await this.resolveOrCreateCustomerClient(business, customerUserId, fulfilment);
    const isFirstBooking = !client.activatedAt;
    const financials = this.assembleFinancials(
      "BOOKLY_MANAGED",
      lines,
      travelFeeCents,
      isFirstBooking,
    );

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

    const bookingId = new Types.ObjectId();
    const packageProgressId = new Types.ObjectId();

    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });

    if (!claimResult.isNew) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
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

    const customerChargeNowCents = financials.depositCents;
    let paymentResult: PaymentIntentResult | undefined;

    if (customerChargeNowCents > 0) {
      try {
        paymentResult = await this.paymentService.chargeBookingDeposit({
          userId: customerUserId,
          amountCents: customerChargeNowCents,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            bookingId: String(bookingId),
            businessId: String(business._id),
            purpose: "PACKAGE_PURCHASE",
          },
        });
      } catch (error) {
        await this.claimRepository.release(input.idempotencyKey);
        throw error;
      }

      if (paymentResult.status === "requires_action") {
        await this.claimRepository.release(input.idempotencyKey);
        return {
          status: "requires_action",
          clientSecret: paymentResult.clientSecret as string,
          paymentIntentId: paymentResult.paymentIntentId,
        };
      }

      if (paymentResult.status !== "succeeded") {
        await this.claimRepository.release(input.idempotencyKey);
        throw new PaymentError(
          "PAYMENT_FAILED",
          402,
          paymentResult.failureMessage
            ? [{ message: paymentResult.failureMessage, code: "PAYMENT_FAILED" }]
            : undefined,
        );
      }
    }

    try {
      await (this.packageProgressRepository as PackageProgressRepository).create({
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
        },
      });
    } catch (error) {
      await this.claimRepository.release(input.idempotencyKey);
      if (paymentResult) {
        await this.compensateFailedBookingAfterPayment(
          business,
          bookingId,
          client,
          customerChargeNowCents,
          paymentResult,
        );
      }
      throw error;
    }

    try {
      const booking = await this.persistCustomerBooking({
        bookingId,
        business,
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
        client,
        isFirstBooking,
        paymentResult,
        resolvedPromo: undefined,
        customerChargeNowCents,
      });
      return { status: "confirmed", booking };
    } catch (error) {
      // The Booking never came into being — the entitlement pointing at it must not survive
      // either (never called once a session may already have been redeemed against this row,
      // which cannot happen here since this row was only just created above, in this same call).
      await (this.packageProgressRepository as PackageProgressRepository)
        .deleteById(packageProgressId)
        .catch(() => {});
      if (paymentResult) {
        await this.compensateFailedBookingAfterPayment(
          business,
          bookingId,
          client,
          customerChargeNowCents,
          paymentResult,
        );
      } else {
        await this.claimRepository.release(input.idempotencyKey);
      }
      throw error;
    }
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

    // Approved payment/unlock model: sessions 2..N never redeem until the origin (purchase)
    // Booking's own venue balance has been recorded as FULLY settled — reusing that Booking's
    // OWN authoritative `financials.balanceDueCents`/`completionPayment` (never a second,
    // separately-tracked payment-status field; see package-progress.rules.ts's own doc comment).
    // Re-fetched live on every call — client state can never unlock this.
    const originBooking = await this.bookingRepository.findById(
      business._id,
      progress.originBookingId,
    );
    if (!originBooking) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }
    const settlement = computePackageBalanceSettlement(originBooking);
    if (!settlement.balanceSettled) {
      throw new PackageProgressError("PACKAGE_PROGRESS_BALANCE_NOT_SETTLED", 409);
    }

    const existingClaim = await this.claimRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existingClaim) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
        existingClaim.bookingId,
      );
      return { status: "confirmed", booking };
    }

    const startAt = this.parseStartAt(input.startAt);

    const { service, staffMembership } = await this.bookingService.validateResponsibleStaff(
      business,
      String(progress.serviceId),
      input.staffMembershipId,
    );
    if (!service.isPackageDeal || !service._id.equals(progress.serviceId)) {
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

    const fulfilment = await this.resolveFulfilment(business, {
      serviceLines: [],
      startAt: input.startAt,
      travelAddress: input.travelAddress,
      customerCity: input.customerCity,
      idempotencyKey: input.idempotencyKey,
    });
    this.bookingService.validateFulfilmentSnapshot(business, fulfilment);

    // Approved Add-on rule: the Package base is $0, but a selected Add-on is still real,
    // separately payable money — reuses resolveAddonSnapshots verbatim (same validation,
    // pricing, and "must be assigned to this Service" rule any normal booking already enforces).
    const addons = await this.bookingService.resolveAddonSnapshots(
      business,
      String(service._id),
      input.addonIds ?? [],
    );

    const client = await this.resolveOrCreateCustomerClient(business, customerUserId, fulfilment);
    const customer = this.buildCustomerSnapshot(client);
    const createdBy: BookingActor = {
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
    };
    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
    const noShowEligibilitySnapshot = await this.resolveNoShowEligibilitySnapshot(business);

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

    // Approved travel-fee rule: reuse the EXISTING served-city validation AND the EXISTING
    // per-city fee lookup verbatim — a Package base session is $0, but a real travel fee for
    // THIS visit is still owed, exactly like any other TRAVEL_TO_CUSTOMER booking (never a new
    // formula, never bundled for "all future visits").
    const travelFeeCents = await this.requireTravelEligibilityAndFee(
      business,
      [resolvedLine],
      input.customerCity,
    );

    // Base service is always $0; Add-ons and travel fee are real, separately payable money —
    // reusing the EXACT existing deposit/balance formula (assembleFinancials, unmodified) only
    // when there is genuinely something to charge. When there is nothing extra (the common
    // case), financials stay all-zero — deliberately NOT routed through assembleFinancials even
    // then, since calculateBookingDepositCents floors at DEPOSIT_MIN_CENTS even for a €0 basis
    // (the exact double-charge the Package Deal audit found and this guard exists to prevent).
    const addonsSubtotalCents = addons.reduce((sum, addon) => sum + addon.priceCents, 0);
    const hasPayableExtra = addonsSubtotalCents > 0 || travelFeeCents > 0;
    // A redeeming customer is by definition already activated (they own an existing purchased
    // Package) — never re-litigate first-vs-returning here; persistCustomerBooking's own
    // markActivated call below is idempotent regardless (a no-op "loser" for an already-active
    // Client), so passing false is simply the correct, already-known answer, not a shortcut.
    const isFirstBooking = false;
    const financials: BookingFinancials = hasPayableExtra
      ? this.assembleFinancials("BOOKLY_MANAGED", [resolvedLine], travelFeeCents, isFirstBooking)
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

    if (financials.depositCents > 0) {
      const cardStatus = await this.paymentService.getSavedCardStatus(customerUserId);
      if (!cardStatus.hasSavedCard) {
        throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
      }
    }

    const bookingId = new Types.ObjectId();
    const claimResult = await this.claimRepository.claim({
      idempotencyKey: input.idempotencyKey,
      businessId: business._id,
      actorUserId: new Types.ObjectId(customerUserId),
      bookingId,
    });
    if (!claimResult.isNew) {
      const booking = await this.awaitIdempotentBooking(
        { business, idempotencyKey: input.idempotencyKey },
        claimResult.bookingId,
      );
      return { status: "confirmed", booking };
    }

    const customerChargeNowCents = financials.depositCents;
    let paymentResult: PaymentIntentResult | undefined;

    if (customerChargeNowCents > 0) {
      try {
        paymentResult = await this.paymentService.chargeBookingDeposit({
          userId: customerUserId,
          amountCents: customerChargeNowCents,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            bookingId: String(bookingId),
            businessId: String(business._id),
            purpose: "PACKAGE_SESSION_EXTRAS",
          },
        });
      } catch (error) {
        await this.claimRepository.release(input.idempotencyKey);
        throw error;
      }

      if (paymentResult.status === "requires_action") {
        await this.claimRepository.release(input.idempotencyKey);
        return {
          status: "requires_action",
          clientSecret: paymentResult.clientSecret as string,
          paymentIntentId: paymentResult.paymentIntentId,
        };
      }

      if (paymentResult.status !== "succeeded") {
        await this.claimRepository.release(input.idempotencyKey);
        throw new PaymentError(
          "PAYMENT_FAILED",
          402,
          paymentResult.failureMessage
            ? [{ message: paymentResult.failureMessage, code: "PAYMENT_FAILED" }]
            : undefined,
        );
      }
    }

    const dbSession = await mongoose.startSession();
    let created: BookingDocument | undefined;

    try {
      await dbSession.withTransaction(async () => {
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
            ...(input.notes ? { notes: input.notes } : {}),
          },
          dbSession,
        );

        await (this.packageProgressRepository as PackageProgressRepository).recordScheduledSession(
          progress._id,
          claimedSessionIndex,
          bookingId,
          dbSession,
        );

        // Real money was actually charged (Add-ons/travel) — ledger it exactly like any other
        // BOOKLY_MANAGED deposit (never PLATFORM_FEE here: isFirstBooking is always false for a
        // redemption, matching the confirmed "already activated" reasoning above).
        if (customerChargeNowCents > 0) {
          await this.financialTransactionService.record(
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
        }
      });
    } catch (error) {
      await this.claimRepository.release(input.idempotencyKey);
      if (paymentResult) {
        await this.compensateFailedBookingAfterPayment(
          business,
          bookingId,
          client,
          customerChargeNowCents,
          paymentResult,
        );
      }
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!created) {
      throw new Error("Package session booking failed without throwing");
    }

    await this.syncBookingCreatedToGoogleCalendar(created);
    await this.dispatchBookingCreatedNotifications(created, business);
    await this.dispatchAppointmentReminderScheduling(created);

    return { status: "confirmed", booking: created };
  }

  private requirePackageProgressRepository(): void {
    if (!this.packageProgressRepository) {
      throw new Error(
        "PackageProgressRepository must be injected to use Package purchase/redemption",
      );
    }
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
    const existing = await this.clientRepository.findByBusinessIdAndLinkedUserId(
      business._id,
      customerUserId,
    );
    if (existing) {
      return existing;
    }

    const [user, profile] = await Promise.all([
      this.userRepository.findById(customerUserId),
      this.userRepository.findProfileByUserId(customerUserId),
    ]);
    if (!user || !profile?.phone) {
      throw new BookingError("BOOKING_CUSTOMER_CLIENT_PROFILE_REQUIRED", 409);
    }

    const travelAddress =
      fulfilment.mode === "TRAVEL_TO_CUSTOMER" ? fulfilment.travelAddress : undefined;

    try {
      return await this.clientRepository.create({
        businessId: business._id,
        createdByUserId: new Types.ObjectId(customerUserId),
        firstName: profile.firstName,
        lastName: profile.lastName,
        normalizedEmail: user.normalizedEmail,
        phone: profile.phone,
        ...(travelAddress
          ? {
              address: {
                city: travelAddress.city,
                propertyType: travelAddress.propertyType,
                area: travelAddress.area,
                streetName: travelAddress.streetName,
                streetNumber: travelAddress.streetNumber,
                floorUnit: travelAddress.floorUnit,
                aptRoom: travelAddress.aptRoom,
              },
            }
          : {}),
        linkState: "LINKED",
        linkedUserId: new Types.ObjectId(customerUserId),
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      const winner = await this.clientRepository.findByBusinessIdAndLinkedUserId(
        business._id,
        customerUserId,
      );
      if (winner) {
        return winner;
      }

      throw new BookingError("BOOKING_CUSTOMER_CLIENT_CONTACT_CONFLICT", 409);
    }
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
   * Reserve-all-lines + persist the Booking + (if a payment was actually taken) write the
   * PLATFORM_FEE ledger entry and mark the Client activated — all inside ONE transaction, the
   * same pattern as `persistBooking` (Manual), extended with the two payment-specific writes.
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
    isFirstBooking: boolean;
    paymentResult: PaymentIntentResult | undefined;
    resolvedPromo: ResolvedPromo | undefined;
    customerChargeNowCents: number;
  }): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let created: BookingDocument | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const reservationsByLineIndex = new Map<number, Types.ObjectId>();

        for (const [index, line] of params.lines.entries()) {
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

        const serviceLines: BookingServiceLine[] = params.lines.map((line, index) => ({
          serviceId: line.service._id,
          serviceSnapshot: line.serviceSnapshot,
          ...(line.staffSnapshot ? { staffSnapshot: line.staffSnapshot } : {}),
          pricingInput: line.pricingInput,
          responsibleStaffMembershipId: line.staffMembership._id,
          addons: line.addons,
          amountCents: line.amountCents,
          reservationId: reservationsByLineIndex.get(index) as Types.ObjectId,
        }));

        // Batch 6.5 — CLOSES A REAL CONCURRENCY RACE: `params.isFirstBooking` was read BEFORE
        // this transaction (and before the Stripe charge), so two truly concurrent finalize
        // calls for the same brand-new Customer+Business can both read "first booking" and both
        // genuinely charge the deposit. Only ONE may actually WIN activation — attempting
        // `markActivated` here, unconditionally, inside this same transaction, using its REAL
        // (CAS-gated) result as the single source of truth for who economically keeps this
        // deposit, is what makes that outcome correct regardless of the race: the winner gets
        // platformFeeCents = depositCents (Bookly's activation revenue, ledgered PLATFORM_FEE);
        // the loser's own deposit is still real, still charged, still fully theirs to keep as a
        // Business-owned prepayment (platformFeeCents = 0, ledgered DEPOSIT) — never silently
        // dropped, never double-counted as platform revenue. See
        // ClientRepository.markActivated's own CAS comment for why a "loser" call is a safe,
        // idempotent no-op (returns null), never an error.
        // Batch 13 — `hasDepositObligation` (not `paymentResult` truthiness) now gates
        // activation-resolution and ledger-writing: a Promo may reduce the ACTUAL Stripe charge
        // to €0 while a real deposit ENTITLEMENT still exists (`financials.depositCents > 0`),
        // and that entitlement must still resolve first/returning + write its ledger entry
        // exactly as if it had been charged in full. Identical to the prior `paymentResult`
        // gate for every non-promo booking, since `customerChargeNowCents === depositCents`
        // whenever no promo was used (so `paymentResult` is defined exactly when
        // `hasDepositObligation` is true) — a strictly backward-compatible generalization.
        const hasDepositObligation = params.financials.depositCents > 0;

        let reallyFirstBooking = false;
        if (hasDepositObligation) {
          const activation = await this.clientRepository.markActivated(
            params.client._id,
            params.bookingId,
            dbSession,
          );
          reallyFirstBooking = Boolean(activation);
        }

        // Batch 13 — an ALL_FIRST_BOOKINGS promo must honor the REAL, race-resolved
        // first/returning outcome, never the pre-charge optimistic snapshot the amount was
        // computed from. A mismatch here means the customer was charged assuming eligibility
        // that the activation race just disproved — this throws (never silently drops the
        // promo or silently changes the charged amount), which the caller's existing
        // post-payment compensation/refund path already handles correctly.
        if (params.resolvedPromo) {
          await this.promoApplicationService.claimRedemption(
            {
              resolved: params.resolvedPromo,
              bookingId: params.bookingId,
              businessId: params.business._id,
              customerUserId: params.createdBy.actorUserId,
              isFirstBooking: reallyFirstBooking,
            },
            dbSession,
          );
        }

        const financials: BookingFinancials =
          reallyFirstBooking === params.isFirstBooking
            ? params.financials
            : {
                ...params.financials,
                platformFeeCents: reallyFirstBooking ? params.financials.depositCents : 0,
              };

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
                    fundingOwner: "BOOKLY" as const,
                    appliedAt: new Date(),
                  },
                }
              : {}),
          },
          dbSession,
        );

        if (hasDepositObligation) {
          // The SAME deposit charge — the ledger TYPE alone records who economically owns it
          // (see BookingFinancials's own doc comment): PLATFORM_FEE for the genuine first
          // booking, DEPOSIT (already part of this ledger's vocabulary — see
          // booking-financial-transaction.types.ts — never PLATFORM_FEE) for a returning
          // customer's Business-owned prepayment. Batch 13: `amountCents` is the amount
          // ACTUALLY charged (post-promo) — every downstream reader of "the customer's upfront
          // payment" (cancellation/no-show netting, refunds — see
          // BookingFinancialTransactionService.findSucceededUpfrontPayment) already reads this
          // real ledger amount, never `financials.depositCents` directly, so nothing else needs
          // to change for promo-aware cancellation/no-show exposure. Skipped entirely when a
          // Promo fully covers the deposit (`customerChargeNowCents === 0`): the ledger schema's
          // own `amountCents` invariant requires a positive amount (a real, immutable financial
          // event must represent SOME money movement) — a real €0 DEBIT would carry no
          // information no other row already carries, so it is never written rather than
          // relaxing that invariant for a case with nothing to record. The Booking's own `promo`
          // snapshot (chargeCents: 0) and the PromoRedemption audit row remain the complete,
          // truthful record of what happened.
          if (params.customerChargeNowCents > 0) {
            await this.financialTransactionService.record(
              {
                businessId: params.business._id,
                bookingId: params.bookingId,
                businessClientId: params.client._id,
                customerUserId: params.createdBy.actorUserId,
                type: reallyFirstBooking ? "PLATFORM_FEE" : "DEPOSIT",
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
          }

          // Batch 13 — a RETURNING booking's Promo shortfall: the Business is still owed the
          // FULL pre-promo deposit (rule #3 — "do NOT simply reduce DEPOSIT... the authoritative
          // Business-owned economic deposit remains [the full amount]"). Never written for a
          // FIRST booking's promo — there Bookly simply collects less PLATFORM_FEE and no other
          // party needs compensating (see PROMO_SUBSIDY's own type-level doc comment).
          if (
            params.resolvedPromo &&
            !reallyFirstBooking &&
            params.resolvedPromo.promoDiscountCents > 0
          ) {
            await this.financialTransactionService.record(
              {
                businessId: params.business._id,
                bookingId: params.bookingId,
                businessClientId: params.client._id,
                customerUserId: params.createdBy.actorUserId,
                type: "PROMO_SUBSIDY",
                direction: "CREDIT",
                amountCents: params.resolvedPromo.promoDiscountCents,
                currency: params.financials.currency,
                status: "SUCCEEDED",
                idempotencyKey: `${params.idempotencyKey}:promo-subsidy`,
              },
              dbSession,
            );
          }
        }
      });
    } catch (error) {
      await this.claimRepository.release(params.idempotencyKey);

      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!created) {
      throw new Error("Booking creation failed without throwing");
    }

    await this.syncBookingCreatedToGoogleCalendar(created);
    await this.dispatchBookingCreatedNotifications(created, params.business);
    await this.dispatchAppointmentReminderScheduling(created);

    return created;
  }

  /**
   * The saga's compensating action: a real charge succeeded but the Booking could not be
   * persisted (a genuine post-payment reservation conflict, or any other failure). Refunds the
   * just-collected charge — best-effort; a refund failure is itself ledgered as FAILED and
   * logged, never allowed to mask or replace the ORIGINAL error the caller is about to throw
   * (the customer must see "your booking could not be completed", not a refund-plumbing detail).
   * The claim is always released so a fresh retry gets a clean new charge attempt.
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
        idempotencyKey: `refund:${paymentResult.paymentIntentId}:compensation`,
        reason: "requested_by_customer",
      });

      await this.financialTransactionService.record({
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
        idempotencyKey: `refund:${paymentResult.paymentIntentId}:compensation`,
        // Batch 8 — this refund unwinds a charge whose own ledger entry never durably
        // persisted (persistCustomerBooking's transaction rolled back before writing it), so
        // there is no sourceTransactionId to link to. Deliberately NOT attributed to either
        // Bookly or the Business (see finance-ownership.ts's own comment): the corresponding
        // charge was never counted as anyone's revenue in the first place, so nothing needs
        // reversing against either party's total.
        metadata: { sourceType: "COMPENSATION" },
      });
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

      const amountCents = pricing.bundlePriceCents;
      const discountCents = pricing.discountPercent
        ? Math.round((amountCents * pricing.discountPercent) / 100)
        : 0;

      return {
        pricingMode: "PACKAGE",
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
   * Batch 6.5 correction — see BookingFinancials's own updated doc comment for the full
   * deposit-vs-platform-fee rationale. `isFirstBooking` no longer decides WHETHER a deposit is
   * charged (a MANUAL Booking never charges one — rule E; every BOOKLY_MANAGED Booking always
   * does, first or returning) — it decides only whether Bookly economically claims that SAME
   * deposit as platform/activation revenue (`platformFeeCents = depositCents`) or the deposit
   * is a Business-owned service prepayment instead (`platformFeeCents = 0`, `depositCents`
   * unchanged). Previously this method took a `chargePlatformFee: boolean` that ALSO gated
   * `depositCents` to 0 for a returning customer — that conflation was the exact bug this batch
   * corrects; `depositCents` is now computed unconditionally for BOOKLY_MANAGED, entirely
   * independent of `isFirstBooking`.
   */
  private assembleFinancials(
    source: BookingSource,
    lines: ResolvedServiceLine[],
    travelFeeCents: number,
    isFirstBooking: boolean,
  ): BookingFinancials {
    const servicesSubtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
    const addonsSubtotalCents = lines.reduce(
      (sum, line) => sum + line.addons.reduce((s, a) => s + a.priceCents, 0),
      0,
    );
    const serviceDiscountCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
    const eligiblePlatformFeeBasisCents =
      servicesSubtotalCents + addonsSubtotalCents - serviceDiscountCents;

    // The deposit: charged online for EVERY BOOKLY_MANAGED booking (confirmed rule, Batch 6.5)
    // — never gated on first/returning. A MANUAL Booking never has one (rule E).
    const depositCents =
      source === "MANUAL"
        ? 0
        : this.bookingService.calculateBookingDepositCents(eligiblePlatformFeeBasisCents);

    // Bookly's own economic claim on that SAME deposit — nonzero ONLY on the customer's first
    // eligible booking at this Business (confirmed rule, Batch 6.5). Never a second,
    // independently-computed amount — always exactly `depositCents` or exactly 0.
    const platformFeeCents = source === "BOOKLY_MANAGED" && isFirstBooking ? depositCents : 0;

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
      travelFeeCents,
      eligiblePlatformFeeBasisCents,
      platformFeeCents,
      depositCents,
      balanceDueCents,
      totalCents,
    };
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
      return this.awaitIdempotentBooking(params, claimResult.bookingId);
    }

    const dbSession = await mongoose.startSession();
    let created: BookingDocument | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const reservationsByLineIndex = new Map<number, Types.ObjectId>();

        for (const [index, line] of params.lines.entries()) {
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

        const serviceLines: BookingServiceLine[] = params.lines.map((line, index) => ({
          serviceId: line.service._id,
          serviceSnapshot: line.serviceSnapshot,
          ...(line.staffSnapshot ? { staffSnapshot: line.staffSnapshot } : {}),
          pricingInput: line.pricingInput,
          responsibleStaffMembershipId: line.staffMembership._id,
          addons: line.addons,
          amountCents: line.amountCents,
          reservationId: reservationsByLineIndex.get(index) as Types.ObjectId,
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
            ...(params.notes ? { notes: params.notes } : {}),
          },
          dbSession,
        );
      });
    } catch (error) {
      await this.claimRepository.release(params.idempotencyKey);

      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!created) {
      throw new Error("Booking creation failed without throwing");
    }

    await this.syncBookingCreatedToGoogleCalendar(created);
    await this.dispatchBookingCreatedNotifications(created, params.business);
    await this.dispatchAppointmentReminderScheduling(created);

    return created;
  }

  /** Idempotent-retry resolution: the claim already belongs to a prior (this call's own retry,
   * or a concurrent duplicate) attempt. Bounded poll for the winner's Booking to become visible;
   * if the claim disappears (the earlier attempt failed and released it) before a Booking ever
   * appears, this is a fresh slot — recurse into a brand-new persist attempt exactly once. */
  private async awaitIdempotentBooking(
    params: { business: BusinessDocument; idempotencyKey: string },
    bookingId: Types.ObjectId,
  ): Promise<BookingDocument> {
    for (let attempt = 0; attempt < IDEMPOTENCY_CLAIM_POLL_ATTEMPTS; attempt += 1) {
      const existing = await this.bookingRepository.findById(params.business._id, bookingId);
      if (existing) {
        return existing;
      }

      const claimStillPresent = await this.claimRepository.findByIdempotencyKey(
        params.idempotencyKey,
      );
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
   * Stage B mailing (Triggers 2/3/4): enqueue booking-creation notifications strictly AFTER the
   * booking transaction has committed. Same discipline as syncBookingCreatedToGoogleCalendar —
   * best-effort, never throws (the notifier swallows its own errors), so a notification problem
   * can never roll back a real booking. No-op when no notifier was injected.
   */
  private async dispatchBookingCreatedNotifications(
    created: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    if (!this.bookingCreatedNotifier) {
      return;
    }
    await this.bookingCreatedNotifier.notifyBookingCreated(created, business);
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
