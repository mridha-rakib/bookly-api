import type { ClientSession } from "mongoose";
import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessDocument } from "../business/business.model.js";
import {
  buildPenaltySettlementEmailData,
  type PenaltySettlementKind,
  type PenaltySettlementOutcome,
} from "../email/templates/booking/penalty-settlement-email-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { BookingNotificationUserPort } from "./booking-created.notifier.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

export type PenaltySettlementNotificationPort = {
  notifyPenaltySettlement(
    booking: BookingDocument,
    business: BusinessDocument,
    settlement: {
      kind: PenaltySettlementKind;
      outcome: PenaltySettlementOutcome;
      amountCents: number;
      /** The obligation's own canonical ledger key — the follow-up's dedupe identity. */
      obligationKey: string;
    },
    session?: ClientSession,
  ): Promise<void>;
};

/**
 * P5 — the truthful penalty settlement follow-up, enqueued on the existing outbox in the SAME
 * transaction that settles the obligation (exactly once per obligation outcome: the eventKey is
 * derived from the obligation's canonical key). Customer always; the Business Owner for a
 * collected or failed fee (a waiver is the owner's own action). Inside a transaction an enqueue
 * failure aborts the settlement so the two can never diverge; outside one it is logged only.
 */
export class PenaltySettlementNotifier implements PenaltySettlementNotificationPort {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: Pick<BookingNotificationUserPort, "findManyByIds">,
  ) {}

  public async notifyPenaltySettlement(
    booking: BookingDocument,
    business: BusinessDocument,
    settlement: {
      kind: PenaltySettlementKind;
      outcome: PenaltySettlementOutcome;
      amountCents: number;
      obligationKey: string;
    },
    session?: ClientSession,
  ): Promise<void> {
    try {
      const payload = buildPenaltySettlementEmailData(booking, {
        businessName: business.name,
        kind: settlement.kind,
        outcome: settlement.outcome,
        amountCents: settlement.amountCents,
      }) as unknown as Record<string, unknown>;
      const eventKey = `PENALTY_SETTLEMENT:${settlement.obligationKey}:${settlement.outcome}`;

      const customerEmail = normalizeRecipient(booking.customer.contact.normalizedEmail);
      if (customerEmail) {
        await this.emailOutbox.enqueue(
          {
            eventKey,
            templateKey: "PENALTY_SETTLEMENT_CUSTOMER",
            recipient: customerEmail,
            payload,
          },
          session,
        );
      }
      if (settlement.outcome !== "WAIVED") {
        const [owner] = await this.users.findManyByIds([String(business.ownerUserId)]);
        const ownerEmail = owner ? normalizeRecipient(owner.normalizedEmail) : undefined;
        if (ownerEmail) {
          await this.emailOutbox.enqueue(
            { eventKey, templateKey: "PENALTY_SETTLEMENT_OWNER", recipient: ownerEmail, payload },
            session,
          );
        }
      }
    } catch (error) {
      if (session) throw error;
      logger.error(
        { err: error, bookingId: String(booking._id), outcome: settlement.outcome },
        "Failed to enqueue penalty settlement notification (the settlement is unaffected)",
      );
    }
  }
}
