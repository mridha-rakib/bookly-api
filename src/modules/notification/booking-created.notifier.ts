import type { ClientSession } from "mongoose";

import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { EmailTemplateKey } from "../email/template-registry.js";
import {
  type BookingEmailData,
  type BookingEmailOnlinePayment,
  buildBookingEmailData,
  formatDateTimeWithZone,
} from "../email/templates/booking/booking-email-data.js";
import { formatMoney } from "../email/templates/components/email-format.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";
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

type UserLookups = {
  users: Array<{ _id: unknown; normalizedEmail: string }>;
  supervisorProfile: { firstName: string; lastName: string } | undefined;
};

/**
 * F4A Tier 3 — the payment facts the Booking transaction actually holds.
 *  - NONE: no PaymentIntent was created for this Booking (zero online charge / MANUAL).
 *  - CHARGED: the SUCCEEDED ledger row written in this transaction + the PaymentAttempt whose
 *    provider result was recorded SUCCEEDED before persistence began.
 */
export type BookingCreatedPaymentEvidence =
  | { kind: "NONE" }
  | {
      kind: "CHARGED";
      paymentFor: "BOOKING" | "PACKAGE_PURCHASE" | "PACKAGE_SESSION_EXTRAS";
      ledger:
        | Pick<
            BookingFinancialTransactionDocument,
            "amountCents" | "currency" | "status" | "direction" | "providerReference"
          >
        | null
        | undefined;
      attempt:
        | Pick<
            PaymentAttemptDocument,
            | "providerStatus"
            | "providerPaymentIntentId"
            | "providerSucceededAt"
            | "expectedAmountCents"
            | "currency"
          >
        | null
        | undefined;
    };

/**
 * Shown as PAID only when the ledger row and the PaymentAttempt independently agree on a
 * captured payment (charges use automatic capture; persistence starts only after provider
 * `succeeded`). Anything less is UNVERIFIED and never rendered as paid.
 */
export const toOnlinePayment = (
  evidence: BookingCreatedPaymentEvidence | undefined,
  timezone: string,
): BookingEmailOnlinePayment | undefined => {
  if (!evidence) return undefined;
  if (evidence.kind === "NONE") return { kind: "NONE" };
  const { ledger, attempt } = evidence;
  const reference = attempt?.providerPaymentIntentId;
  const verified =
    ledger?.status === "SUCCEEDED" &&
    ledger.direction === "DEBIT" &&
    attempt?.providerStatus === "SUCCEEDED" &&
    attempt.providerSucceededAt instanceof Date &&
    Boolean(reference) &&
    ledger.providerReference === reference &&
    ledger.amountCents === attempt.expectedAmountCents &&
    ledger.currency === attempt.currency.toUpperCase();
  if (!verified || !ledger || !attempt?.providerSucceededAt || !reference)
    return { kind: "UNVERIFIED" };
  return {
    kind: "PAID",
    amountFormatted: formatMoney(ledger.amountCents, ledger.currency),
    paidAt: formatDateTimeWithZone(attempt.providerSucceededAt, timezone),
    paymentReference: reference,
    paymentFor: evidence.paymentFor,
  };
};

