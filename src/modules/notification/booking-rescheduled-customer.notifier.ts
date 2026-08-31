import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import { buildBookingRescheduledEmailData } from "../email/templates/booking/booking-rescheduled-customer.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/**
 * Optional observer port on `BookingLifecycleService` — the MANDATORY customer half of the
 * reschedule notifications. Kept a separate sibling of the assigned-staff
 * `StaffBookingNotifier.notifyBookingRescheduledToStaff` (that well-tested path is untouched) and
 * of the existing `BookingCancelledNotifier`. Never throws: a notification problem can never undo
 * a committed reschedule.
 *
 * Deliberately depends on nothing but the EmailOutbox enqueue seam — no UserRepository (recipient
 * is the booking's own contact snapshot), no Business lookup (the caller passes the Business it
 * already loaded), and NO `CustomerNotificationPolicy` (a reminder opt-out must never suppress a
 * committed booking-reschedule confirmation).
 */
export type BookingRescheduledCustomerNotificationPort = {
  notifyBookingRescheduledToCustomer(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void>;
};

export class BookingRescheduledCustomerNotifier
  implements BookingRescheduledCustomerNotificationPort
{
  public constructor(private readonly emailOutbox: OutboxEnqueue) {}

  public async notifyBookingRescheduledToCustomer(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    try {
      // Authoritative previous/new appointment comes from the reschedule entry the reschedule
      // transaction just appended. Its 1-based index in the append-only history is a stable,
      // monotonic, never-reused identifier for THIS reschedule — a retry of the same logical
      // event re-derives the same key (EmailOutbox dedupe → one row); the next genuine
      // reschedule is length + 1 → its own row. No new domain field. Matches the staff
      // notifier's `BOOKING_SCHEDULE_CHANGED:<id>:<historyLength>` scheme with a distinct prefix.
      const historyLength = booking.rescheduleHistory.length;
      const entry = booking.rescheduleHistory[historyLength - 1];
      if (!entry) {
        return;
      }
      const previousStart = new Date(entry.previousStart);
      const newStart = new Date(entry.newStart);
      if (previousStart.getTime() === newStart.getTime()) {
        // Not a material date/time move — nothing to confirm to the customer.
        return;
      }

      const recipient = normalizeRecipient(booking.customer.contact.normalizedEmail);
      if (!recipient) {
        logger.warn(
          { bookingId: String(booking._id) },
          "Rescheduled booking has no usable customer email — skipping customer reschedule email",
        );
        return;
      }

      const payload = buildBookingRescheduledEmailData(booking, { businessName: business.name });
      const eventKey = `BOOKING_RESCHEDULED:${String(booking._id)}:${historyLength}`;

      await this.emailOutbox.enqueue({
        eventKey,
        templateKey: "BOOKING_RESCHEDULED_CUSTOMER",
        recipient,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue customer reschedule notification (the reschedule is unaffected)",
      );
    }
  }
}
