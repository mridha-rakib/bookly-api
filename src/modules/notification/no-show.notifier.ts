import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import {
  buildNoShowEmailData,
  type NoShowChargedAmounts,
  type NoShowOutcome,
} from "../email/templates/booking/no-show-email-data.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

const TEMPLATE_BY_OUTCOME: Record<
  NoShowOutcome,
  "NO_SHOW_CHARGED" | "NO_SHOW_WAIVED" | "NO_SHOW_CANCELLED"
> = {
  CHARGED: "NO_SHOW_CHARGED",
  WAIVED: "NO_SHOW_WAIVED",
  CANCELLED: "NO_SHOW_CANCELLED",
};

/** Optional observer port used by both the no-show worker and the lifecycle service. */
export type NoShowNotificationPort = {
  notifyNoShowCharged(
    booking: BookingDocument,
    context: { businessName: string; amounts: NoShowChargedAmounts },
  ): Promise<void>;
  notifyNoShowWaived(booking: BookingDocument, context: { businessName: string }): Promise<void>;
  notifyNoShowCancelled(booking: BookingDocument, context: { businessName: string }): Promise<void>;
};

/**
 * TRIGGERS 3, 4, 5 — customer-only. Fired ONLY on a real terminal no-show outcome:
 *   CHARGED   — after `NoShowResolutionService.autoResolve` confirms a SUCCEEDED card charge
 *   WAIVED    — status NO_SHOW_WAIVED (business waiver or the auto-resolver's no-charge branches)
 *   CANCELLED — status NO_SHOW_CANCELLED (`cancelNoShowByBusiness`)
 * Never on `markNoShow` / timer start / a failed charge. Never throws.
 */
export class NoShowNotifier implements NoShowNotificationPort {
  public constructor(private readonly emailOutbox: OutboxEnqueue) {}

  public notifyNoShowCharged(
    booking: BookingDocument,
    context: { businessName: string; amounts: NoShowChargedAmounts },
  ): Promise<void> {
    return this.enqueue(booking, "CHARGED", context.businessName, context.amounts);
  }

  public notifyNoShowWaived(
    booking: BookingDocument,
    context: { businessName: string },
  ): Promise<void> {
    return this.enqueue(booking, "WAIVED", context.businessName);
  }

  public notifyNoShowCancelled(
    booking: BookingDocument,
    context: { businessName: string },
  ): Promise<void> {
    return this.enqueue(booking, "CANCELLED", context.businessName);
  }

  private async enqueue(
    booking: BookingDocument,
    outcome: NoShowOutcome,
    businessName: string,
    amounts?: NoShowChargedAmounts,
  ): Promise<void> {
    try {
      const recipient = normalizeRecipient(booking.customer.contact.normalizedEmail);
      if (!recipient) {
        logger.warn(
          { bookingId: String(booking._id), outcome },
          "No-show outcome has no usable customer email — skipping notification",
        );
        return;
      }
      const data = buildNoShowEmailData(booking, {
        businessName,
        outcome,
        ...(amounts ? { amounts } : {}),
      });
      const templateKey = TEMPLATE_BY_OUTCOME[outcome];
      await this.emailOutbox.enqueue({
        eventKey: `${templateKey}:${String(booking._id)}`,
        templateKey,
        recipient,
        payload: data as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, bookingId: String(booking._id), outcome },
        "Failed to enqueue no-show notification (the no-show outcome is unaffected)",
      );
    }
  }
}
