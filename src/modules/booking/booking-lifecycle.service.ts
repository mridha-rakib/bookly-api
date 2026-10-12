import mongoose, { type ClientSession, Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type { AppointmentReminderSchedulingPort } from "../appointment-reminder/appointment-reminder-scheduler.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import type { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import type { IntegrationService } from "../integration/integration.service.js";
import type { BookingRescheduledCustomerNotificationPort } from "../notification/booking-rescheduled-customer.notifier.js";
import type { StaffBookingNotificationPort } from "../notification/staff-booking.notifier.js";
import { PackageProgressError } from "../package-progress/package-progress.errors.js";
import type { PackageProgressDocument } from "../package-progress/package-progress.model.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import { PackageProgressRepository as PackageRepository } from "../package-progress/package-progress.repository.js";
import {
  isPackageLinkedBooking,
  packageSessionOutcomeForBookingStatus,
} from "../package-progress/package-progress.rules.js";
import { PackageProgressService } from "../package-progress/package-progress.service.js";
import type { PaymentService } from "../payment/payment.service.js";
import { ensureRefundAccounting } from "../payment/refund-accounting.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { PromoRedemptionRepository } from "../promo/promo-redemption.repository.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRole } from "../user/user.types.js";
import { BookingError } from "./booking.errors.js";
import type {
  BookingCancellationOutcome,
  BookingDocument,
  BookingEventHistoryEntry,
  BookingRescheduleEntry,
  BookingServiceLine,
} from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";
import type { BookingService } from "./booking.service.js";
import {
  type BookingActorRole,
  type BookingStatus,
  MAX_CUSTOMER_RESCHEDULE_COUNT,
  NO_SHOW_RESOLUTION_WINDOW_MINUTES,
} from "./booking.types.js";
import { buildCancellationOutcome } from "./booking-cancellation-classification.js";
import {
  cancellationObligationKey,
  computeNoShowPenalty,
  isDuplicateLedgerKeyError,
  isPenaltyCollectible,
  noShowObligationKey,
  PenaltyCollectionService,
  type PenaltyGate,
  type PreparedPenalty,
} from "./penalty-collection.service.js";

/**
 * Stage C mailing observer. Optional + trailing so every existing construction site is
 * unchanged; invoked only from completeBooking's post-commit tail and must never throw (the
 * implementation swallows its own errors, exactly like the Google Calendar side effects).
 */
export type BookingCompletedNotificationPort = {
  notifyBookingCompleted(booking: BookingDocument, business: BusinessDocument): Promise<void>;
};

/** Stage D mailing observer ports (optional + trailing, never throw). */
export type BookingCancelledNotificationPort = {
  notifyPackageTerminated?(
    booking: BookingDocument,
    business: BusinessDocument,
    progress: PackageProgressDocument,
    session?: ClientSession,
  ): Promise<void>;
  notifyBookingCancelled(
    booking: BookingDocument,
    business: BusinessDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
    /** The real, authoritative outcome of a refund the caller just executed — see
     * BookingCancelledNotifier's own doc comment for why this must never be re-derived from the
     * booking's own persisted `cancellationOutcome`. */
    refundOutcome?: {
      succeeded: boolean;
      amountCents: number;
      status?: "PENDING" | "SUCCEEDED" | "FAILED";
    },
    /** See BookingCancelledNotifier's own doc comment — only used when a SECOND, distinct
     * notification for the same booking must coexist with an already-enqueued plain one. */
    eventKeyOverride?: string,
    session?: ClientSession,
  ): Promise<void>;
};
export type NoShowNotificationPort = {
  notifyNoShowWaived(booking: BookingDocument, context: { businessName: string }): Promise<void>;
  notifyNoShowCancelled(booking: BookingDocument, context: { businessName: string }): Promise<void>;
};

/**
 * Business-owner "Complete Booking" venue-payment settlement. Explicit 3-state discriminator
 * (never inferred from an ambiguous `paid` + `amountCents` pair):
 *  - FULL     — the whole remaining `balanceDueCents` was received off-platform.
 *  - PARTIAL  — `amountCents` was received; must be a whole number strictly in (0, balanceDue).
 *  - NOT_PAID — nothing received yet.
 * Bookkeeping only — never triggers a saved-card charge.
 */
export type CompleteVenuePaymentInput =
  | { settlement: "FULL"; note?: string | undefined }
  | { settlement: "PARTIAL"; amountCents: number; note?: string | undefined }
  | { settlement: "NOT_PAID"; note?: string | undefined };

/** What a waiver forgives: the obligation type, the shortfall it would have charged, the
 * canonical obligation key (the SAME gate as the charge) and the Booking's own transition. */
type FeeWaiverPlan = {
  type: "NO_SHOW_FEE" | "CANCELLATION_FEE";
  amountCents: number;
  idempotencyKey: string;
  directSet: Record<string, unknown>;
  nextStatus?: BookingStatus;
};

/**
 * P5 — a positive customer cancellation shortfall: the durable obligation (+ its one
 * PaymentAttempt) and the "fee collection pending" notification commit with the cancellation.
 * `result.prepared` is overwritten on every transaction attempt (withTransaction may retry).
 */
type CancellationPenaltyPlan = {
  amounts: {
    amountCents: number;
    grossFeeCents: number;
    upfrontAppliedCents: number;
    feePercentage: number | undefined;
  };
  business: BusinessDocument | null;
  result: { prepared?: PreparedPenalty | undefined };
};

/**
 * Batch 3's canonical, non-bypassable status-transition surface — every mutation here (a) CAS's
 * on the Booking's CURRENT status (see BookingRepository.casUpdate/casUpdateForCustomer) so a
 * concurrent racer either loses cleanly or lands on a still-valid state, never a lost update,
 * and (b) appends an eventHistory entry with an actor role always derived from the AUTHENTICATED
 * context the controller passes in, never trusted from the request body.
 *
 * Only the safe, non-payment-dependent transitions confirmed for this batch are implemented:
 * UPCOMING -> COMPLETED, UPCOMING -> CANCELLED_BY_CUSTOMER / LATE_CANCELLATION,
 * UPCOMING -> CANCELLED_BY_BUSINESS, and both reschedule variants (which stay on UPCOMING). No
 * arbitrary status-patch endpoint exists — every legal transition has its own explicit method
 * with its own actor/authorization/timing rules. No-show charging, refund execution, and the
 * 90-minute worker are explicitly out of scope — see the Batch 3 final report.
 */