/**
 * TRIGGERS 2, 3, 4 — booking-creation notifications.
 *
 * F4A Tier 2: BookingCreationService calls {@link enqueueBookingCreatedInTransaction} inside the
 * Booking transaction, so the outbox rows commit if and only if the Booking commits.
 * {@link notifyBookingCreated} is the legacy best-effort entry point (never throws); it has no
 * production caller after Tier 2 and keeps its original behavior.
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
      const plans = this.plan(booking, business, await this.lookUpUsers(booking, business));
      await this.enqueueAll(booking, plans);
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to enqueue booking-created notifications (the booking is unaffected)",
      );
    }
  }

  /**
   * Writes the booking-created outbox rows with the caller's Booking transaction `session`.
   *
   * - An outbox INSERT failure throws, so the caller's transaction aborts (Owner decision O1);
   *   the caller's existing abort/compensation handling applies unchanged.
   * - A User lookup failure does NOT abort: only the business-side recipients are skipped
   *   (the customer/client address comes from the Booking snapshot and needs no lookup).
   * - F4A Tier 3: a payload-building failure THROWS (aborts). Building is a pure function of
   *   the Booking being committed, so a failure is a defect; swallowing it let a committed
   *   Booking end up with no confirmation intent at all, contrary to O1.
   * - `payment` (Tier 3) adds only VERIFIED payment facts (see toOnlinePayment); omitted, the
   *   payload is exactly the Tier 2 one.
   */
  public async enqueueBookingCreatedInTransaction(
    booking: BookingDocument,
    business: BusinessDocument,
    session: ClientSession,
    payment?: BookingCreatedPaymentEvidence,
  ): Promise<void> {
    let lookups: UserLookups;
    try {
      lookups = await this.lookUpUsers(booking, business);
    } catch {
      logger.warn(
        { event: "BOOKING_CREATED_EMAIL_LOOKUP_FAILED", bookingId: String(booking._id) },
        "Booking-created notification: user lookup failed — business-side recipients skipped",
      );
      lookups = { users: [], supervisorProfile: undefined };
    }
    const onlinePayment = toOnlinePayment(payment, booking.schedule.timezone);
    if (onlinePayment?.kind === "UNVERIFIED")
      logger.warn(
        { event: "BOOKING_CREATED_PAYMENT_UNVERIFIED", bookingId: String(booking._id) },
        "Booking-created notification: payment evidence incomplete — not shown as paid",
      );
    // No catch: a build failure aborts the transaction instead of silently writing no rows.
    const plans = this.plan(booking, business, lookups, onlinePayment);
    await this.enqueueAll(booking, plans, session);
  }

  private async lookUpUsers(
    booking: BookingDocument,
    business: BusinessDocument,
  ): Promise<UserLookups> {
    const actorRole = booking.createdBy.actorRole;
    const ownerUserId = String(business.ownerUserId);
    const actorUserId = String(booking.createdBy.actorUserId);
    // One batched user lookup for every business-side recipient this event needs.
    const idsToResolve = actorRole === "SUPERVISOR" ? [ownerUserId, actorUserId] : [ownerUserId];
    const users = await this.users.findManyByIds(idsToResolve);
    const supervisorProfile =
      actorRole === "SUPERVISOR"
        ? (await this.users.findProfilesByUserIds([actorUserId]))[0]
        : undefined;
    return { users, supervisorProfile };
  }

  private plan(
    booking: BookingDocument,
    business: BusinessDocument,
    lookups: UserLookups,
    onlinePayment?: BookingEmailOnlinePayment,
  ): PlannedEmail[] {
    const actorRole = booking.createdBy.actorRole;
    const ownerUserId = String(business.ownerUserId);
    const actorUserId = String(booking.createdBy.actorUserId);
    const emailByUserId = new Map(lookups.users.map((u) => [String(u._id), u.normalizedEmail]));

    const ownerEmail = emailByUserId.get(ownerUserId);
    const clientEmail = booking.customer.contact.normalizedEmail;
    const plans: PlannedEmail[] = [];

    if (actorRole === "CUSTOMER") {
      const data = buildBookingEmailData(booking, {
        businessName: business.name,
        onlinePayment,
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
              onlinePayment,
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
        onlinePayment,
        includeCustomerBookingLink: true,
      });
      plans.push({
        email: clientEmail,
        templateKey: "BOOKING_FOR_CLIENT_CONFIRMED",
        payload: toRecord(clientData),
      });

      const businessSideData = buildBookingEmailData(booking, {
        businessName: business.name,
        onlinePayment,
        includeCustomerBookingLink: false,
      });

      if (actorRole === "SUPERVISOR") {
        const actorEmail = emailByUserId.get(actorUserId);
        const profile = lookups.supervisorProfile;
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
    return [...deduped.values()];
  }

  private async enqueueAll(
    booking: BookingDocument,
    plans: PlannedEmail[],
    session?: ClientSession,
  ): Promise<void> {
    const eventKey = `BOOKING_CREATED:${String(booking._id)}`;
    for (const plan of plans) {
      const input = {
        eventKey,
        templateKey: plan.templateKey,
        recipient: plan.email,
        payload: plan.payload,
      };
      // The legacy path keeps its exact one-argument call.
      if (session) await this.emailOutbox.enqueue(input, session);
      else await this.emailOutbox.enqueue(input);
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
