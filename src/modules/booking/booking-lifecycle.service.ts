import mongoose, { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { AppointmentReminderSchedulingPort } from "../appointment-reminder/appointment-reminder-scheduler.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { IntegrationService } from "../integration/integration.service.js";
import type { BookingRescheduledCustomerNotificationPort } from "../notification/booking-rescheduled-customer.notifier.js";
import type { StaffBookingNotificationPort } from "../notification/staff-booking.notifier.js";
import type { PaymentService } from "../payment/payment.service.js";
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
  notifyBookingCancelled(
    booking: BookingDocument,
    business: BusinessDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
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
  ) {}

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
   * status"). If a fee applies, the off-session charge is attempted SECOND, as an independent
   * step OUTSIDE the Mongo transaction (Stripe calls never belong inside a DB transaction) —
   * its real outcome is recorded into `cancellationOutcome.settlementStatus` via a dedicated
   * follow-up write, never assumed.
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
    const outcome = buildCancellationOutcome({
      scheduledStartAt: booking.schedule.startAt,
      now,
      policySnapshot: booking.cancellationPolicySnapshot,
      eligiblePlatformFeeBasisCents: booking.financials.eligiblePlatformFeeBasisCents,
      depositAlreadyPaidCents: upfrontPayment?.amountCents ?? 0,
    });
    const nextStatus: BookingStatus =
      outcome.feeMode === "PERCENTAGE" ? "LATE_CANCELLATION" : "CANCELLED_BY_CUSTOMER";

    const event: BookingEventHistoryEntry = {
      type: "STATUS_CHANGED",
      previousStatus: "UPCOMING",
      nextStatus,
      actorUserId: new Types.ObjectId(customerUserId),
      actorRole: "CUSTOMER",
      ...(reason ? { reason } : {}),
      createdAt: now,
    };

    const cancelled = await this.performCancellationTransaction({
      booking,
      nextStatus,
      cancellationOutcome: outcome,
      event,
      scopedToCustomerUserId: customerUserId,
    });

    await this.syncBookingCancelledToGoogleCalendar(cancelled);
    await this.retireAppointmentReminder(cancelled, `BOOKING_${cancelled.status}`);

    if (outcome.settlementStatus !== "PENDING" || outcome.additionalChargeCents <= 0) {
      await this.dispatchCancellationNotifications(cancelled, "CUSTOMER");
      await this.dispatchStaffCancellationNotification(cancelled, "CUSTOMER");
      return cancelled;
    }

    const charged = await this.executeCancellationFeeCharge(cancelled);
    await this.dispatchCancellationNotifications(charged, "CUSTOMER");
    await this.dispatchStaffCancellationNotification(charged, "CUSTOMER");
    return charged;
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
    const booking = await this.requireBookingForBusiness(business._id, bookingId, ["UPCOMING"]);
    const now = new Date();

    const upfrontPayment = await this.financialTransactionService.findSucceededUpfrontPayment(
      booking._id,
    );
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

    const refunded = await this.executeBusinessCancellationRefund(cancelled, upfrontPayment);
    await this.dispatchCancellationNotifications(refunded, "BUSINESS", business);
    await this.dispatchStaffCancellationNotification(refunded, "BUSINESS", business);
    return refunded;
  }

  /**
   * Stage D — enqueue the customer + Business Owner cancellation emails AFTER the cancellation
   * and its refund/fee leg have reached their authoritative settled state. Best-effort: never
   * throws. `cancelByBusiness` already holds the Business document; `cancelByCustomer` does not,
   * so it is fetched once here.
   */
  private async dispatchCancellationNotifications(
    booking: BookingDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
    business?: BusinessDocument,
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

  /**
   * Attempts the off-session cancellation-fee charge and records the REAL outcome — never
   * inside the cancellation's own transaction (a Stripe call must never sit inside a Mongo
   * transaction). A charge FAILURE deliberately does NOT change the Booking's own status (it is
   * already CANCELLED_BY_CUSTOMER/LATE_CANCELLATION, which is correct regardless) — only
   * `cancellationOutcome.settlementStatus` reflects it, leaving a clear FAILED ledger entry for
   * manual follow-up (no automatic retry/dunning is built this batch — see the Batch 4 final
   * report).
   */
  private async executeCancellationFeeCharge(booking: BookingDocument): Promise<BookingDocument> {
    const customerUserId = booking.customer.customerUserId;
    const idempotencyKey = `cancellation-fee:${String(booking._id)}`;
    // Nets against the deposit already held (see BookingCancellationOutcome's own doc comment) —
    // never the gross `cancellationFeeCents`, which double-charges the portion already collected
    // as the first-booking deposit.
    const amountCents = booking.cancellationOutcome?.additionalChargeCents ?? 0;

    if (!customerUserId || amountCents <= 0) {
      return booking;
    }

    let settlementStatus: "SUCCEEDED" | "FAILED" = "FAILED";
    let providerReference: string | undefined;

    try {
      const result = await this.paymentService.chargeOffSession({
        userId: customerUserId,
        amountCents,
        idempotencyKey,
        metadata: { bookingId: String(booking._id), purpose: "CANCELLATION_FEE" },
      });
      providerReference = result.paymentIntentId;
      settlementStatus = result.status === "succeeded" ? "SUCCEEDED" : "FAILED";
    } catch {
      // A hard failure before any PaymentIntent existed (e.g. no saved card at all — should not
      // happen given booking creation required one, but a card can be removed later) — recorded
      // as FAILED with no provider reference, never thrown: cancellation itself already
      // succeeded and must not be undone by a fee-collection problem.
    }

    await this.financialTransactionService.record({
      businessId: booking.businessId,
      bookingId: booking._id,
      businessClientId: booking.customer.businessClientId,
      customerUserId,
      type: "CANCELLATION_FEE",
      direction: "DEBIT",
      amountCents,
      currency: booking.financials.currency,
      status: settlementStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      ...(providerReference ? { providerReference } : {}),
      idempotencyKey: `${idempotencyKey}:ledger`,
    });

    const updated = await this.bookingRepository.updateCancellationSettlement(
      booking._id,
      settlementStatus,
      providerReference,
    );
    return updated ?? booking;
  }

  /** Symmetric to executeCancellationFeeCharge, for the refund leg of a Business cancellation.
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
  ): Promise<BookingDocument> {
    const idempotencyKey = `business-cancel-refund:${String(booking._id)}`;
    let settlementStatus: "SUCCEEDED" | "FAILED" = "FAILED";
    let refundId: string | undefined;

    try {
      if (!upfrontPayment.providerReference) {
        throw new Error("No provider reference to refund");
      }
      const refund = await this.paymentService.refund({
        paymentIntentId: upfrontPayment.providerReference,
        amountCents: upfrontPayment.amountCents,
        idempotencyKey,
        reason: "requested_by_customer",
      });
      refundId = refund.refundId;
      settlementStatus = refund.status === "succeeded" ? "SUCCEEDED" : "FAILED";
    } catch {
      // Best-effort — never thrown: the cancellation itself already succeeded.
    }

    await this.financialTransactionService.record({
      businessId: booking.businessId,
      bookingId: booking._id,
      businessClientId: booking.customer.businessClientId,
      customerUserId: booking.customer.customerUserId,
      type: "REFUND",
      direction: "CREDIT",
      amountCents: upfrontPayment.amountCents,
      currency: booking.financials.currency,
      status: settlementStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      ...(refundId ? { providerReference: refundId } : {}),
      idempotencyKey: `${idempotencyKey}:ledger`,
      metadata: {
        sourceType: upfrontPayment.type,
        sourceTransactionId: String(upfrontPayment._id),
      },
    });

    const updated = await this.bookingRepository.updateCancellationSettlement(
      booking._id,
      settlementStatus,
      refundId,
    );
    return updated ?? booking;
  }

  private async performCancellationTransaction(params: {
    booking: BookingDocument;
    nextStatus: BookingStatus;
    cancellationOutcome: BookingCancellationOutcome;
    event: BookingEventHistoryEntry;
    scopedToCustomerUserId?: string;
  }): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        await this.releaseAllLines(params.booking, dbSession);

        const update = {
          set: { status: params.nextStatus, cancellationOutcome: params.cancellationOutcome },
          pushEvent: params.event,
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
   *  - `PENDING` (the no-show timer is running) — waives the no-show fee, stops the timer
   *    (status leaves PENDING, so the worker's own `{status:"PENDING", noShowDeadlineAt}` query
   *    naturally excludes it going forward).
   *  - `LATE_CANCELLATION` with `cancellationOutcome.settlementStatus === "PENDING"` — waives
   *    the still-uncollected cancellation fee; the Booking's own lifecycle `status` does NOT
   *    change (it is already correctly LATE_CANCELLATION regardless of settlement — Batch 4's
   *    "never conflate booking status with payment settlement status" rule), only
   *    `cancellationOutcome.settlementStatus` moves to `"WAIVED"`.
   *
   * Both branches net against the deposit already collected exactly like a real charge would
   * (see BookingCancellationOutcome's own doc comment) — `additionalChargeCents` (not the gross
   * fee) is the "amount that would have been charged" this waives. When that amount is already
   * 0 (the deposit alone already covers the fee — nothing was ever going to be newly charged),
   * the Booking is resolved directly with no ledger entry: there is nothing to waive.
   *
   * CONCURRENCY (required guarantee): waive-vs-charge can never both settle the same
   * obligation. Reuses the exact ledger-unique-`idempotencyKey` claim this codebase already
   * established for retry-safe charging (`no-show:{id}` / `cancellation-fee:{id}` — see
   * NoShowResolutionService and executeCancellationFeeCharge) as the SAME atomic gate for
   * waiving: a WAIVED row is inserted under that identical key, inside the same Mongo
   * transaction as the Booking status/settlement CAS, so a racing charge attempt and a racing
   * waive attempt can never both win — see `claimAndApplyWaiver`/`resolveWaiverConflict` for the
   * exact conflict-resolution rules (repeated waive is idempotent; a charge that already
   * succeeded blocks a later waive; a charge that already definitively failed may still be
   * waived afterward).
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

    if (plan.amountCents <= 0) {
      const updated = await this.bookingRepository.casUpdate(
        business._id,
        booking._id,
        [booking.status],
        { set: plan.directSet, pushEvent: event },
      );
      if (!updated) {
        throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
      }
      await this.dispatchNoShowWaivedNotification(updated, business.name);
      return updated;
    }

    const result = await this.claimAndApplyWaiver(business._id, booking, plan, event, reason);
    await this.dispatchNoShowWaivedNotification(result, business.name);
    return result;
  }

  /**
   * Stage D — the customer NO_SHOW_WAIVED email. Only fires when the waiver actually resolved
   * a NO-SHOW (status now NO_SHOW_WAIVED); a LATE_CANCELLATION fee waiver keeps its own status
   * and is out of Stage D scope. Best-effort.
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

  private async planFeeWaiver(booking: BookingDocument): Promise<{
    type: "NO_SHOW_FEE" | "CANCELLATION_FEE";
    amountCents: number;
    idempotencyKey: string;
    directSet: Record<string, unknown>;
    nextStatus?: BookingStatus;
  } | null> {
    if (booking.status === "PENDING") {
      const noShowPercentage = booking.cancellationPolicySnapshot?.noShowPercentage;
      const grossFee = noShowPercentage
        ? Math.round((booking.financials.eligiblePlatformFeeBasisCents * noShowPercentage) / 100)
        : 0;
      const upfrontPayment = await this.financialTransactionService.findSucceededUpfrontPayment(
        booking._id,
      );
      const amountCents = Math.max(0, grossFee - (upfrontPayment?.amountCents ?? 0));

      return {
        type: "NO_SHOW_FEE",
        amountCents,
        idempotencyKey: `no-show:${String(booking._id)}`,
        directSet: { status: "NO_SHOW_WAIVED" },
        nextStatus: "NO_SHOW_WAIVED",
      };
    }

    if (
      booking.status === "LATE_CANCELLATION" &&
      booking.cancellationOutcome?.settlementStatus === "PENDING"
    ) {
      return {
        type: "CANCELLATION_FEE",
        amountCents: booking.cancellationOutcome.additionalChargeCents,
        idempotencyKey: `cancellation-fee:${String(booking._id)}`,
        directSet: { "cancellationOutcome.settlementStatus": "WAIVED" },
      };
    }

    return null;
  }

  private async claimAndApplyWaiver(
    businessId: Types.ObjectId,
    booking: BookingDocument,
    plan: {
      type: "NO_SHOW_FEE" | "CANCELLATION_FEE";
      amountCents: number;
      idempotencyKey: string;
      directSet: Record<string, unknown>;
      nextStatus?: BookingStatus;
    },
    event: BookingEventHistoryEntry,
    reason: string,
  ): Promise<BookingDocument> {
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;
    let duplicateKey = false;

    try {
      await dbSession.withTransaction(async () => {
        try {
          await this.financialTransactionService.record(
            {
              businessId,
              bookingId: booking._id,
              businessClientId: booking.customer.businessClientId,
              customerUserId: booking.customer.customerUserId,
              type: plan.type,
              direction: "DEBIT",
              amountCents: plan.amountCents,
              currency: booking.financials.currency,
              status: "WAIVED",
              idempotencyKey: plan.idempotencyKey,
              metadata: { reason },
            },
            dbSession,
          );
        } catch (error) {
          if (this.isDuplicateIdempotencyKeyError(error)) {
            duplicateKey = true;
            // Deliberately swallowed here — the throw below aborts the transaction (nothing
            // committed), and the actual conflict is resolved OUTSIDE it, in
            // resolveWaiverConflict, once we know nothing from this attempt persisted.
            throw error;
          }
          throw error;
        }

        updated = await this.bookingRepository.casUpdate(
          businessId,
          booking._id,
          [booking.status],
          { set: plan.directSet, pushEvent: event },
          dbSession,
        );
        if (!updated) {
          throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
        }
      });
    } catch (error) {
      if (duplicateKey) {
        return this.resolveWaiverConflict(businessId, booking, plan, event);
      }
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

  /**
   * Reached only after `claimAndApplyWaiver`'s own ledger insert lost a duplicate-`idempotencyKey`
   * race (the whole transaction aborted, so nothing from that attempt persisted) — decides the
   * outcome from whatever row actually won the claim.
   */
  private async resolveWaiverConflict(
    businessId: Types.ObjectId,
    booking: BookingDocument,
    plan: {
      type: "NO_SHOW_FEE" | "CANCELLATION_FEE";
      amountCents: number;
      idempotencyKey: string;
      directSet: Record<string, unknown>;
      nextStatus?: BookingStatus;
    },
    event: BookingEventHistoryEntry,
  ): Promise<BookingDocument> {
    const existing = await this.financialTransactionService.findByIdempotencyKey(
      plan.idempotencyKey,
    );

    if (!existing || existing.status === "PENDING") {
      throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
    }

    if (existing.status === "WAIVED") {
      // Idempotent: this exact waiver (possibly this same caller, retried after a dropped
      // response) already won. Report the Booking's current state, not an error.
      const current = await this.bookingRepository.findById(businessId, booking._id);
      if (!current) {
        throw new BookingError("BOOKING_NOT_FOUND", 404);
      }
      return current;
    }

    if (existing.status === "SUCCEEDED") {
      throw new BookingError("BOOKING_FEE_ALREADY_CHARGED", 409);
    }

    // existing.status === "FAILED": a prior charge attempt definitively failed (nothing was
    // ever collected) — the Business may still waive it now. Converts that SAME row (never a
    // second ledger entry under the same key) and applies the Booking transition atomically.
    const dbSession = await mongoose.startSession();
    let updated: BookingDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const converted = await this.financialTransactionService.settleFailedAsWaived(
          existing._id,
          dbSession,
        );
        if (!converted) {
          // Someone else converted/claimed it between our read and this write.
          throw new BookingError("BOOKING_FEE_CHARGE_IN_PROGRESS", 409);
        }

        updated = await this.bookingRepository.casUpdate(
          businessId,
          booking._id,
          [booking.status],
          { set: plan.directSet, pushEvent: event },
          dbSession,
        );
        if (!updated) {
          throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
        }
      });
    } finally {
      await dbSession.endSession();
    }

    if (!updated) {
      throw new Error("Fee waiver conflict resolution failed without throwing");
    }
    return updated;
  }

  private isDuplicateIdempotencyKeyError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "details" in error &&
      Array.isArray((error as { details?: unknown }).details) &&
      (error as { details: Array<{ code?: string }> }).details.some(
        (detail) => detail.code === "BOOKING_FINANCIAL_TRANSACTION_DUPLICATE_IDEMPOTENCY_KEY",
      )
    );
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

    const updated = await this.bookingRepository.casUpdate(business._id, booking._id, ["PENDING"], {
      set: { status: nextStatus },
      pushEvent: {
        type: "STATUS_CHANGED",
        previousStatus: "PENDING",
        nextStatus,
        actorUserId: new Types.ObjectId(actorUserId),
        actorRole: actorRole as BookingActorRole,
        createdAt: new Date(),
      },
    });

    if (!updated) {
      throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
    }

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
