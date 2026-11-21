import type { ClientSession } from "mongoose";
import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import { buildBookingRescheduledOwnerEmailData } from "../email/templates/booking/booking-rescheduled-owner.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { UserRepository } from "../user/user.repository.js";
import type { BookingRescheduledCustomerNotificationPort } from "./booking-rescheduled-customer.notifier.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/**
 * Fix #7 — the Business Owner's transactional email for a committed CUSTOMER-initiated
 * reschedule (`BOOKING_RESCHEDULED_OWNER`). Kept separate from the customer notifier, which by
 * design depends on nothing but the outbox (its recipient is the booking's own contact
 * snapshot); this one must resolve the CURRENT Owner from `Business.ownerUserId`, exactly like
 * the booking-created Owner email. Not preference-gated.
 *
 * Runs inside the reschedule transaction: the intent commits or rolls back with the schedule
 * change. Identity is the committed reschedule-history index, the same scheme as the customer
 * and staff intents, so re-dispatching a committed event dedupes in the outbox and the next
 * genuine reschedule gets its own row.
 */
export class BookingRescheduledOwnerNotifier {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: Pick<UserRepository, "findManyByIds">,
  ) {}

  public async enqueueInTransaction(
    booking: BookingDocument,
    business: BusinessDocument,
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction())
      throw new Error("Owner reschedule intent requires the Booking transaction");
    const entry = booking.rescheduleHistory.at(-1);
    // Only a real, CUSTOMER-made schedule move; Owner/Supervisor moves never notify the Owner.
    if (!entry || entry.actorRole !== "CUSTOMER") return;
    if (entry.previousStart.getTime() === entry.newStart.getTime()) return;

    const [owner] = await this.users.findManyByIds([String(business.ownerUserId)]);
    const recipient = owner ? normalizeRecipient(owner.normalizedEmail) : "";
    if (!recipient.includes("@")) {
      // Same policy as the booking-created Owner email: never fabricate a recipient.
      logger.warn(
        { bookingId: String(booking._id), businessId: String(business._id) },
        "Business Owner has no usable email — skipping BOOKING_RESCHEDULED_OWNER",
      );
      return;
    }
    await this.emailOutbox.enqueue(
      {
        eventKey: `BOOKING_RESCHEDULED_OWNER:${String(booking._id)}:${booking.rescheduleHistory.length}`,
        templateKey: "BOOKING_RESCHEDULED_OWNER",
        recipient,
        payload: buildBookingRescheduledOwnerEmailData(booking, {
          businessName: business.name,
        }) as unknown as Record<string, unknown>,
      },
      session,
    );
  }
}

/**
 * Production composition for `BookingLifecycleService`'s existing reschedule-notification port:
 * the unchanged customer confirmation first, then the Owner email — both inside the same
 * transaction. The legacy post-commit customer path is delegated unchanged.
 */
export class BookingRescheduledNotifications implements BookingRescheduledCustomerNotificationPort {
  public constructor(
    private readonly customer: Required<BookingRescheduledCustomerNotificationPort>,
    private readonly owner: Pick<BookingRescheduledOwnerNotifier, "enqueueInTransaction">,
  ) {}

  public async enqueueBookingRescheduledInTransaction(
    booking: BookingDocument,
    business: BusinessDocument,
    session: ClientSession,
  ): Promise<void> {
    await this.customer.enqueueBookingRescheduledInTransaction(booking, business, session);
    await this.owner.enqueueInTransaction(booking, business, session);
  }

  public notifyBookingRescheduledToCustomer(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    return this.customer.notifyBookingRescheduledToCustomer(booking, business);
  }
}
