import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { AppointmentReminderRepository } from "./appointment-reminder.repository.js";
import {
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

const KIND: AppointmentReminderKind = "REMINDER_24H";

/**
 * Orchestrates the {@link AppointmentReminderRepository}: turns booking lifecycle events into
 * reminder-row scheduling / retirement. Holds no delivery knowledge — the reminder worker does
 * the actual "is this due, is it still eligible, what does the customer want, enqueue the email"
 * work later.
 *
 * A reminder is scheduled ONLY for a booking that is for a linked Customer account
 * (`customer.customerUserId` present) and currently `UPCOMING`: those are the only bookings with
 * a stored notification preference and a resolvable current email.
 */
export class AppointmentReminderScheduler implements AppointmentReminderSchedulingPort {
  public constructor(private readonly repository: AppointmentReminderRepository) {}

  public async onBookingCreated(booking: BookingDocument): Promise<void> {
    await this.safely("schedule (created)", booking, () => this.ensureScheduled(booking));
  }

  public async onBookingRescheduled(booking: BookingDocument): Promise<void> {
    await this.safely("schedule (rescheduled)", booking, async () => {
      const currentDedupeKey = buildAppointmentReminderDedupeKey(
        KIND,
        String(booking._id),
        booking.schedule.startAt,
      );
      const retired = await this.repository.retireActiveForBooking(
        booking._id,
        "SUPERSEDED_BY_RESCHEDULE",
        { now: new Date(), exceptDedupeKey: currentDedupeKey },
      );
      const result = await this.ensureScheduled(booking);
      logger.info(
        {
          bookingId: String(booking._id),
          retired,
          scheduled: result === "scheduled",
          reminderStatus: result,
        },
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
  ): Promise<"scheduled" | "skipped_inside_window" | "not_eligible"> {
    const customerUserId = booking.customer.customerUserId;
    if (!customerUserId || booking.status !== "UPCOMING") {
      return "not_eligible";
    }

    const { created, record } = await this.repository.schedule({
      kind: KIND,
      bookingId: booking._id,
      businessId: booking.businessId,
      customerUserId,
      scheduleStartAt: booking.schedule.startAt,
      now: new Date(),
    });

    const outcome = record.status === "SKIPPED" ? "skipped_inside_window" : "scheduled";
    if (created) {
      logger.info(
        {
          bookingId: String(booking._id),
          dueAt: record.dueAt.toISOString(),
          reminderStatus: record.status,
        },
        outcome === "skipped_inside_window"
          ? "Appointment reminder skipped — booking is inside the 24h window"
          : "Appointment reminder scheduled",
      );
    }
    return outcome;
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
