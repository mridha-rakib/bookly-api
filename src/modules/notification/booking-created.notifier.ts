import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { EmailTemplateKey } from "../email/template-registry.js";
import {
  type BookingEmailData,
  buildBookingEmailData,
} from "../email/templates/booking/booking-email-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

/**
 * Narrow read port over UserRepository — only the two already-existing batched lookups the
 * booking notifier needs. Passing the port (not the repo) keeps this layer testable and makes
 * the "no per-recipient query" contract explicit.
 */
export type BookingNotificationUserPort = {
  findManyByIds(ids: string[]): Promise<Array<{ _id: unknown; normalizedEmail: string }>>;
  findProfilesByUserIds(
    ids: string[],
  ): Promise<Array<{ userId: unknown; firstName: string; lastName: string }>>;
};

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

type PlannedEmail = {
  email: string;
  templateKey: EmailTemplateKey;
  payload: Record<string, unknown>;
};

/**
 * TRIGGERS 2, 3, 4 — enqueues booking-creation notifications after a Booking is committed.
 * Called from BookingCreationService's post-commit tail (right after the Google Calendar sync),
 * exactly like that best-effort side effect: it never throws, so a notification problem can
 * never roll back a real booking.
 *
 * Recipients by `booking.createdBy.actorRole` (all addresses come from persisted data):
 *   CUSTOMER      -> customer (booking.customer.contact snapshot) + Business Owner (User)
 *   BUSINESS_OWNER-> client (snapshot) + acting Owner == Business Owner (one business-side mail)
 *   SUPERVISOR    -> client (snapshot) + acting Supervisor (User) + Business Owner (User)
 */
export class BookingCreatedNotifier {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: BookingNotificationUserPort,
  ) {}

  public async notifyBookingCreated(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<void> {
    try {
      const actorRole = booking.createdBy.actorRole;
      const ownerUserId = String(business.ownerUserId);
      const actorUserId = String(booking.createdBy.actorUserId);

      // One batched user lookup for every business-side recipient this event needs.
      const idsToResolve = actorRole === "SUPERVISOR" ? [ownerUserId, actorUserId] : [ownerUserId];
      const users = await this.users.findManyByIds(idsToResolve);
      const emailByUserId = new Map(users.map((u) => [String(u._id), u.normalizedEmail]));

      const ownerEmail = emailByUserId.get(ownerUserId);
      const clientEmail = booking.customer.contact.normalizedEmail;

      const eventKey = `BOOKING_CREATED:${String(booking._id)}`;
      const plans: PlannedEmail[] = [];

      if (actorRole === "CUSTOMER") {
        const data = buildBookingEmailData(booking, {
          businessName: business.name,
          includeCustomerBookingLink: true,
        });
        plans.push({
          email: clientEmail,
          templateKey: "BOOKING_CUSTOMER_CONFIRMED",
          payload: toRecord(data),
        });
        if (ownerEmail) {
          plans.push({
            email: ownerEmail,
            templateKey: "BOOKING_OWNER_NEW_BOOKING",
            payload: toRecord(
              buildBookingEmailData(booking, {
                businessName: business.name,
                includeCustomerBookingLink: false,
              }),
            ),
          });
        } else {
          this.warnUnresolved(booking, "BUSINESS_OWNER");
        }
      } else {
        // Business Owner or Supervisor created the booking FOR the client.
        const clientData = buildBookingEmailData(booking, {
          businessName: business.name,
          includeCustomerBookingLink: true,
        });
        plans.push({
          email: clientEmail,
          templateKey: "BOOKING_FOR_CLIENT_CONFIRMED",
          payload: toRecord(clientData),
        });

        const businessSideData = buildBookingEmailData(booking, {
          businessName: business.name,
          includeCustomerBookingLink: false,
        });

        if (actorRole === "SUPERVISOR") {
          const actorEmail = emailByUserId.get(actorUserId);
          const [profile] = await this.users.findProfilesByUserIds([actorUserId]);
          const supervisorName = profile
            ? [profile.firstName, profile.lastName].filter(Boolean).join(" ")
            : "A supervisor";

          if (ownerEmail) {
            plans.push({
              email: ownerEmail,
              templateKey: "BOOKING_STAFF_CREATED_NOTIFICATION",
              payload: toRecord({
                ...businessSideData,
                createdByLabel: `${supervisorName} created a booking`,
              }),
            });
          } else {
            this.warnUnresolved(booking, "BUSINESS_OWNER");
          }

          if (actorEmail) {
            plans.push({
              email: actorEmail,
              templateKey: "BOOKING_STAFF_CREATED_NOTIFICATION",
              payload: toRecord({ ...businessSideData, createdByLabel: "You created a booking" }),
            });
          } else {
            // STOP-condition #4 at runtime: the acting Supervisor's email could not be resolved
            // from the User model. Skip only that recipient; everything else is unaffected.
            this.warnUnresolved(booking, "SUPERVISOR");
          }
        } else if (ownerEmail) {
          // BUSINESS_OWNER created it — acting owner IS the canonical Business Owner.
          plans.push({
            email: ownerEmail,
            templateKey: "BOOKING_STAFF_CREATED_NOTIFICATION",
            payload: toRecord({ ...businessSideData, createdByLabel: "You created a booking" }),
          });
        } else {
          this.warnUnresolved(booking, "BUSINESS_OWNER");
        }
      }

      // Dedupe by (normalized email + templateKey): the same address must not get the same
      // semantic notification twice (e.g. acting Owner and canonical Owner resolving equal).
      // The Stage-A DB dedupeKey is the final backstop.
      const deduped = new Map<string, PlannedEmail>();
      for (const plan of plans) {
        const email = normalizeRecipient(plan.email);
        if (!email) {
          continue;
        }
        const key = `${email}::${plan.templateKey}`;
        if (!deduped.has(key)) {
          deduped.set(key, { ...plan, email });
        }
      }

      for (const plan of deduped.values()) {
        await this.emailOutbox.enqueue({
          eventKey,
          templateKey: plan.templateKey,
          recipient: plan.email,
          payload: plan.payload,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue booking-created notifications (the booking is unaffected)",
      );
    }
  }

  private warnUnresolved(booking: BookingDocument, role: string): void {
    logger.warn(
      { bookingId: String(booking._id), unresolvedRecipientRole: role },
      "Booking-created notification: could not resolve a recipient email from persisted data — skipped that recipient only",
    );
  }
}

const toRecord = (data: BookingEmailData | (BookingEmailData & { createdByLabel: string })) =>
  data as unknown as Record<string, unknown>;
