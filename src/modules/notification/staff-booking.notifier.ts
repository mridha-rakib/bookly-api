import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import {
  formatDateInTimezone,
  formatTimeInTimezone,
} from "../email/templates/components/email-format.js";
import type { StaffBookingCancelledPayload } from "../email/templates/staff/staff-booking-cancelled.template.js";
import type { StaffBookingScheduleChangedPayload } from "../email/templates/staff/staff-booking-schedule-changed.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import {
  type AssignedStaffRecipient,
  resolveAssignedStaffRecipients,
  type StaffMembershipLookupPort,
  type StaffRecipientUserPort,
} from "./staff-booking-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/**
 * Optional observer port on `BookingLifecycleService` — the assigned-staff half of the booking
 * cancellation / reschedule notifications. Kept separate from the existing customer/owner
 * `BookingCancelledNotifier` so that well-tested path is untouched. Never throws: a notification
 * problem can never undo a cancelled or rescheduled booking.
 */
export type StaffBookingNotificationPort = {
  notifyBookingCancelledToStaff(
    booking: BookingDocument,
    businessName: string,
    cancelledBy: "CUSTOMER" | "BUSINESS",
  ): Promise<void>;
  notifyBookingRescheduledToStaff(booking: BookingDocument, businessName: string): Promise<void>;
};

const customerDisplayName = (booking: BookingDocument): string =>
  [booking.customer.contact.firstName, booking.customer.contact.lastName].filter(Boolean).join(" ");

export class StaffBookingNotifier implements StaffBookingNotificationPort {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly staff: StaffMembershipLookupPort,
    private readonly users: StaffRecipientUserPort,
  ) {}

  public async notifyBookingCancelledToStaff(
    booking: BookingDocument,
    businessName: string,
    cancelledBy: "CUSTOMER" | "BUSINESS",
  ): Promise<void> {
    try {
      const recipients = await this.resolveRecipients(booking);
      if (recipients.length === 0) {
        return;
      }

      const tz = booking.schedule.timezone;
      const eventKey = `BOOKING_CANCELLED:${String(booking._id)}`;

      for (const recipient of recipients) {
        const payload: StaffBookingCancelledPayload = {
          staffFirstName: recipient.firstName,
          bookingReference: booking.reference,
          businessName,
          customerName: customerDisplayName(booking),
          appointmentDate: formatDateInTimezone(booking.schedule.startAt, tz),
          appointmentTime: formatTimeInTimezone(booking.schedule.startAt, tz),
          services: recipient.services,
          cancelledBy,
        };
        await this.emailOutbox.enqueue({
          eventKey,
          templateKey: "STAFF_BOOKING_CANCELLED",
          recipient: recipient.email,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue staff booking-cancelled notifications (the cancellation is unaffected)",
      );
    }
  }

  public async notifyBookingRescheduledToStaff(
    booking: BookingDocument,
    businessName: string,
  ): Promise<void> {
    try {
      // Authoritative previous/new appointment comes from the reschedule entry the reschedule
      // transaction just appended. Its 1-based index in the persisted history is a stable,
      // monotonic, never-reused identifier for THIS reschedule — no new domain field.
      const historyLength = booking.rescheduleHistory.length;
      const entry = booking.rescheduleHistory[historyLength - 1];
      if (!entry) {
        return;
      }
      const previousStart = new Date(entry.previousStart);
      const newStart = new Date(entry.newStart);
      if (previousStart.getTime() === newStart.getTime()) {
        // Not a material date/time move — nothing to tell staff about.
        return;
      }

      const recipients = await this.resolveRecipients(booking);
      if (recipients.length === 0) {
        return;
      }

      const tz = booking.schedule.timezone;
      const eventKey = `BOOKING_SCHEDULE_CHANGED:${String(booking._id)}:${historyLength}`;

      for (const recipient of recipients) {
        const payload: StaffBookingScheduleChangedPayload = {
          staffFirstName: recipient.firstName,
          bookingReference: booking.reference,
          businessName,
          customerName: customerDisplayName(booking),
          previousDate: formatDateInTimezone(previousStart, tz),
          previousTime: formatTimeInTimezone(previousStart, tz),
          newDate: formatDateInTimezone(newStart, tz),
          newTime: formatTimeInTimezone(newStart, tz),
          services: recipient.services,
        };
        await this.emailOutbox.enqueue({
          eventKey,
          templateKey: "STAFF_BOOKING_SCHEDULE_CHANGED",
          recipient: recipient.email,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue staff booking-reschedule notifications (the reschedule is unaffected)",
      );
    }
  }

  private async resolveRecipients(booking: BookingDocument): Promise<AssignedStaffRecipient[]> {
    const recipients = await resolveAssignedStaffRecipients(booking, this.staff, this.users);
    const assignedMembershipCount = new Set(
      booking.serviceLines.map((line) => String(line.responsibleStaffMembershipId)),
    ).size;
    if (recipients.length < assignedMembershipCount) {
      logger.warn(
        { bookingId: String(booking._id) },
        "Some assigned staff had no resolvable email — those recipients were skipped",
      );
    }
    return recipients;
  }
}