export class BookingLifecycleService {
  public constructor(
    private readonly bookingService: BookingService,
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly reservationService: BookingSlotReservationService,
    private readonly availabilityService: AvailabilityService,
    private readonly serviceRepository: ServiceRepository,
    private readonly staffRepository: StaffRepository,
    private readonly paymentService: PaymentService,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    // Optional — see BookingCreationService's identical trailing-optional-dep pattern/comment.
    // `deleteEventForBooking` (cancellation) + `updateEventScheduleForBooking` (reschedule).
    private readonly integrationService?: Pick<
      IntegrationService,
      "deleteEventForBooking" | "updateEventScheduleForBooking"
    >,
    // Optional trailing dep (same rationale). Stage C mailing: enqueues the customer
    // BOOKING_COMPLETED notification from completeBooking's post-commit tail. Absent in the
    // integration suites that construct this service directly — a safe no-op there.
    private readonly bookingCompletedNotifier?: BookingCompletedNotificationPort,
    // Stage D mailing observers — same optional-trailing pattern. Cancellation notifications
    // (customer + owner) and no-show waived/cancelled notifications (customer). Absent in the
    // integration suites that construct this service directly.
    private readonly bookingCancelledNotifier?: BookingCancelledNotificationPort,
    private readonly noShowNotifier?: Pick<
      NoShowNotificationPort,
      "notifyNoShowWaived" | "notifyNoShowCancelled"
    >,
    // Important-staff-notification observer (optional + trailing, never throws). Emails the
    // staff actually assigned to a booking when it is cancelled or its appointment time moves.
    private readonly staffBookingNotifier?: StaffBookingNotificationPort,
    // Appointment reminders (optional + trailing, never throws). Retires the pending 24h
    // reminder on any transition out of UPCOMING, and re-schedules it on a reschedule. Absent
    // in the integration suites that construct this service directly.
    private readonly appointmentReminderScheduler?: AppointmentReminderSchedulingPort,
    // MANDATORY customer reschedule confirmation (optional + trailing, never throws). Enqueues
    // the BOOKING_RESCHEDULED_CUSTOMER email from performReschedule's post-commit tail — for a
    // customer reschedule AND an Owner/Supervisor reschedule alike. Deliberately independent of
    // any reminder-preference gate. Absent in the integration suites that construct this service
    // directly — a safe no-op there.
    private readonly bookingRescheduledCustomerNotifier?: BookingRescheduledCustomerNotificationPort,
    // Package Deal session lifecycle hooks (optional + trailing, same rationale as every other
    // dep above). completeBooking marks a redeemed session COMPLETED (informational only); every
    // terminal-status transition that can result from cancellation/waive-fee/no-show-resolution
    // resolves the Package session as RESTORE or FORFEIT per package-progress.rules.ts's own
    // single source of truth (Phase 4B correction — see that file's doc comment for the full
    // confirmed mapping). Every hook is a best-effort no-op for a Booking that carries no
    // packageProgressId at all (every normal, non-Package booking) and absent entirely in suites
    // that construct this service directly without exercising Package Deals.
    private readonly packageProgressRepository?: Pick<
      PackageProgressRepository,
      | "resolveSessionOnTerminalStatus"
      | "markSessionCompleted"
      | "findByIdForCustomerAndBusiness"
      | "voidPackage"
      | "findByIdInternal"
      | "settleVoidRefund"
    >,
    private readonly relationships: FinancialRelationshipService = createFinancialRelationshipService(
      { bookingRepository },
    ),
    private readonly promoRedemptions = new PromoRedemptionRepository(),
    // P5 — durable customer penalty collection (obligation in the lifecycle transaction, one
    // PaymentAttempt, shared convergence, waiver/reversal gate). Defaults to one built from the
    // dependencies above; production passes the fully wired instance (settlement notifier).
    private readonly penaltyCollection: PenaltyCollectionService = new PenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      businessRepository,
      packageProgressRepository,
    }),
  ) {}

  /** Best-effort — no-op for a Booking with no Package-linked line (every normal booking).
   * Never throws: PackageProgressRepository's own hooks are already idempotent filter-guarded
   * updates, and a missing/absent repository is itself a valid, supported configuration. */
  private async syncPackageSessionOnCompletion(
    booking: BookingDocument,
    session: ClientSession,
  ): Promise<void> {
    if (!this.packageProgressRepository || !isPackageLinkedBooking(booking)) {
      return;
    }
    await this.packageProgressRepository.markSessionCompleted(booking._id, session);
  }

  /**
   * Resolves the Package session's fate for ANY terminal status a Booking can reach via
   * cancellation, fee-waiver, or no-show resolution — the ONE place that decision is applied
   * (package-progress.rules.ts's packageSessionOutcomeForBookingStatus is the ONE place it is
   * DECIDED). Called from every code path that can produce one of the six statuses that function
   * maps: performCancellationTransaction (CANCELLED_BY_CUSTOMER/CANCELLED_BY_BUSINESS/
   * LATE_CANCELLATION), waiveFee's three internal branches and resolveNoShowByBusiness
   * (NO_SHOW_WAIVED/NO_SHOW_CANCELLED), and NoShowResolutionService.autoResolve
   * (NO_SHOW_CHARGED/NO_SHOW_WAIVED, called from that separate class via the same repository).
   */
  private async syncPackageSessionOnTerminalStatus(
    booking: BookingDocument,
    session?: ClientSession,
  ): Promise<void> {
    if (!this.packageProgressRepository || !isPackageLinkedBooking(booking)) {
      return;
    }
    const outcome = packageSessionOutcomeForBookingStatus(booking.status);
    if (outcome === "NONE") {
      return;
    }
    await this.packageProgressRepository.resolveSessionOnTerminalStatus(
      booking._id,
      outcome,
      session,
    );
  }

  /** Post-commit tail — retire the 24h reminder for a booking leaving UPCOMING. Best-effort,
   * never throws (the scheduler swallows its own errors). No-op when no scheduler was injected. */
  private async retireAppointmentReminder(
    booking: BookingDocument,
    reasonCategory: string,
  ): Promise<void> {
    if (!this.appointmentReminderScheduler) {
      return;
    }
    await this.appointmentReminderScheduler.onBookingRetired(booking, reasonCategory);
  }

  /**
   * Best-effort Google Calendar cleanup for CANCELLED_BY_CUSTOMER / CANCELLED_BY_BUSINESS /
   * LATE_CANCELLATION (product scope: "any cancellation status deletes the synced event" — see
   * this batch's audit). Deliberately NOT wired into cancelNoShowByBusiness's NO_SHOW_CANCELLED
   * transition — that is a distinct no-show code path outside this pass's confirmed scope.
   * Never throws (see IntegrationService.deleteEventForBooking's own contract).
   */
  private async syncBookingCancelledToGoogleCalendar(booking: BookingDocument): Promise<void> {
    if (!booking.googleCalendarEventId || !this.integrationService) {
      return;
    }

    await this.integrationService.deleteEventForBooking(
      booking.businessId,
      booking.googleCalendarEventId,
    );
    await this.bookingRepository.casUpdate(booking.businessId, booking._id, [booking.status], {
      unset: { googleCalendarEventId: "" },
    });
  }

  // --- Completion ---------------------------------------------------------------------------

  /**
   * `venuePayment` (Batch 5) captures the Business's own attestation of whether the customer
   * paid the remaining `financials.balanceDueCents` at the venue (confirmed via the
   * business-owner "Complete Booking" reference screenshot — see
   * docs/figma-booking-reference/business-owner/complete.png). This is money collected entirely
   * OFF-platform (cash/card-in-person) — Bookly cannot independently verify it, so
   * `venuePayment.amountCents` is a deliberate, narrow exception to "never trust client-supplied
   * financial values" (see BookingCompletionPayment's own doc comment): it is recorded for
   * reporting only, never fed into any Bookly-computed fee/deposit. Optional and
   * backward-compatible — omitting it (e.g. a MANUAL booking, or a booking with no balance due)
   * leaves `completionPayment` unset and behaves exactly as before this batch.
   */
  public async completeBooking(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    venuePayment?: CompleteVenuePaymentInput,
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, ["UPCOMING"]);
    const now = new Date();

    const event: BookingEventHistoryEntry = {
      type: "STATUS_CHANGED",
      previousStatus: "UPCOMING",
      nextStatus: "COMPLETED",
      actorUserId: new Types.ObjectId(actorUserId),
      actorRole: actorRole as BookingActorRole,
      ...(venuePayment?.note ? { note: venuePayment.note } : {}),
      createdAt: now,
    };

    // The remaining venue balance the customer owes off-platform. FULL = it was all received;
    // PARTIAL = a validated amount strictly between 0 and the balance; NOT_PAID = nothing yet.
    // This is bookkeeping only — NO saved-card charge ever happens here (see
    // BookingCompletionPayment's own doc comment). `venueAmountCents` is computed once and
    // reused for BOTH the Booking's own completionPayment record and the ledger entry, so the
    // two can never disagree.
    const balanceDueCents = booking.financials.balanceDueCents;
    let venuePaid = false;
    let venueAmountCents = 0;
    if (venuePayment) {
      if (venuePayment.settlement === "FULL") {
        venuePaid = true;
        venueAmountCents = balanceDueCents;
      } else if (venuePayment.settlement === "NOT_PAID") {
        venuePaid = false;
        venueAmountCents = 0;
      } else {
        // PARTIAL — must be a whole number strictly inside (0, balanceDueCents). When the
        // deposit already covered everything (balanceDueCents === 0) a PARTIAL is impossible
        // and is rejected here.
        const amount = venuePayment.amountCents;
        if (!Number.isInteger(amount) || amount <= 0 || amount >= balanceDueCents) {
          throw new BookingError("BOOKING_INVALID_VENUE_PAYMENT_AMOUNT", 400);
        }
        venuePaid = true;
        venueAmountCents = amount;
      }
    }

    const completionPayment = venuePayment
      ? {
          paid: venuePaid,
          ...(venueAmountCents > 0 ? { amountCents: venueAmountCents } : {}),
          ...(venuePayment.note ? { note: venuePayment.note } : {}),
          recordedAt: now,
          recordedBy: new Types.ObjectId(actorUserId),
        }
      : undefined;

    // Reservations/history are never touched on completion — a completed appointment's
    // occupancy remains as immutable history (see booking-slot-reservation.model.ts; Batch 2's
    // Availability reads are forward-looking only, so leaving a past interval in place is safe
    // and correct, never a stale-conflict risk). The status CAS and the (purely internal, no
    // external Stripe call) venue-payment ledger entry are written atomically in one
    // transaction — unlike the Stripe-charging flows elsewhere in this file, there is no
    // external call here that would need to sit outside a DB transaction.
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        updated = await this.bookingRepository.casUpdate(
          business._id,
          booking._id,
          ["UPCOMING"],
          {
            set: {
              status: "COMPLETED",
              ...(completionPayment ? { completionPayment } : {}),
            },
            pushEvent: event,
          },
          dbSession,
        );

        if (!updated) {
          throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
        }

        await this.syncPackageSessionOnCompletion(updated, dbSession);

        if (venueAmountCents > 0) {
          await this.financialTransactionService.record(
            {
              businessId: business._id,
              bookingId: booking._id,
              businessClientId: booking.customer.businessClientId,
              customerUserId: booking.customer.customerUserId,
              type: "PAYMENT",
              direction: "DEBIT",
              amountCents: venueAmountCents,
              currency: booking.financials.currency,
              status: "SUCCEEDED",
              idempotencyKey: `venue-payment:${String(booking._id)}`,
              metadata: { collectedAtVenue: true },
            },
            dbSession,
          );
        }
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!updated) {
      throw new Error("Booking completion failed without throwing");
    }

    // Stage C mailing — enqueue the customer's BOOKING_COMPLETED email strictly AFTER the
    // completion transaction has committed. Best-effort, never throws: a notification / PDF /
    // provider problem can never undo the completed booking.
    await this.dispatchBookingCompletedNotification(updated, business);
    await this.retireAppointmentReminder(updated, "BOOKING_COMPLETED");

    return updated;
  }

  private async dispatchBookingCompletedNotification(
    completed: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    if (!this.bookingCompletedNotifier) {
      return;
    }
    await this.bookingCompletedNotifier.notifyBookingCompleted(completed, business);
  }

  // --- Cancellation --------------------------------------------------------------------------

  /**
   * Customer-initiated cancellation. The Booking's own status transition (LATE_CANCELLATION vs
   * CANCELLED_BY_CUSTOMER, and the slot release) happens FIRST and unconditionally — the
   * appointment IS cancelled and the slot IS released regardless of whether fee collection
   * later succeeds (rule: "Do not conflate booking lifecycle status with payment settlement
   * status").
   *
   * P5 — a positive shortfall is collected DURABLY: the PENDING CANCELLATION_FEE obligation, its
   * single PaymentAttempt and the "booking cancelled, fee collection pending" notification all
   * commit inside the cancellation transaction. Only after commit is the one off-session
   * provider attempt dispatched (Stripe calls never belong inside a DB transaction), and its
   * outcome is settled through the shared penalty convergence — the same logic the webhook and
   * money recovery use if this process dies or the provider answer is ambiguous — which records
   * `cancellationOutcome.settlementStatus` and the truthful follow-up exactly once.
   */
  public async cancelByCustomer(
    customerUserId: string,
    bookingId: string,
    reason: string | undefined,
  ): Promise<BookingDocument> {
    const booking = await this.requireBookingForCustomer(bookingId, customerUserId, ["UPCOMING"]);
    const now = new Date();

    // Batch 6.5: the already-collected deposit may be ledgered as PLATFORM_FEE (first booking)
    // OR DEPOSIT (returning booking) — both are real customer prepayment, so both must be found
    // here; searching PLATFORM_FEE alone would silently treat a returning customer's real
    // deposit as if nothing had ever been paid.
    const upfrontPayment = await this.financialTransactionService.findSucceededUpfrontPayment(
      booking._id,
    );
    const classifiedOutcome = buildCancellationOutcome({
      scheduledStartAt: booking.schedule.startAt,
      now,
      policySnapshot: booking.cancellationPolicySnapshot,
      eligiblePlatformFeeBasisCents: booking.financials.eligiblePlatformFeeBasisCents,
      depositAlreadyPaidCents: upfrontPayment?.amountCents ?? 0,
    });
    // The STATUS classification (on-time vs late) is always derived from the real, unmodified
    // classification above — reused exactly as-is, never a new cutoff (confirmed Package rule).
    const nextStatus: BookingStatus =
      classifiedOutcome.feeMode === "PERCENTAGE" ? "LATE_CANCELLATION" : "CANCELLED_BY_CUSTOMER";

    // Package rule (confirmed): "the lost session IS the penalty" — a late-cancelled
    // Package-linked Booking (the purchase session OR a redeemed session) is FORFEITED
    // (see syncPackageSessionOnTerminalStatus) but must NEVER also carry an additional
    // percentage-based cancellation fee on top. The fee-bearing fields are zeroed for
    // PERSISTENCE and for the charge-decision below; `nextStatus` above already used the real
    // classification, so the LATE_CANCELLATION status itself is untouched — only the money is
    // suppressed. A $0 redeemed session already produces a $0 fee here regardless (its
    // `eligiblePlatformFeeBasisCents` is 0), so this only has a real effect for the Package
    // purchase Booking (session 1), which carries the genuine bundle-price basis.
    //
    // P5 Rule 6 — a MANUAL booking is financially outside Bookly (rule E, matching the no-show
    // worker's existing MANUAL skip): it keeps its lifecycle classification, but automatic
    // off-session collection is NOT_APPLICABLE, so a linked customer's saved card is never used.
    const outcome: BookingCancellationOutcome =
      isPackageLinkedBooking(booking) || booking.source === "MANUAL"
        ? {
            ...classifiedOutcome,
            cancellationFeeCents: 0,
            depositAppliedCents: 0,
            additionalChargeCents: 0,
            settlementStatus: "NOT_APPLICABLE",
          }
        : classifiedOutcome;

    const event: BookingEventHistoryEntry = {
      type: "STATUS_CHANGED",
      previousStatus: "UPCOMING",
      nextStatus,
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
      ...(reason ? { reason } : {}),
      createdAt: now,
    };

    // Zero shortfall (fee fully covered by the retained upfront, FREE tier, Package, MANUAL):
    // no obligation, no PaymentAttempt, no provider call.
    const penalty =
      outcome.settlementStatus === "PENDING" &&
      outcome.additionalChargeCents > 0 &&
      isPenaltyCollectible(booking)
        ? {
            amounts: {
              amountCents: outcome.additionalChargeCents,
              grossFeeCents: outcome.cancellationFeeCents,
              upfrontAppliedCents: outcome.depositAppliedCents,
              feePercentage: outcome.feePercentage,
            },
            business: await this.businessRepository.findById(booking.businessId),
          }
        : undefined;
    const penaltyResult: { prepared?: PreparedPenalty | undefined } = {};

    const cancelled = await this.performCancellationTransaction({
      booking,
      nextStatus,
      cancellationOutcome: outcome,
      event,
      scopedToCustomerUserId: customerUserId,
      ...(penalty ? { penalty: { ...penalty, result: penaltyResult } } : {}),
    });

    await this.syncBookingCancelledToGoogleCalendar(cancelled);
    await this.retireAppointmentReminder(cancelled, `BOOKING_${cancelled.status}`);

    const prepared = penaltyResult.prepared;
    if (!prepared) {
      await this.dispatchCancellationNotifications(cancelled, "CUSTOMER");
      await this.dispatchStaffCancellationNotification(cancelled, "CUSTOMER");
      return cancelled;
    }

    // The cancellation (and its pending notification) is already committed and final. Send the
    // one durable provider attempt and converge it; an ambiguous outcome stays PENDING for
    // recovery and is never retried here.
    if (prepared.attempt) {
      await this.penaltyCollection.collect(prepared.obligation._id);
    }
    const settled = (await this.bookingRepository.findByIdOnly(cancelled._id)) ?? cancelled;
    await this.dispatchStaffCancellationNotification(settled, "CUSTOMER");
    return settled;
  }

  /**
   * Business-initiated cancellation — never charges the customer a cancellation fee (confirmed
   * rule: "customer should not owe a cancellation fee"). If an online deposit was already
   * collected (ledgered as PLATFORM_FEE for a first booking, or DEPOSIT for a returning one —
   * see BookingFinancialTransactionService.findSucceededUpfrontPayment; Batch 6.5 correction:
   * searching PLATFORM_FEE alone would silently skip refunding a returning customer's real
   * deposit), it is refunded in full — a real Stripe refund, never assumed successful until
   * Stripe confirms it. Refunding the FULL deposit is correct regardless of who economically
   * owned it (Bookly or the Business): a business-caused cancellation is never the customer's
   * fault either way.
   */
  public async cancelByBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    reason: string | undefined,
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, [
      "UPCOMING",
      "CANCELLED_BY_BUSINESS",
    ]);
    const now = new Date();

    const upfrontPayment = await this.financialTransactionService.findSucceededUpfrontPayment(
      booking._id,
    );
    if (booking.status === "CANCELLED_BY_BUSINESS") {
      if (!upfrontPayment) return booking;
      const result = await this.executeBusinessCancellationRefund(booking, upfrontPayment);
      await this.dispatchCancellationNotifications(result.booking, "BUSINESS", business, {
        succeeded: result.refundSucceeded,
        amountCents: result.refundedAmountCents,
        status: result.settlementStatus,
      });
      return result.booking;
    }
    const refundOwedCents = upfrontPayment?.amountCents ?? 0;

    // A Business-initiated cancellation is never the customer's fault — always FREE to the
    // customer regardless of timing (never LATE_CANCELLATION), unlike cancelByCustomer's
    // timing-classified outcome above.
    const outcome: BookingCancellationOutcome = {
      classifiedAt: now,
      tier: "MORE_THAN_72_HOURS",
      feeMode: "FREE",
      cancellationFeeCents: 0,
      depositAppliedCents: 0,
      additionalChargeCents: 0,
      refundOwedCents,
      settlementStatus: refundOwedCents > 0 ? "PENDING" : "NOT_APPLICABLE",
    };

    const event: BookingEventHistoryEntry = {
      type: "STATUS_CHANGED",
      previousStatus: "UPCOMING",
      nextStatus: "CANCELLED_BY_BUSINESS",
      actorUserId: new Types.ObjectId(actorUserId),
      actorRole: actorRole as BookingActorRole,
      ...(reason ? { reason } : {}),
      createdAt: now,
    };

    const cancelled = await this.performCancellationTransaction({
      booking,
      nextStatus: "CANCELLED_BY_BUSINESS",
      cancellationOutcome: outcome,
      event,
    });

    await this.syncBookingCancelledToGoogleCalendar(cancelled);
    await this.retireAppointmentReminder(cancelled, "BOOKING_CANCELLED_BY_BUSINESS");

    if (!upfrontPayment || refundOwedCents <= 0) {
      await this.dispatchCancellationNotifications(cancelled, "BUSINESS", business);
      await this.dispatchStaffCancellationNotification(cancelled, "BUSINESS", business);
      return cancelled;
    }

    const {
      booking: refunded,
      refundSucceeded,
      refundedAmountCents,
      settlementStatus,
    } = await this.executeBusinessCancellationRefund(cancelled, upfrontPayment);
    await this.dispatchCancellationNotifications(refunded, "BUSINESS", business, {
      succeeded: refundSucceeded,
      amountCents: refundedAmountCents,
      status: settlementStatus,
    });
    await this.dispatchStaffCancellationNotification(refunded, "BUSINESS", business);
    return refunded;
  }

  /** Legacy unused-package endpoint; retains its narrower eligibility and notification key. */
  public async voidUnusedPackage(
    customerUserId: string,
    businessId: string,
    packageProgressId: string,
    reason: string | undefined,
  ): Promise<PackageProgressDocument> {
    const result = await this.packageAction(
      customerUserId,
      "CUSTOMER",
      businessId,
      packageProgressId,
      "TERMINATE",
      reason,
      true,
    );
    const progress = result.packageProgress;
    if (progress.voidRefundSettlement) {
      const origin = await this.bookingRepository.findById(
        progress.businessId,
        progress.originBookingId,
      );
      if (origin)
        await this.dispatchCancellationNotifications(
          origin,
          "CUSTOMER",
          undefined,
          {
            succeeded: progress.voidRefundSettlement.status === "SUCCEEDED",
            amountCents: progress.voidRefundSettlement.amountCents,
            status: progress.voidRefundSettlement.status,
          },
          `PACKAGE_REFUND:${String(origin._id)}`,
        );
    }
    return progress;
  }

  public async getPackageForBusiness(
    actorUserId: string,
    role: UserRole,
    businessId: string,
    packageId: string,
  ) {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      role,
      businessId,
    );
    const packages = new PackageRepository();
    const progress = Types.ObjectId.isValid(packageId)
      ? await packages.findByIdInternal(packageId)
      : null;
    if (!progress?.businessId.equals(business._id))
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    return new PackageProgressService(packages, this.bookingRepository).getForCustomer(
      String(progress.customerUserId),
      packageId,
    );
  }

  public async packageAction(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    packageId: string,
    action: "CANCEL_FUTURE" | "TERMINATE",
    reason?: string,
    unusedOnly = false,
  ): Promise<{ packageProgress: PackageProgressDocument; cancelledBookingIds: string[] }> {
    const packages = this.packageProgressRepository;
    if (!packages || !Types.ObjectId.isValid(packageId) || !Types.ObjectId.isValid(businessId))
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const customer = actorRole === "CUSTOMER";
    if (!customer && action === "TERMINATE" && actorRole !== "BUSINESS_OWNER")
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const business = customer
      ? await this.businessRepository.findById(businessId)
      : await this.bookingService.requireBookingManagementAccess(
          actorUserId,
          actorRole,
          businessId,
        );
    if (!business) throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const session = await mongoose.startSession();
    let cancelled: BookingDocument[] = [];
    let refundBookings: BookingDocument[] = [];
    try {
      await session.withTransaction(async () => {
        cancelled = [];
        refundBookings = [];
        const progress = await packages.findByIdInternal(packageId, session);
        if (
          !progress ||
          !progress.businessId.equals(business._id) ||
          (customer && !progress.customerUserId.equals(actorUserId))
        )
          throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
        if (unusedOnly && progress.voidedAt)
          throw new PackageProgressError("PACKAGE_PROGRESS_ALREADY_VOIDED", 409);
        if (
          unusedOnly &&
          progress.sessions.some(
            (entry) =>
              entry.status === "COMPLETED" ||
              entry.status === "FORFEITED" ||
              (entry.status === "SCHEDULED" && !entry.bookingId.equals(progress.originBookingId)),
          )
        )
          throw new PackageProgressError("PACKAGE_PROGRESS_NOT_ELIGIBLE_FOR_REFUND", 409);
        const ids = [
          ...new Set([
            String(progress.originBookingId),
            ...progress.sessions.map((entry) => String(entry.bookingId)),
          ]),
        ];
        const bookings = await this.bookingRepository.findManyByIdsForCustomer(
          progress.businessId,
          ids,
          progress.customerUserId,
          session,
        );
        const origin = bookings.find((booking) => booking._id.equals(progress.originBookingId));
        if (
          !origin ||
          bookings.length !== ids.length ||
          bookings.some(
            (booking) =>
              !booking.serviceLines.some(
                (line) => String(line.pricingInput.packageProgressId) === packageId,
              ),
          )
        )
          throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
        if (progress.voidedAt) {
          if (action === "CANCEL_FUTURE")
            throw new PackageProgressError("PACKAGE_PROGRESS_VOIDED", 409);
          cancelled = bookings.filter((booking) =>
            booking.eventHistory.some((event) => event.note === `PACKAGE_TERMINATE:${packageId}`),
          );
          refundBookings = bookings; // Resume committed intents only; never authorize new restoration.
          return;
        }
        const now = new Date();
        if (
          action === "TERMINATE" &&
          bookings.some(
            (booking) =>
              booking.status === "PENDING" ||
              (booking.status === "UPCOMING" &&
                booking.schedule.startAt.getTime() <= now.getTime()),
          )
        )
          throw new PackageProgressError("PACKAGE_PROGRESS_UNRESOLVED_APPOINTMENT", 409);
        for (const booking of bookings) {
          if (booking.status === "COMPLETED")
            await this.syncPackageSessionOnCompletion(booking, session);
          else await this.syncPackageSessionOnTerminalStatus(booking, session);
        }
        for (const booking of bookings) {
          if (
            booking.status !== "UPCOMING" ||
            booking.schedule.startAt.getTime() <= now.getTime() ||
            (action === "CANCEL_FUTURE" && booking._id.equals(progress.originBookingId))
          )
            continue;
          const upfront = await this.financialTransactionService.findSucceededUpfrontPayment(
            booking._id,
          );
          const classified = buildCancellationOutcome({
            scheduledStartAt: booking.schedule.startAt,
            now,
            policySnapshot: booking.cancellationPolicySnapshot,
            eligiblePlatformFeeBasisCents: booking.financials.eligiblePlatformFeeBasisCents,
            depositAlreadyPaidCents: upfront?.amountCents ?? 0,
          });
          const nextStatus: BookingStatus = customer
            ? classified.feeMode === "PERCENTAGE"
              ? "LATE_CANCELLATION"
              : "CANCELLED_BY_CUSTOMER"
            : "CANCELLED_BY_BUSINESS";
          const outcome: BookingCancellationOutcome = customer
            ? {
                ...classified,
                cancellationFeeCents: 0,
                depositAppliedCents: 0,
                additionalChargeCents: 0,
                settlementStatus: "NOT_APPLICABLE",
              }
            : {
                classifiedAt: now,
                tier: "MORE_THAN_72_HOURS",
                feeMode: "FREE",
                cancellationFeeCents: 0,
                depositAppliedCents: 0,
                additionalChargeCents: 0,
                refundOwedCents: upfront?.amountCents ?? 0,
                settlementStatus: upfront ? "PENDING" : "NOT_APPLICABLE",
              };
          const updated = await this.applyCancellation(
            {
              booking,
              nextStatus,
              cancellationOutcome: outcome,
              event: {
                type: "STATUS_CHANGED",
                previousStatus: "UPCOMING",
                nextStatus,
                actorUserId: new Types.ObjectId(actorUserId),
                actorRole: actorRole as BookingActorRole,
                note: `PACKAGE_${action}:${packageId}`,
                ...(reason ? { reason } : {}),
                createdAt: now,
              },
              ...(customer ? { scopedToCustomerUserId: actorUserId } : {}),
            },
            session,
          );
          cancelled.push(updated);
          if (!unusedOnly)
            await this.bookingCancelledNotifier?.notifyBookingCancelled(
              updated,
              business,
              customer ? "CUSTOMER" : "BUSINESS",
              undefined,
              undefined,
              session,
            );
          if (!customer && upfront) refundBookings.push(updated);
        }
        if (action === "TERMINATE") {
          const refreshed = await packages.findByIdInternal(packageId, session);
          if (!refreshed || refreshed.sessions.some((entry) => entry.status === "SCHEDULED"))
            throw new PackageProgressError("PACKAGE_PROGRESS_UNRESOLVED_APPOINTMENT", 409);
          const used = refreshed.sessions.some(
            (entry) => entry.status === "COMPLETED" || entry.status === "FORFEITED",
          );
          if (unusedOnly && used)
            throw new PackageProgressError("PACKAGE_PROGRESS_NOT_ELIGIBLE_FOR_REFUND", 409);
          const source = await this.financialTransactionService.findSucceededUpfrontPayment(
            origin._id,
          );
          const refundOrigin = customer
            ? !used
            : origin.financialContract?.classification === "FIRST" ||
              cancelled.some((booking) => booking._id.equals(origin._id));
          const refund = refundOrigin
            ? await this.prepareRefundIntent(
                origin,
                source,
                session,
                customer ? "PACKAGE_VOID" : "BUSINESS_PACKAGE_TERMINATION",
                progress._id,
              )
            : undefined;
          const voided = await packages.voidPackage(
            progress._id,
            refund
              ? {
                  status:
                    refund.providerStatus === "SUCCEEDED"
                      ? "SUCCEEDED"
                      : refund.providerStatus === "FAILED"
                        ? "FAILED"
                        : "PENDING",
                  amountCents: refund.expectedRefundAmountCents,
                  refundOperationId: refund._id,
                  ...(refund.providerRefundId ? { providerRefundId: refund.providerRefundId } : {}),
                }
              : undefined,
            session,
          );
          if (!voided) throw new PackageProgressError("PACKAGE_PROGRESS_ALREADY_VOIDED", 409);
          if (!customer)
            await this.relationships.beginBusinessCancellation(
              origin,
              source,
              refund,
              session,
              progress._id,
            );
          if (refund) refundBookings.push(origin);
          if (!unusedOnly)
            await this.bookingCancelledNotifier?.notifyPackageTerminated?.(
              origin,
              business,
              voided,
              session,
            );
        }
      });
    } finally {
      await session.endSession();
    }
    for (const booking of new Map(
      refundBookings.map((booking) => [String(booking._id), booking]),
    ).values()) {
      const intent = await this.paymentService.findRefundOperation(
        `business-cancel-refund:${String(booking._id)}`,
      );
      if (!intent) continue;
      const source = await this.financialTransactionService.findSucceededUpfrontPayment(
        booking._id,
      );
      if (source) await this.executeBusinessCancellationRefund(booking, source);
    }
    for (const booking of cancelled) {
      await this.syncBookingCancelledToGoogleCalendar(booking);
      await this.retireAppointmentReminder(booking, `BOOKING_${booking.status}`);
      const current = await this.bookingRepository.findById(business._id, booking._id);
      await this.dispatchCancellationNotifications(
        current ?? booking,
        customer ? "CUSTOMER" : "BUSINESS",
        business,
      );
      await this.dispatchStaffCancellationNotification(
        booking,
        customer ? "CUSTOMER" : "BUSINESS",
        business,
      );
    }
    const finalProgress = await packages.findByIdInternal(packageId);
    if (!finalProgress) throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    if (action === "TERMINATE") {
      const origin = (
        await this.bookingRepository.findManyByIds(business._id, [finalProgress.originBookingId])
      )[0];
      if (origin)
        await this.bookingCancelledNotifier?.notifyPackageTerminated?.(
          origin,
          business,
          finalProgress,
        );
    }
    return {
      packageProgress: finalProgress,
      cancelledBookingIds: cancelled.map((booking) => String(booking._id)),
    };
  }

  private async dispatchCancellationNotifications(
    booking: BookingDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
    business?: BusinessDocument,
    refundOutcome?: {
      succeeded: boolean;
      amountCents: number;
      status?: "PENDING" | "SUCCEEDED" | "FAILED";
    },
    eventKeyOverride?: string,
  ): Promise<void> {
    if (!this.bookingCancelledNotifier) {
      return;
    }
    const resolvedBusiness =
      business ?? (await this.businessRepository.findById(booking.businessId));
    if (!resolvedBusiness) {
      return;
    }
    await this.bookingCancelledNotifier.notifyBookingCancelled(
      booking,
      resolvedBusiness,
      cancelledBy,
      refundOutcome,
      eventKeyOverride,
    );
  }

  /**
   * Important-staff-notification tail for a cancellation — emails ONLY the staff assigned to the
   * booking's service lines. Runs after the customer/owner notifications, best-effort, and can
   * never throw (the notifier swallows its own errors; this wrapper guards the business fetch).
   */
  private async dispatchStaffCancellationNotification(
    booking: BookingDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
    business?: BusinessDocument,
  ): Promise<void> {
    if (!this.staffBookingNotifier) {
      return;
    }
    try {
      const resolvedBusiness =
        business ?? (await this.businessRepository.findById(booking.businessId));
      if (!resolvedBusiness) {
        return;
      }
      await this.staffBookingNotifier.notifyBookingCancelledToStaff(
        booking,
        resolvedBusiness.name,
        cancelledBy,
      );
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to dispatch staff cancellation notification (the cancellation is unaffected)",
      );
    }
  }

  /**
   * Best-effort, post-commit Google Calendar sync for a reschedule (product scope: one-way
   * Bookly -> Google). Runs strictly AFTER the reschedule transaction committed and never throws
   * — a Google API failure must not roll back a valid reschedule (ground rule; mirrors
   * syncBookingCancelledToGoogleCalendar). The SAME event is PATCHed (start/end only); its
   * identity (calendarId + googleCalendarEventId) is never changed here.
   *
   * The live re-read immediately before the provider call is REQUIRED, not a query to optimise
   * away:
   *  - rapid A(10->11) then B(11->12): whichever sync sends last re-reads 12:00 and PATCHes
   *    12:00, so the external event converges to the newest committed time (never regresses);
   *  - cancel-after-reschedule: the re-read sees status != UPCOMING and skips the PATCH, so a
   *    delayed reschedule sync can never move a just-cancelled event.
   */
  private async syncBookingRescheduledToGoogleCalendar(booking: BookingDocument): Promise<void> {
    if (!booking.googleCalendarEventId || !this.integrationService) {
      return;
    }

    try {
      const latest = await this.bookingRepository.findById(booking.businessId, booking._id);
      if (latest?.status !== "UPCOMING" || !latest.googleCalendarEventId) {
        return;
      }

      await this.integrationService.updateEventScheduleForBooking(
        latest.businessId,
        latest.googleCalendarEventId,
        {
          startAt: latest.schedule.startAt,
          endAt: latest.schedule.endAt,
          timezone: latest.schedule.timezone,
        },
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          bookingId: String(booking._id),
          businessId: String(booking.businessId),
          integration: "google_calendar",
          operation: "reschedule",
        },
        "Failed to sync rescheduled booking to Google Calendar (the reschedule is unaffected)",
      );
    }
  }

  /**
   * Important-staff-notification tail for a reschedule — emails ONLY the assigned staff that the
   * appointment date/time moved. Best-effort, never throws.
   */
  private async dispatchStaffRescheduleNotification(booking: BookingDocument): Promise<void> {
    if (!this.staffBookingNotifier) {
      return;
    }
    try {
      const business = await this.businessRepository.findById(booking.businessId);
      if (!business) {
        return;
      }
      await this.staffBookingNotifier.notifyBookingRescheduledToStaff(booking, business.name);
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to dispatch staff reschedule notification (the reschedule is unaffected)",
      );
    }
  }

  /**
   * MANDATORY customer transactional email — enqueues the BOOKING_RESCHEDULED_CUSTOMER
   * confirmation strictly AFTER the reschedule transaction committed. Best-effort, never throws
   * (the notifier swallows its own errors). Reuses the Business the caller already loaded, so no
   * extra query is issued. Deliberately NOT gated by any reminder preference — a reminder
   * opt-out must never suppress a committed booking-reschedule confirmation.
   */
  private async dispatchRescheduledCustomerNotification(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    if (!this.bookingRescheduledCustomerNotifier) {
      return;
    }
    try {
      await this.bookingRescheduledCustomerNotifier.notifyBookingRescheduledToCustomer(
        booking,
        business,
      );
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to dispatch customer reschedule notification (the reschedule is unaffected)",
      );
    }
  }

  /** The refund leg of a Business cancellation (a customer's penalty is collected by
   * PenaltyCollectionService instead).
   * `upfrontPayment` is whichever of PLATFORM_FEE/DEPOSIT actually settled for this booking —
   * the full amount is refunded regardless of which type it was (see cancelByBusiness's own
   * doc comment). `_id`/`type` (Batch 8) are recorded on the REFUND entry's own metadata so
   * FinanceOwnership can attribute the reversal to the correct party (a Bookly-owned
   * PLATFORM_FEE refund reduces Bookly's revenue; a Business-owned DEPOSIT refund reduces the
   * Business's payable) — never inferred from date/amount alone. */
  private async executeBusinessCancellationRefund(
    booking: BookingDocument,
    upfrontPayment: {
      _id: Types.ObjectId;
      type: BookingFinancialTransactionDocument["type"];
      providerReference?: string | undefined;
      amountCents: number;
    },
    options: {
      domainReason?: "BUSINESS_CANCELLATION" | "PACKAGE_VOID" | "BUSINESS_PACKAGE_TERMINATION";
      packageProgressId?: Types.ObjectId | undefined;
    } = {},
  ): Promise<{
    booking: BookingDocument;
    /** The real, authoritative outcome of THIS refund attempt — never re-derived afterward from
     * `booking.cancellationOutcome` (see cancellation-email-data.ts's own doc comment for why
     * that field only ever records intent, not result). Every caller that notifies about this
     * refund must pass this straight through as the notifier's `refundOutcome`. */
    refundSucceeded: boolean;
    refundedAmountCents: number;
    settlementStatus: "PENDING" | "SUCCEEDED" | "FAILED";
    refundOperationId?: string | undefined;
    providerRefundId?: string | undefined;
  }> {
    const idempotencyKey = `business-cancel-refund:${String(booking._id)}`;
    let settlementStatus: "PENDING" | "SUCCEEDED" | "FAILED" = "PENDING";
    let refundId: string | undefined;
    let refundOperationId: string | undefined;

    try {
      if (!upfrontPayment.providerReference) {
        throw new Error("No provider reference to refund");
      }
      const prepared = await this.paymentService.findRefundOperation(idempotencyKey);
      const refund = await this.paymentService.refund({
        paymentIntentId: upfrontPayment.providerReference,
        amountCents: upfrontPayment.amountCents,
        currency: booking.financials.currency,
        idempotencyKey,
        reason: "requested_by_customer",
        domainReason: prepared?.reason ?? options.domainReason ?? "BUSINESS_CANCELLATION",
        sourceFinancialTransactionId: upfrontPayment._id,
        bookingId: booking._id,
        packageProgressId: prepared?.packageProgressId ?? options.packageProgressId,
        businessId: booking.businessId,
        businessClientId: booking.customer.businessClientId,
        customerUserId: booking.customer.customerUserId,
      });
      refundId = refund.refundId;
      refundOperationId = refund.refundOperationId;
      settlementStatus =
        refund.status === "succeeded"
          ? "SUCCEEDED"
          : refund.status === "failed"
            ? "FAILED"
            : "PENDING";
    } catch {
      // Best-effort — never thrown: the cancellation itself already succeeded.
      const operation = await this.paymentService.findRefundOperation(idempotencyKey);
      refundOperationId = operation ? String(operation._id) : undefined;
      settlementStatus = operation
        ? operation.providerStatus === "SUCCEEDED"
          ? "SUCCEEDED"
          : operation.providerStatus === "FAILED"
            ? "FAILED"
            : "PENDING"
        : "FAILED";
      refundId = operation?.providerRefundId;
    }

    const refunds = new RefundOperationRepository();
    const operation = refundOperationId ? await refunds.findById(refundOperationId) : null;
    if (operation?.providerStatus === "SUCCEEDED") {
      await ensureRefundAccounting(operation, this.financialTransactionService, refunds);
      settlementStatus = "SUCCEEDED";
      refundId = operation.providerRefundId;
      await this.relationships.reconcileQuietly(booking.customer.businessClientId);
    } else {
      const key = refundOperationId
        ? `refund-operation:${refundOperationId}:ledger`
        : `${idempotencyKey}:ledger`;
      if (!(await this.financialTransactionService.findByIdempotencyKey(key))) {
        try {
          await this.financialTransactionService.record({
            businessId: booking.businessId,
            bookingId: booking._id,
            businessClientId: booking.customer.businessClientId,
            customerUserId: booking.customer.customerUserId,
            type: "REFUND",
            direction: "CREDIT",
            amountCents: upfrontPayment.amountCents,
            currency: booking.financials.currency,
            status: settlementStatus,
            ...(refundId ? { providerReference: refundId } : {}),
            idempotencyKey: key,
            metadata: {
              sourceType: upfrontPayment.type,
              sourceTransactionId: String(upfrontPayment._id),
            },
          });
        } catch (error) {
          if (!(await this.financialTransactionService.findByIdempotencyKey(key))) throw error;
        }
      }
    }

    const updated = await this.bookingRepository.updateCancellationSettlement(
      booking._id,
      settlementStatus,
      refundId,
    );
    if (
      operation?.packageProgressId &&
      this.packageProgressRepository &&
      settlementStatus !== "PENDING"
    ) {
      const progress = await this.packageProgressRepository.findByIdInternal(
        operation.packageProgressId,
      );
      if (progress?.voidedAt)
        await this.packageProgressRepository.settleVoidRefund(
          operation._id,
          settlementStatus,
          refundId,
        );
    }
    return {
      booking:
        updated ??
        (await this.bookingRepository.findById(booking.businessId, booking._id)) ??
        booking,
      refundSucceeded: settlementStatus === "SUCCEEDED",
      refundedAmountCents: upfrontPayment.amountCents,
      settlementStatus,
      refundOperationId,
      providerRefundId: refundId,
    };
  }

  private async prepareRefundIntent(
    booking: BookingDocument,
    source: BookingFinancialTransactionDocument | undefined,
    session: ClientSession,
    reason = "BUSINESS_CANCELLATION",
    packageId?: Types.ObjectId,
  ) {
    if (!source || source.amountCents <= 0) return undefined;
    if (!source.providerReference)
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    return this.paymentService.prepareRefund(
      {
        logicalIdempotencyKey: `business-cancel-refund:${String(booking._id)}`,
        sourcePaymentIntentId: source.providerReference,
        sourceFinancialTransactionId: source._id,
        expectedRefundAmountCents: source.amountCents,
        currency: booking.financials.currency,
        bookingId: booking._id,
        businessId: booking.businessId,
        businessClientId: booking.customer.businessClientId,
        customerUserId: booking.customer.customerUserId,
        reason,
        ...(packageId ? { packageProgressId: packageId } : {}),
      },
      session,
    );
  }

  private async applyCancellation(
    params: {
      booking: BookingDocument;
      nextStatus: BookingStatus;
      cancellationOutcome: BookingCancellationOutcome;
      event: BookingEventHistoryEntry;
      scopedToCustomerUserId?: string;
      penalty?: CancellationPenaltyPlan;
    },
    session: ClientSession,
  ): Promise<BookingDocument> {
    await this.releaseAllLines(params.booking, session);
    const update = {
      set: { status: params.nextStatus, cancellationOutcome: params.cancellationOutcome },
      pushEvent: params.event,
      extraFilter: { "schedule.startAt": params.booking.schedule.startAt },
    };
    const updated = params.scopedToCustomerUserId
      ? await this.bookingRepository.casUpdateForCustomer(
          params.booking._id,
          params.scopedToCustomerUserId,
          ["UPCOMING"],
          update,
          session,
        )
      : await this.bookingRepository.casUpdate(
          params.booking.businessId,
          params.booking._id,
          ["UPCOMING"],
          update,
          session,
        );
    if (!updated) throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    await this.syncPackageSessionOnTerminalStatus(updated, session);
    if (params.nextStatus === "CANCELLED_BY_BUSINESS") {
      const source = await this.financialTransactionService.findSucceededUpfrontPayment(
        updated._id,
      );
      const refund = await this.prepareRefundIntent(updated, source, session);
      if (!isPackageLinkedBooking(updated)) {
        await this.relationships.beginBusinessCancellation(updated, source, refund, session);
        if (updated.customer.customerUserId)
          await this.promoRedemptions.restoreBusinessCancellation(
            {
              bookingId: updated._id,
              businessId: updated.businessId,
              customerUserId: updated.customer.customerUserId,
              actorUserId: params.event.actorUserId,
            },
            session,
          );
      }
    }
    if (params.penalty) {
      return this.prepareCancellationPenalty(updated, params.penalty, session);
    }
    return updated;
  }

  /** P5 — inside the cancellation transaction: the canonical PENDING CANCELLATION_FEE
   * obligation (`cancellation-fee:<bookingId>`) and its single PaymentAttempt, then the durable
   * cancellation notification. With no usable saved card the obligation is created definitively
   * FAILED and the settlement records FAILED in the same transaction (nothing is ever sent). */
  private async prepareCancellationPenalty(
    cancelled: BookingDocument,
    penalty: CancellationPenaltyPlan,
    session: ClientSession,
  ): Promise<BookingDocument> {
    penalty.result.prepared = undefined;
    const prepared = await this.penaltyCollection.prepareObligation(
      { booking: cancelled, type: "CANCELLATION_FEE", ...penalty.amounts },
      session,
    );
    penalty.result.prepared = prepared;
    const current = prepared.attempt
      ? cancelled
      : ((await this.bookingRepository.settleCancellationPenalty(
          cancelled._id,
          "FAILED",
          undefined,
          session,
        )) ?? cancelled);
    if (penalty.business && this.bookingCancelledNotifier) {
      await this.bookingCancelledNotifier.notifyBookingCancelled(
        current,
        penalty.business,
        "CUSTOMER",
        undefined,
        undefined,
        session,
      );
    }
    return current;
  }

  private async performCancellationTransaction(params: {
    booking: BookingDocument;
    nextStatus: BookingStatus;
    cancellationOutcome: BookingCancellationOutcome;
    event: BookingEventHistoryEntry;
    scopedToCustomerUserId?: string;
    penalty?: CancellationPenaltyPlan;
  }): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        updated = await this.applyCancellation(params, dbSession);
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!updated) {
      throw new Error("Booking transition failed without throwing");
    }
    return updated;
  }

  // --- No-show (Batch 4) -----------------------------------------------------------------

  /**
   * The only writer of `noShowStartedAt`/`noShowDeadlineAt` (Batch 1's own comment on those
   * fields: "only by an explicit business-side 'mark as no-show' action... never by a
   * timer/cron reacting to a missed appointment on its own" — still true; the WORKER only
   * resolves a timer that a human already started, it never starts one). Deliberately does not
   * release the reservation — the appointment time has already passed; Availability reads are
   * forward-looking only (see booking-slot-reservation.model.ts), so leaving it in place is
   * harmless and matches how `completeBooking` already treats past occupancy as immutable
   * history.
   */
  public async markNoShow(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    reason?: string | undefined,
    internalNote?: string | undefined,
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, ["UPCOMING"]);
    const now = new Date();

    // Category no-show eligibility window (confirmed rule): a business may only START the
    // no-show flow while `startAt + opensAfter <= now < startAt + closesAfter` — open
    // boundary INCLUSIVE, close boundary EXCLUSIVE, server time authoritative. Enforced only
    // for bookings that carry a `noShowEligibilitySnapshot` (captured at creation time);
    // pre-existing bookings without one keep the legacy status-only behavior (backward
    // compatibility rule).
    const eligibility = booking.noShowEligibilitySnapshot;
    if (eligibility) {
      const startMs = booking.schedule.startAt.getTime();
      const opensAtMs = startMs + eligibility.opensAfterMinutes * 60_000;
      const closesAtMs = startMs + eligibility.closesAfterMinutes * 60_000;
      const nowMs = now.getTime();
      if (nowMs < opensAtMs) {
        throw new BookingError("BOOKING_NO_SHOW_WINDOW_NOT_OPEN", 409);
      }
      if (nowMs >= closesAtMs) {
        throw new BookingError("BOOKING_NO_SHOW_WINDOW_CLOSED", 409);
      }
    }

    // The 90-minute resolution timer begins NOW (the confirmation/mark instant), never at
    // appointment start — see NO_SHOW_RESOLUTION_WINDOW_MINUTES's own doc comment.
    const deadline = new Date(now.getTime() + NO_SHOW_RESOLUTION_WINDOW_MINUTES * 60_000);

    const updated = await this.bookingRepository.casUpdate(
      business._id,
      booking._id,
      ["UPCOMING"],
      {
        set: { status: "PENDING", noShowStartedAt: now, noShowDeadlineAt: deadline },
        pushEvent: {
          type: "STATUS_CHANGED",
          previousStatus: "UPCOMING",
          nextStatus: "PENDING",
          actorUserId: new Types.ObjectId(actorUserId),
          actorRole: actorRole as BookingActorRole,
          // Mark-no-show reason taxonomy is SEPARATE from the waive-fee reason taxonomy and is
          // internal-only (never serialized in any customer-facing DTO — booking.dto.ts does
          // not include eventHistory). Optional per the current design.
          ...(reason ? { reason } : {}),
          ...(internalNote ? { note: internalNote } : {}),
          createdAt: now,
        },
      },
    );

    if (!updated) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }

    // A no-show means the appointment start has already passed — the worker's own eligibility
    // check would skip the reminder anyway; retiring it explicitly just keeps the collection tidy.
    await this.retireAppointmentReminder(updated, "BOOKING_NO_SHOW");
    return updated;
  }

  /**
   * Batch 5, item 9 (WAIVE FEE FLOW, required) — the Business explicitly forgives an
   * outstanding no-show or late-cancellation fee. `reason` is mandatory (the UI's own
   * "Reason for waiving (required)" field — see WaiveChargeModal.tsx); `internalNote` is
   * optional and, like every `eventHistory.note`, is never included in any customer-facing DTO
   * (see booking.dto.ts, which does not serialize eventHistory at all).
   *
   * Applicable to exactly two states (mirrors NoShowResolutionService's own "nothing
   * chargeable" branches, extended to a NEW explicit-cancellation-fee-waiver case this batch
   * introduces):
   *  - `PENDING` (the no-show timer is running, or a claimed no-show awaits manual resolution) —
   *    waives the no-show fee and resolves the no-show as NO_SHOW_WAIVED.
   *  - `LATE_CANCELLATION` whose fee is still outstanding (`settlementStatus` PENDING with no
   *    charge ever started, or FAILED after a definitive collection failure — P5 Rule 3) — the
   *    Booking's own lifecycle `status` does NOT change (it is already correctly
   *    LATE_CANCELLATION regardless of settlement — Batch 4's "never conflate booking status
   *    with payment settlement status" rule), only `cancellationOutcome.settlementStatus` moves
   *    to `"WAIVED"`.
   *
   * Both branches net against the deposit already collected exactly like a real charge would
   * (see BookingCancellationOutcome's own doc comment) — `additionalChargeCents` (not the gross
   * fee) is the "amount that would have been charged" this waives. When that amount is already
   * 0 (the deposit alone already covers the fee — nothing was ever going to be newly charged),
   * the Booking is resolved directly with no ledger entry: there is nothing to waive.
   *
   * CONCURRENCY (required guarantee): waive-vs-charge can never both settle the same
   * obligation. The waiver uses the SAME canonical obligation key as the charge
   * (`no-show:{id}` / `cancellation-fee:{id}`) — P5 removed the old parallel `…:ledger` charge
   * key — and decides from PenaltyCollectionService.inspectGate:
   *  - no obligation: a WAIVED row is inserted under that key in the same transaction as the
   *    Booking CAS, so a racing claim and a racing waive can never both win;
   *  - PENDING / UNKNOWN / in flight: refused (charge in progress);
   *  - SUCCEEDED: refused (a collected fee can never be waived);
   *  - definitive failure (failed / canceled / provider-not-created / no usable card): that SAME
   *    FAILED row becomes WAIVED, exactly once;
   *  - already WAIVED: idempotent.
   */
  public async waiveFee(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    reason: string,
    internalNote: string | undefined,
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, [
      "PENDING",
      "LATE_CANCELLATION",
    ]);

    const plan = await this.planFeeWaiver(booking);
    if (!plan) {
      throw new BookingError("BOOKING_NO_WAIVABLE_FEE", 409);
    }

    const now = new Date();
    const event: BookingEventHistoryEntry = {
      type: "FEE_WAIVED",
      previousStatus: booking.status,
      nextStatus: plan.nextStatus ?? booking.status,
      actorUserId: new Types.ObjectId(actorUserId),
      actorRole: actorRole as BookingActorRole,
      reason,
      ...(internalNote ? { note: internalNote } : {}),
      createdAt: now,
    };

    if (plan.amountCents <= 0 && !booking.noShowChargeClaimedAt) {
      const updated = await this.bookingRepository.casUpdate(
        business._id,
        booking._id,
        [booking.status],
        {
          set: plan.directSet,
          pushEvent: event,
          ...(plan.type === "NO_SHOW_FEE"
            ? { extraFilter: { noShowChargeClaimedAt: { $exists: false } } }
            : {}),
        },
      );
      if (!updated) {
        throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
      }
      await this.syncPackageSessionOnTerminalStatus(updated);
      await this.dispatchNoShowWaivedNotification(updated, business.name);
      return updated;
    }

    const result = await this.applyGatedWaiver(business, booking, plan, event);
    await this.dispatchNoShowWaivedNotification(result, business.name);
    return result;
  }

  /**
   * Stage D — the customer NO_SHOW_WAIVED email. Only fires when the waiver actually resolved
   * a NO-SHOW (status now NO_SHOW_WAIVED); a LATE_CANCELLATION fee waiver keeps its own status
   * and gets the P5 penalty settlement follow-up instead (enqueued with the waiver itself).
   * Best-effort.
   */
  private async dispatchNoShowWaivedNotification(
    booking: BookingDocument,
    businessName: string,
  ): Promise<void> {
    if (!this.noShowNotifier || booking.status !== "NO_SHOW_WAIVED") {
      return;
    }
    await this.noShowNotifier.notifyNoShowWaived(booking, { businessName });
  }

  private async planFeeWaiver(booking: BookingDocument): Promise<FeeWaiverPlan | null> {
    if (booking.status === "PENDING") {
      // Package rule (confirmed): "the lost session IS the penalty" — a Package-linked no-show
      // never carries an additional base-service percentage fee, matching autoResolve's own
      // suppression in NoShowResolutionService (the two paths share computeNoShowPenalty, so a
      // manual waive and the worker's own auto-resolution never disagree on what was ever owed).
      // P5 — a MANUAL booking (or one with no linked customer) was never collectible either, so
      // there is no obligation to waive for it.
      const upfrontPayment = await this.financialTransactionService.findSucceededUpfrontPayment(
        booking._id,
      );
      const penalty = computeNoShowPenalty(booking, upfrontPayment?.amountCents ?? 0);
      return {
        type: "NO_SHOW_FEE",
        amountCents: isPenaltyCollectible(booking) ? penalty.amountCents : 0,
        idempotencyKey: noShowObligationKey(booking._id),
        directSet: { status: "NO_SHOW_WAIVED" },
        nextStatus: "NO_SHOW_WAIVED",
      };
    }

    const settlementStatus = booking.cancellationOutcome?.settlementStatus;
    if (
      booking.status === "LATE_CANCELLATION" &&
      booking.cancellationOutcome &&
      (settlementStatus === "PENDING" || settlementStatus === "FAILED")
    ) {
      return {
        type: "CANCELLATION_FEE",
        amountCents: booking.cancellationOutcome.additionalChargeCents,
        idempotencyKey: cancellationObligationKey(booking._id),
        directSet: { "cancellationOutcome.settlementStatus": "WAIVED" },
      };
    }

    return null;
  }

  /** P5 — the waiver decided by the canonical obligation's gate (see waiveFee's own comment). */
  private async applyGatedWaiver(
    business: BusinessDocument,
    booking: BookingDocument,
    plan: FeeWaiverPlan,
    event: BookingEventHistoryEntry,
    retried = false,
  ): Promise<BookingDocument> {
    const gate = await this.penaltyCollection.inspectGate(plan.type, booking._id);
    switch (gate.state) {
      case "SUCCEEDED":
        throw new BookingError("BOOKING_FEE_ALREADY_CHARGED", 409);
      case "IN_PROGRESS":
        throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
      case "RECONCILIATION_REQUIRED":
        throw new BookingError("BOOKING_FEE_RECONCILIATION_REQUIRED", 409);
      case "WAIVED": {
        // Idempotent: this exact waiver (possibly this same caller, retried after a dropped
        // response) already won. Report the Booking's current state, not an error.
        const current = await this.bookingRepository.findById(business._id, booking._id);
        if (!current) throw new BookingError("BOOKING_NOT_FOUND", 404);
        return current;
      }
      case "DEFINITIVE_FAILURE":
        return this.convertFailedFeeToWaiver(business, booking, plan, event, gate.obligation);
      case "NONE":
        if (
          plan.type === "CANCELLATION_FEE" &&
          booking.cancellationOutcome?.settlementStatus !== "PENDING"
        ) {
          // A FAILED settlement with no obligation at all is a pre-P5 record whose charge
          // outcome cannot be proven — never waived blind.
          throw new BookingError("BOOKING_FEE_RECONCILIATION_REQUIRED", 409);
        }
        return this.insertFeeWaiver(business, booking, plan, event, retried);
    }
  }

  /** No obligation exists yet: the WAIVED row is inserted under the canonical key in the SAME
   * transaction as the Booking CAS, so a concurrent claim (same unique key, same booking
   * document) and this waiver can never both commit. A lost race re-reads the gate once. */
  private async insertFeeWaiver(
    business: BusinessDocument,
    booking: BookingDocument,
    plan: FeeWaiverPlan,
    event: BookingEventHistoryEntry,
    retried: boolean,
  ): Promise<BookingDocument> {
    let duplicateKey = false;
    let updated: BookingDocument | null = null;
    try {
      updated = await this.runWaiverTransaction(async (dbSession) => {
        try {
          await this.financialTransactionService.record(
            {
              businessId: business._id,
              bookingId: booking._id,
              businessClientId: booking.customer.businessClientId,
              customerUserId: booking.customer.customerUserId,
              type: plan.type,
              direction: "DEBIT",
              amountCents: plan.amountCents,
              currency: booking.financials.currency,
              status: "WAIVED",
              idempotencyKey: plan.idempotencyKey,
              metadata: { reason: event.reason ?? "" },
            },
            dbSession,
          );
        } catch (error) {
          // Deliberately rethrown — the transaction aborts (nothing committed) and the gate is
          // re-read outside it, once we know nothing from this attempt persisted.
          if (isDuplicateLedgerKeyError(error)) duplicateKey = true;
          throw error;
        }
        return this.applyWaiverBookingTransition(business, booking, plan, event, dbSession, {
          ...(plan.type === "NO_SHOW_FEE"
            ? { noShowChargeClaimedAt: { $exists: false } }
            : { "cancellationOutcome.settlementStatus": "PENDING" }),
        });
      });
    } catch (error) {
      if (duplicateKey && !retried) {
        return this.applyGatedWaiver(business, booking, plan, event, true);
      }
      if (duplicateKey) throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
      throw error;
    }
    return updated;
  }

  /** A definitive collection failure (P5 Rule 3) — converts that SAME FAILED obligation row to
   * WAIVED (never a second ledger row under the key) and applies the Booking transition
   * atomically. `settleFailedAsWaived` is CAS'd on FAILED, so this happens exactly once. */
  private async convertFailedFeeToWaiver(
    business: BusinessDocument,
    booking: BookingDocument,
    plan: FeeWaiverPlan,
    event: BookingEventHistoryEntry,
    obligation: BookingFinancialTransactionDocument,
  ): Promise<BookingDocument> {
    return this.runWaiverTransaction(async (dbSession) => {
      const converted = await this.financialTransactionService.settleFailedAsWaived(
        obligation._id,
        dbSession,
      );
      if (!converted) {
        // Someone else converted/claimed it between our read and this write.
        throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
      }
      return this.applyWaiverBookingTransition(
        business,
        booking,
        plan,
        event,
        dbSession,
        plan.type === "CANCELLATION_FEE"
          ? { "cancellationOutcome.settlementStatus": { $in: ["PENDING", "FAILED"] } }
          : undefined,
      );
    });
  }

  private async applyWaiverBookingTransition(
    business: BusinessDocument,
    booking: BookingDocument,
    plan: FeeWaiverPlan,
    event: BookingEventHistoryEntry,
    dbSession: ClientSession,
    extraFilter: Record<string, unknown> | undefined,
  ): Promise<BookingDocument> {
    const updated = await this.bookingRepository.casUpdate(
      business._id,
      booking._id,
      [booking.status],
      { set: plan.directSet, pushEvent: event, ...(extraFilter ? { extraFilter } : {}) },
      dbSession,
    );
    if (!updated) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }
    await this.syncPackageSessionOnTerminalStatus(updated, dbSession);
    if (plan.type === "CANCELLATION_FEE") {
      // P5 Rule 5 — the truthful "fee waived" follow-up, committed with the waiver itself.
      await this.penaltyCollection.notifySettlement(
        updated,
        business,
        { kind: "CANCELLATION_FEE", outcome: "WAIVED", amountCents: plan.amountCents },
        dbSession,
      );
    }
    return updated;
  }

  private async runWaiverTransaction(
    work: (dbSession: ClientSession) => Promise<BookingDocument>,
  ): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;
    try {
      await dbSession.withTransaction(async () => {
        updated = await work(dbSession);
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }
    if (!updated) {
      throw new Error("Fee waiver failed without throwing");
    }
    return updated;
  }

  /** Business cancels the no-show resolution outright (e.g. the appointment is confirmed to
   * have genuinely not happened for a reason that isn't the customer's fault) — same no-charge
   * guarantee as waive, distinct terminal status for audit clarity. */
  public async cancelNoShowByBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
  ): Promise<BookingDocument> {
    return this.resolveNoShowByBusiness(
      actorUserId,
      actorRole,
      businessId,
      bookingId,
      "NO_SHOW_CANCELLED",
    );
  }

  /**
   * P5 Rule 1 — the reversal is no longer a bare status CAS: it consults the canonical NO_SHOW_FEE
   * obligation first and is refused while a charge is pending / in flight / UNKNOWN, or once a
   * fee was collected (no automatic refund exists). It proceeds only with no obligation at all —
   * then its CAS also requires `noShowChargeClaimedAt` absent, so it is atomic against a worker
   * claim — or after a definitive collection failure.
   */
  private async resolveNoShowByBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    nextStatus: "NO_SHOW_WAIVED" | "NO_SHOW_CANCELLED",
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, ["PENDING"]);

    let updated: BookingDocument | null = null;
    for (let attempt = 0; attempt < 2 && !updated; attempt += 1) {
      const gate = await this.penaltyCollection.inspectGate("NO_SHOW_FEE", booking._id);
      this.assertNoShowReversible(gate);
      updated = await this.bookingRepository.casUpdate(business._id, booking._id, ["PENDING"], {
        set: { status: nextStatus },
        pushEvent: {
          type: "STATUS_CHANGED",
          previousStatus: "PENDING",
          nextStatus,
          actorUserId: new Types.ObjectId(actorUserId),
          actorRole: actorRole as BookingActorRole,
          createdAt: new Date(),
        },
        ...(gate.state === "NONE"
          ? { extraFilter: { noShowChargeClaimedAt: { $exists: false } } }
          : {}),
      });
      // A CAS lost to a claim that committed after the gate read re-reads the gate once.
      if (!updated && gate.state !== "NONE") break;
    }

    if (!updated) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }

    await this.syncPackageSessionOnTerminalStatus(updated);

    // Stage D — customer notification for the terminal no-show outcome. Best-effort.
    if (this.noShowNotifier) {
      if (nextStatus === "NO_SHOW_CANCELLED") {
        await this.noShowNotifier.notifyNoShowCancelled(updated, { businessName: business.name });
      } else if (nextStatus === "NO_SHOW_WAIVED") {
        await this.noShowNotifier.notifyNoShowWaived(updated, { businessName: business.name });
      }
    }

    return updated;
  }

  private assertNoShowReversible(gate: PenaltyGate): void {
    if (gate.state === "SUCCEEDED") {
      throw new BookingError("BOOKING_NO_SHOW_FEE_ALREADY_CHARGED", 409);
    }
    if (gate.state === "IN_PROGRESS") {
      throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
    }
    if (gate.state === "RECONCILIATION_REQUIRED") {
      throw new BookingError("BOOKING_FEE_RECONCILIATION_REQUIRED", 409);
    }
  }

  private async releaseAllLines(
    booking: BookingDocument,
    session: mongoose.ClientSession,
  ): Promise<void> {
    for (const line of booking.serviceLines) {
      await this.reservationService.release(
        {
          businessId: booking.businessId,
          staffMembershipId: line.responsibleStaffMembershipId,
          timezone: booking.schedule.timezone,
          startAt: booking.schedule.startAt,
          reservationId: line.reservationId,
          partySize: line.pricingInput.personCount ?? 1,
        },
        session,
      );
    }
  }

  // --- Reschedule ----------------------------------------------------------------------------

  public async rescheduleByCustomer(
    customerUserId: string,
    bookingId: string,
    newStartAtIso: string,
  ): Promise<BookingDocument> {
    const booking = await this.requireBookingForCustomer(bookingId, customerUserId, ["UPCOMING"]);

    if (booking.customerRescheduleCount >= MAX_CUSTOMER_RESCHEDULE_COUNT) {
      throw new BookingError("BOOKING_RESCHEDULE_LIMIT_REACHED", 409);
    }

    const business = await this.businessRepository.findById(booking.businessId);
    if (!business) {
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    }

    return this.performReschedule({
      booking,
      business,
      newStartAt: this.parseStartAt(newStartAtIso),
      actorUserId: customerUserId,
      actorRole: "CUSTOMER",
      countsTowardQuota: true,
      scopedToCustomerUserId: customerUserId,
    });
  }

  public async rescheduleByOwner(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
    newStartAtIso: string,
  ): Promise<BookingDocument> {
    const business = await this.bookingService.requireBookingManagementAccess(
      actorUserId,
      actorRole,
      businessId,
    );
    const booking = await this.requireBookingForBusiness(business._id, bookingId, ["UPCOMING"]);

    return this.performReschedule({
      booking,
      business,
      newStartAt: this.parseStartAt(newStartAtIso),
      actorUserId,
      actorRole: actorRole as BookingActorRole,
      countsTowardQuota: false,
    });
  }

  /**
   * Reserve-new-before-release-old, all inside ONE transaction: this is the deliberate fix for
   * the previously-known racy "read availability, then write" pattern (see Batch 2's own
   * report) — if ANY new-slot reservation fails (a genuine conflict, a schedule/time-off
   * violation), the whole transaction aborts and every OLD reservation this Booking already
   * held remains completely untouched and valid; the Booking is never left unscheduled.
   * Multi-line reschedule moves the WHOLE appointment atomically (never per-line) — see
   * BookingCreationService's module doc comment for why that is the only non-invented reading
   * of this schema's single root `schedule`.
   */
  private async performReschedule(params: {
    booking: BookingDocument;
    business: Parameters<AvailabilityService["assertSlotIsBookable"]>[0]["business"];
    newStartAt: Date;
    actorUserId: string;
    actorRole: BookingActorRole;
    countsTowardQuota: boolean;
    scopedToCustomerUserId?: string;
  }): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;
    // Generated ONCE per call (stable across withTransaction's own internal retry-on-
    // TransientTransactionError, but distinct between two genuinely separate calls) — never
    // derived from customerRescheduleCount/rescheduleHistory.length. An earlier version derived
    // it from that mutable state, which is IDENTICAL for two truly concurrent reschedule
    // requests (both read the same pre-reschedule snapshot) and caused both attempts' reservation
    // claims to collide on the same idempotencyKey — a genuine, confirmed livelock under real
    // concurrency (see the Batch 3 final report). This nonce is Batch 3's own internal
    // retry-safety token, not a caller-facing idempotency contract (reschedule has none yet —
    // see the report's open item on this).
    const rescheduleAttemptNonce = new Types.ObjectId().toString();

    try {
      await dbSession.withTransaction(async () => {
        const newReservationIdByLineIndex = new Map<number, Types.ObjectId>();
        let overallNewEndAt = params.newStartAt;

        for (const [index, line] of params.booking.serviceLines.entries()) {
          const [service, staffMembership] = await Promise.all([
            this.serviceRepository.findById(params.booking.businessId, line.serviceId),
            this.staffRepository.findActiveById(
              params.booking.businessId,
              line.responsibleStaffMembershipId,
            ),
          ]);

          if (!service || !staffMembership) {
            throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
          }

          const occupiedMin = line.serviceSnapshot.durationMin;
          const newEndAt = new Date(params.newStartAt.getTime() + occupiedMin * 60_000);
          if (newEndAt > overallNewEndAt) {
            overallNewEndAt = newEndAt;
          }

          const partySize = line.pricingInput.personCount ?? 1;
          const capacityMax =
            line.serviceSnapshot.pricingMode === "PER_PERSON"
              ? (service.perPersonPricing?.maxPersons ?? partySize)
              : 1;

          await this.availabilityService.assertSlotIsBookable({
            business: params.business,
            service,
            staffMembership,
            startAt: params.newStartAt,
            endAt: newEndAt,
            partySize,
          });

          const reservation = await this.reservationService.reserveOrJoin(
            {
              businessId: params.booking.businessId,
              staffMembershipId: line.responsibleStaffMembershipId,
              serviceId: line.serviceId,
              timezone: params.booking.schedule.timezone,
              startAt: params.newStartAt,
              endAt: newEndAt,
              capacityMax,
              partySize,
              idempotencyKey: `${String(params.booking._id)}:reschedule:${rescheduleAttemptNonce}:${index}`,
            },
            dbSession,
          );
          newReservationIdByLineIndex.set(index, reservation.reservationId);
        }

        await this.releaseAllLines(params.booking, dbSession);

        const rescheduleEntry: BookingRescheduleEntry = {
          actorUserId: new Types.ObjectId(params.actorUserId),
          actorRole: params.actorRole,
          previousStart: params.booking.schedule.startAt,
          previousEnd: params.booking.schedule.endAt,
          newStart: params.newStartAt,
          newEnd: overallNewEndAt,
          countedTowardCustomerQuota: params.countsTowardQuota,
          createdAt: new Date(),
        };

        const event: BookingEventHistoryEntry = {
          type: "RESCHEDULED",
          previousStatus: "UPCOMING",
          nextStatus: "UPCOMING",
          actorUserId: new Types.ObjectId(params.actorUserId),
          actorRole: params.actorRole,
          createdAt: new Date(),
        };

        // IMPORTANT: `line` here is a live Mongoose subdocument, not a plain object — spreading
        // it directly (`{...line, reservationId: X}`) silently drops the override and persists
        // the OLD reservationId instead (confirmed empirically against the real MongoDB driver
        // in this batch's own diagnostic, not merely suspected — see the Batch 3 final report).
        // `.toObject()` first produces a genuine plain object, which spreads correctly.
        const newServiceLines: BookingServiceLine[] = params.booking.serviceLines.map(
          (line, index) => ({
            ...(line as unknown as { toObject: () => BookingServiceLine }).toObject(),
            reservationId: newReservationIdByLineIndex.get(index) as Types.ObjectId,
          }),
        );

        const update = {
          set: {
            "schedule.startAt": params.newStartAt,
            "schedule.endAt": overallNewEndAt,
            serviceLines: newServiceLines,
          },
          pushEvent: event,
          pushReschedule: rescheduleEntry,
          incrementCustomerRescheduleCount: params.countsTowardQuota,
          // Optimistic-concurrency guard (see BookingRepository.casUpdate's own comment): status
          // alone never changes across a reschedule, so this proves no OTHER reschedule already
          // moved this Booking between our read and this write — a second concurrent identical
          // request fails this filter cleanly instead of also applying.
          extraFilter: { "schedule.startAt": params.booking.schedule.startAt },
        };

        updated = params.scopedToCustomerUserId
          ? await this.bookingRepository.casUpdateForCustomer(
              params.booking._id,
              params.scopedToCustomerUserId,
              ["UPCOMING"],
              update,
              dbSession,
            )
          : await this.bookingRepository.casUpdate(
              params.booking.businessId,
              params.booking._id,
              ["UPCOMING"],
              update,
              dbSession,
            );

        if (!updated) {
          throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
        }
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!updated) {
      throw new Error("Booking transition failed without throwing");
    }

    // Google Calendar sync — first best-effort post-commit side effect, matching the
    // create/cancel integration-first convention. Never throws; a Google failure can't roll
    // back the reschedule. Live-re-reads the booking so rapid reschedules converge to the
    // newest committed time and a raced cancellation is respected.
    await this.syncBookingRescheduledToGoogleCalendar(updated);

    // Important-staff notification — strictly AFTER the reschedule transaction committed.
    await this.dispatchStaffRescheduleNotification(updated);

    // Retire the reminder for the OLD schedule version and schedule one for the new
    // `schedule.startAt` (or record it skipped if the new time is inside the 24h window).
    // Best-effort, never throws — a reminder problem can never roll back the reschedule.
    if (this.appointmentReminderScheduler) {
      await this.appointmentReminderScheduler.onBookingRescheduled(updated);
    }

    // MANDATORY customer transactional email — the reschedule confirmation. Strictly after
    // commit, best-effort, reuses the already-loaded Business (no extra query), and is
    // deliberately NOT gated by any reminder preference.
    await this.dispatchRescheduledCustomerNotification(updated, params.business);

    return updated;
  }

  // --- Guards -----------------------------------------------------------------------------

  private parseStartAt(startAt: string): Date {
    const parsed = new Date(startAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw new BookingError("BOOKING_SCHEDULE_INVALID", 400);
    }
    return parsed;
  }

  private async requireBookingForBusiness(
    businessId: Types.ObjectId,
    bookingId: string,
    allowedStatuses: BookingStatus[],
  ): Promise<BookingDocument> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    const booking = await this.bookingRepository.findById(businessId, bookingId);
    if (!booking) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    if (!allowedStatuses.includes(booking.status)) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }
    return booking;
  }

  private async requireBookingForCustomer(
    bookingId: string,
    customerUserId: string,
    allowedStatuses: BookingStatus[],
  ): Promise<BookingDocument> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    const booking = await this.bookingRepository.findByIdForCustomer(bookingId, customerUserId);
    if (!booking) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    if (!allowedStatuses.includes(booking.status)) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }
    return booking;
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }
}
