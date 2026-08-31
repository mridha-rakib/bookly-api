import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import { buildCancellationEmailData } from "../email/templates/booking/cancellation-email-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { BookingNotificationUserPort } from "./booking-created.notifier.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/** Optional observer port — see `BookingLifecycleService`. */
export type BookingCancelledNotificationPort = {
  notifyBookingCancelled(
    booking: BookingDocument,
    business: BusinessDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
  ): Promise<void>;
};

/**
 * TRIGGERS 1 & 2 — after `cancelByCustomer` / `cancelByBusiness` returns its final booking
 * (status + `cancellationOutcome.settlementStatus` already settled to NOT_APPLICABLE / SUCCEEDED
 * / FAILED). Recipients: customer (booking contact snapshot) + Business Owner (User). Never
 * throws — a notification problem can't undo the cancellation.
 */
export class BookingCancelledNotifier implements BookingCancelledNotificationPort {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: Pick<BookingNotificationUserPort, "findManyByIds">,
  ) {}

  public async notifyBookingCancelled(
    booking: BookingDocument,
    business: BusinessDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
  ): Promise<void> {
    try {
      const data = buildCancellationEmailData(booking, {
        businessName: business.name,
        cancelledBy,
      });
      const eventKey = `BOOKING_CANCELLED:${String(booking._id)}`;

      const [owner] = await this.users.findManyByIds([String(business.ownerUserId)]);
      const ownerEmail = owner ? normalizeRecipient(owner.normalizedEmail) : undefined;
      const customerEmail = normalizeRecipient(booking.customer.contact.normalizedEmail);

      const plans: Array<{
        email: string;
        templateKey: "BOOKING_CANCELLED_CUSTOMER" | "BOOKING_CANCELLED_OWNER";
      }> = [];
      if (customerEmail) {
        plans.push({ email: customerEmail, templateKey: "BOOKING_CANCELLED_CUSTOMER" });
      } else {
        logger.warn(
          { bookingId: String(booking._id) },
          "Cancelled booking has no usable customer email — skipping customer cancellation email",
        );
      }
      if (ownerEmail) {
        plans.push({ email: ownerEmail, templateKey: "BOOKING_CANCELLED_OWNER" });
      } else {
        logger.warn(
          { bookingId: String(booking._id) },
          "Could not resolve Business Owner email — skipping owner cancellation email",
        );
      }

      const seen = new Set<string>();
      for (const plan of plans) {
        const key = `${plan.email}::${plan.templateKey}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        await this.emailOutbox.enqueue({
          eventKey,
          templateKey: plan.templateKey,
          recipient: plan.email,
          payload: data as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue cancellation notifications (the cancellation is unaffected)",
      );
    }
  }
}
