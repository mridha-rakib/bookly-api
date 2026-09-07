import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import { buildCancellationEmailData } from "../email/templates/booking/cancellation-email-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { BookingNotificationUserPort } from "./booking-created.notifier.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/** The real, authoritative outcome of a refund the caller just executed — see
 * cancellation-email-data.ts's own module doc comment for why this must never be re-derived
 * from the booking's own persisted `cancellationOutcome`. */
export type BookingRefundOutcome = { succeeded: boolean; amountCents: number };

/** Optional observer port — see `BookingLifecycleService`. */
export type BookingCancelledNotificationPort = {
  notifyBookingCancelled(
    booking: BookingDocument,
    business: BusinessDocument,
    cancelledBy: "CUSTOMER" | "BUSINESS",
    refundOutcome?: BookingRefundOutcome,
    /** See this class's own doc comment — leave unset unless a SECOND, genuinely distinct
     * notification for the SAME booking must coexist with an already-enqueued plain
     * "BOOKING_CANCELLED" one. */
    eventKeyOverride?: string,
  ): Promise<void>;
};

/**
 * TRIGGERS 1 & 2 — after `cancelByCustomer` / `cancelByBusiness` returns its final booking
 * (status + `cancellationOutcome.settlementStatus` already settled to NOT_APPLICABLE / SUCCEEDED
 * / FAILED). Recipients: customer (booking contact snapshot) + Business Owner (User). Never
 * throws — a notification problem can't undo the cancellation.
 *
 * `refundOutcome` (Phase 4B close-out fix): when the caller has just executed a real refund and
 * wants that exact, authoritative, just-happened result reflected in the email (rather than
 * whatever the booking's own persisted `cancellationOutcome` says — see
 * cancellation-email-data.ts's own module doc comment for why that field can be stale or simply
 * describe a different event), it is passed here and forwarded into
 * buildCancellationEmailData's own `refundOverride`. `cancelByBusiness` passes this today; the
 * eventKey/dedupe behavior below is UNCHANGED for it (still `BOOKING_CANCELLED:${bookingId}`,
 * exactly as before this fix) since it is the only notification ever dispatched for that
 * booking's cancellation.
 *
 * `eventKeyOverride` exists ONLY for a caller that must dispatch a SECOND, genuinely distinct
 * notification about the SAME booking that an earlier, separate call in the same flow may
 * already have dispatched under the default `BOOKING_CANCELLED:` key — e.g.
 * BookingLifecycleService.voidUnusedPackage, whose own internal `cancelByCustomer` call may
 * already have enqueued a plain "booking cancelled" email for the origin booking before the
 * Package's refund is even attempted. Reusing the default key there would collide with — and
 * therefore be silently dropped by — the outbox's own (eventKey, templateKey, recipient) dedupe,
 * meaning the refund amount would never actually reach the customer. Passing a distinct key
 * (e.g. `PACKAGE_REFUND:${bookingId}`) is the smallest way to let both real, distinct emails
 * coexist — reusing the exact same customer/owner templates, never a new notification system.
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
    refundOutcome?: BookingRefundOutcome,
    eventKeyOverride?: string,
  ): Promise<void> {
    try {
      const data = buildCancellationEmailData(booking, {
        businessName: business.name,
        cancelledBy,
        ...(refundOutcome
          ? {
              refundOverride: {
                succeeded: refundOutcome.succeeded,
                amountCents: refundOutcome.amountCents,
              },
            }
          : {}),
      });
      const eventKey = eventKeyOverride ?? `BOOKING_CANCELLED:${String(booking._id)}`;

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
