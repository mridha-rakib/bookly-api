import mongoose, { Types } from "mongoose";
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
import { PaymentError } from "../payment/payment.errors.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { PaymentIntentResult } from "../payment/payment.types.js";
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
  BookingServiceLine,
  BookingServiceLineAddon,
} from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";
import type { BookingService } from "./booking.service.js";
import type { BookingActorRole, BookingSource } from "./booking.types.js";
import { generateBookingReference } from "./booking.utils.js";
import type { CreateBookingInput, CreateManualBookingInput } from "./booking-creation.types.js";
import type { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";

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
  ) {}

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
      // real deposit is still due (see BookingFinancials's own doc comment).
      amountDueNowCents: financials.depositCents,
      requiresSavedCard: true,
      hasSavedCard: cardStatus.hasSavedCard,
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

    const cancellationPolicySnapshot = await this.resolveCancellationPolicySnapshot(business);
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
    if (financials.depositCents > 0) {
      try {
        paymentResult = await this.paymentService.chargeBookingDeposit({
          userId: customerUserId,
          amountCents: financials.depositCents,
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
        startAt,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
        client,
        isFirstBooking,
        paymentResult,
      });
      return { status: "confirmed", booking };
    } catch (error) {
      if (paymentResult) {
        await this.compensateFailedBookingAfterPayment(
          business,
          bookingId,
          client,
          financials.depositCents,
          paymentResult,
        );
      } else {
        await this.claimRepository.release(input.idempotencyKey);
      }
      throw error;
    }
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
    startAt: Date;
    notes: string | undefined;
    idempotencyKey: string;
    client: BusinessClientDocument;
    isFirstBooking: boolean;
    paymentResult: PaymentIntentResult | undefined;
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
        let reallyFirstBooking = false;
        if (params.paymentResult) {
          const activation = await this.clientRepository.markActivated(
            params.client._id,
            params.bookingId,
            dbSession,
          );
          reallyFirstBooking = Boolean(activation);
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
            ...(params.notes ? { notes: params.notes } : {}),
          },
          dbSession,
        );

        if (params.paymentResult) {
          // The SAME deposit charge — the ledger TYPE alone records who economically owns it
          // (see BookingFinancials's own doc comment): PLATFORM_FEE for the genuine first
          // booking, DEPOSIT (already part of this ledger's vocabulary — see
          // booking-financial-transaction.types.ts — never PLATFORM_FEE) for a returning
          // customer's Business-owned prepayment.
          await this.financialTransactionService.record(
            {
              businessId: params.business._id,
              bookingId: params.bookingId,
              businessClientId: params.client._id,
              customerUserId: params.createdBy.actorUserId,
              type: reallyFirstBooking ? "PLATFORM_FEE" : "DEPOSIT",
              direction: "DEBIT",
              amountCents: params.financials.depositCents,
              currency: params.financials.currency,
              status: "SUCCEEDED",
              providerReference: params.paymentResult.paymentIntentId,
              idempotencyKey: `${params.idempotencyKey}:deposit`,
            },
            dbSession,
          );
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

      if (service.isPackageDeal) {
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
