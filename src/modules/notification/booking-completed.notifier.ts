import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BookingCompletedEmailPayload } from "../email/templates/booking/booking-completed.template.js";
import { buildInvoiceData } from "../email/templates/invoice/invoice-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/** Optional observer port for Stage C — see `BookingLifecycleService`. */
export type BookingCompletedNotificationPort = {
  notifyBookingCompleted(booking: BookingDocument, business: BusinessDocument): Promise<void>;
};

const formatBusinessAddress = (business: BusinessDocument): string | undefined => {
  const a = business.address;
  if (!a) {
    return undefined;
  }
  const street = [a.streetNumber, a.streetName].filter(Boolean).join(" ");
  return [street, a.area, a.city].filter(Boolean).join(", ") || undefined;
};

/**
 * TRIGGER 5 — after `completeBooking` commits, enqueues ONE `BOOKING_COMPLETED` email to the
 * customer (the booking's own contact snapshot). Builds the shared {@link buildInvoiceData}
 * payload; the worker renders the body and the attached PDF from that same object. Best-effort:
 * a failure here is logged and swallowed, never rolling back the completed booking.
 */
export class BookingCompletedNotifier implements BookingCompletedNotificationPort {
  public constructor(private readonly emailOutbox: OutboxEnqueue) {}

  public async notifyBookingCompleted(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    try {
      const recipient = normalizeRecipient(booking.customer.contact.normalizedEmail);
      if (!recipient) {
        logger.warn(
          { bookingId: String(booking._id) },
          "Completed booking has no usable customer email — skipping BOOKING_COMPLETED notification",
        );
        return;
      }

      const businessAddress = formatBusinessAddress(business);
      const invoice = buildInvoiceData(booking, {
        businessName: business.name,
        ...(business.phone?.e164 ? { businessPhone: business.phone.e164 } : {}),
        ...(businessAddress ? { businessAddress } : {}),
      });

      const payload: BookingCompletedEmailPayload = {
        invoice,
        ...(booking.customer.customerUserId
          ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
          : {}),
      };

      await this.emailOutbox.enqueue({
        eventKey: `BOOKING_COMPLETED:${String(booking._id)}`,
        templateKey: "BOOKING_COMPLETED",
        recipient,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue BOOKING_COMPLETED notification (the completed booking is unaffected)",
      );
    }
  }
}
