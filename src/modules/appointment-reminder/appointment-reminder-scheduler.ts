import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { AppointmentReminderRepository } from "./appointment-reminder.repository.js";
import {
  APPOINTMENT_REMINDER_OFFSET_MINUTES,
  type AppointmentReminderKind,
  buildAppointmentReminderDedupeKey,
} from "./appointment-reminder.types.js";

/**
 * The observer port the booking services depend on (never the concrete scheduler) — same
 * optional-trailing, best-effort, never-throws discipline as the mailing notifiers and the
 * Google Calendar sync. A reminder-scheduling problem can never roll back a committed booking,
 * reschedule or cancellation.
 */
export type AppointmentReminderSchedulingPort = {
  /** Post-commit tail of booking creation — ensure the 24h reminder exists (or is recorded as
   * skipped when the booking is already inside the 24h window). */
  onBookingCreated(booking: BookingDocument): Promise<void>;
  /** Post-commit tail of a reschedule — retire the reminder for the old schedule version and
   * schedule one for the new `schedule.startAt`. */
  onBookingRescheduled(booking: BookingDocument): Promise<void>;
  /** Post-commit tail of any transition OUT of UPCOMING (cancel / complete / mark no-show) —
   * retire every still-pending reminder for this booking. */
  onBookingRetired(booking: BookingDocument, reasonCategory: string): Promise<void>;
};

type ReminderPlan = {
  kind: AppointmentReminderKind;
  anchorAt(booking: BookingDocument): Date;
  /** `undefined` = this kind does not apply to this booking at all (nothing is scheduled, and
   * nothing needs to be retired for it either — see `onBookingRescheduled`'s except-list). */
  offsetMinutes(booking: BookingDocument): number | undefined;
};

/**
 * Every reminder kind a booking may get, in a single declarative list — adding a future kind
 * (e.g. `"REMINDER_1H"`) means adding one entry here, never a second scheduler class/subsystem.
 */
const PLANS: ReminderPlan[] = [
  {
    kind: "REMINDER_24H",
    anchorAt: (booking) => booking.schedule.startAt,
    offsetMinutes: () => APPOINTMENT_REMINDER_OFFSET_MINUTES.REMINDER_24H,
  },
  {
    kind: "SESSION_END_REMINDER",
    anchorAt: (booking) => booking.schedule.endAt,
    // The Service.sessionExpiryAlert snapshot taken at Booking-creation time (see
    // booking.model.ts's own doc comment) — NEVER the live Service setting, and NEVER inferred
    // for a legacy booking with no snapshot at all.
    offsetMinutes: (booking) => {
      const snapshot = booking.sessionEndReminderSnapshot;
      if (!snapshot?.enabled) return undefined;
      const minutes = snapshot.minutesBeforeSessionEnds;
      return typeof minutes === "number" && minutes > 0 ? minutes : undefined;
    },
  },
];

type PlanOutcome = "scheduled" | "skipped_inside_window" | "not_eligible";

/**
 * Orchestrates the {@link AppointmentReminderRepository}: turns booking lifecycle events into
 * reminder-row scheduling / retirement, for every {@link PLANS} entry that applies to the
 * booking. Holds no delivery knowledge — the reminder worker does the actual "is this due, is it
 * still eligible, what does the customer want, enqueue the email" work later.
 *
 * A reminder is scheduled ONLY for a booking that is for a linked Customer account
 * (`customer.customerUserId` present) and currently `UPCOMING`: those are the only bookings with
 * a resolvable current email (and, for `REMINDER_24H`, a stored notification preference).
 */
export class AppointmentReminderScheduler implements AppointmentReminderSchedulingPort {
  public constructor(private readonly repository: AppointmentReminderRepository) {}

  public async onBookingCreated(booking: BookingDocument): Promise<void> {
    await this.safely("schedule (created)", booking, () => this.ensureScheduled(booking));
  }

  public async onBookingRescheduled(booking: BookingDocument): Promise<void> {
    await this.safely("schedule (rescheduled)", booking, async () => {
      const currentDedupeKeys = PLANS.map((plan) =>
        buildAppointmentReminderDedupeKey(plan.kind, String(booking._id), plan.anchorAt(booking)),
      );
      const retired = await this.repository.retireActiveForBooking(
        booking._id,
        "SUPERSEDED_BY_RESCHEDULE",
        {
          now: new Date(),
          // `exceptDedupeKey` (singular) kept for backward compatibility with callers/tests that
          // only know one identity; `exceptDedupeKeys` covers every plan.
          exceptDedupeKey: currentDedupeKeys[0],
          exceptDedupeKeys: currentDedupeKeys,
        },
      );
      const results = await this.ensureScheduled(booking);
      logger.info(
        { bookingId: String(booking._id), retired, results },
        "Appointment reminder rescheduled",
      );
    });
  }

  public async onBookingRetired(booking: BookingDocument, reasonCategory: string): Promise<void> {
    await this.safely("retire", booking, async () => {
      const retired = await this.repository.retireActiveForBooking(booking._id, reasonCategory, {
        now: new Date(),
      });
      if (retired > 0) {
        logger.info(
          { bookingId: String(booking._id), retired, reasonCategory },
          "Appointment reminder retired",
        );
      }
    });
  }

  private async ensureScheduled(
    booking: BookingDocument,
  ): Promise<Record<AppointmentReminderKind, PlanOutcome>> {
    const results = {} as Record<AppointmentReminderKind, PlanOutcome>;
    const customerUserId = booking.customer.customerUserId;
    if (!customerUserId || booking.status !== "UPCOMING") {
      for (const plan of PLANS) results[plan.kind] = "not_eligible";
      return results;
    }

    for (const plan of PLANS) {
      const offsetMinutes = plan.offsetMinutes(booking);
      if (offsetMinutes === undefined) {
        results[plan.kind] = "not_eligible";
        continue;
      }

      const { created, record } = await this.repository.schedule({
        kind: plan.kind,
        bookingId: booking._id,
        businessId: booking.businessId,
        customerUserId,
        scheduleStartAt: plan.anchorAt(booking),
        offsetMinutes,
        now: new Date(),
      });

      const outcome = record.status === "SKIPPED" ? "skipped_inside_window" : "scheduled";
      results[plan.kind] = outcome;
      if (created) {
        logger.info(
          {
            bookingId: String(booking._id),
            kind: plan.kind,
            dueAt: record.dueAt.toISOString(),
            reminderStatus: record.status,
          },
          outcome === "skipped_inside_window"
            ? "Appointment reminder skipped — booking is inside the offset window"
            : "Appointment reminder scheduled",
        );
      }
    }
    return results;
  }

  private async safely(
    action: string,
    booking: BookingDocument,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id), action },
        "Appointment reminder scheduling failed (the booking is unaffected)",
      );
    }
  }
}
