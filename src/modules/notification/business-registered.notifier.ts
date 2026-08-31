import { logger } from "../../config/logger.js";
import { INTERNAL_NOTIFICATION_RECIPIENTS } from "../email/email.config.js";
import type { BusinessRegisteredEmailData } from "../email/templates/admin/business-registered.template.js";
import { formatDateInTimezone } from "../email/templates/components/email-format.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

export type BusinessRegisteredNotificationInput = {
  businessId: string;
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  phone?: string | undefined;
  category?: string | undefined;
  city?: string | undefined;
  status: string;
  registeredAt: Date;
};

/** Optional observer port — see `AuthService.completeBusinessOwner`. */
export type BusinessRegisteredNotificationPort = {
  notifyBusinessRegistered(input: BusinessRegisteredNotificationInput): Promise<void>;
};

/**
 * TRIGGER 6 — INTERNAL notification after a new business-owner registration commits. Recipients:
 * `admin@bookly.cy` + `support@bookly.cy` (from {@link INTERNAL_NOTIFICATION_RECIPIENTS}) —
 * never customer-facing, never in the footer. Never throws.
 */
export class BusinessRegisteredNotifier implements BusinessRegisteredNotificationPort {
  public constructor(private readonly emailOutbox: OutboxEnqueue) {}

  public async notifyBusinessRegistered(input: BusinessRegisteredNotificationInput): Promise<void> {
    try {
      const payload: BusinessRegisteredEmailData = {
        businessId: input.businessId,
        businessName: input.businessName,
        ownerName: input.ownerName,
        ownerEmail: input.ownerEmail,
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.city ? { city: input.city } : {}),
        status: input.status,
        registeredAtFormatted: formatDateInTimezone(input.registeredAt, "Europe/Nicosia"),
      };

      const eventKey = `BUSINESS_REGISTERED:${input.businessId}`;
      const recipients = [...new Set(INTERNAL_NOTIFICATION_RECIPIENTS.map(normalizeRecipient))];

      for (const recipient of recipients) {
        await this.emailOutbox.enqueue({
          eventKey,
          templateKey: "BUSINESS_REGISTERED",
          recipient,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, businessId: input.businessId },
        "Failed to enqueue BUSINESS_REGISTERED notification (the registration is unaffected)",
      );
    }
  }
}
