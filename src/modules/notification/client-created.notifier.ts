import { logger } from "../../config/logger.js";
import { maskEmail } from "../email/email-transport.js";
import type { ClientCreatedEmailData } from "../email/templates/client/client-created.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

/** Just the persisted fields the notifier needs from the freshly-created client + its business. */
export type ClientCreatedNotificationInput = {
  clientId: string;
  clientFirstName: string;
  clientEmail: string;
  businessName: string;
};

/**
 * TRIGGER 1 — enqueues the "you've been added as a client" email after a Business Owner /
 * Supervisor successfully creates a client. Recipient: the client only. Never sends to the
 * Business Owner. Never fails client creation — any error here is logged and swallowed.
 */
export class ClientCreatedNotifier {
  public constructor(private readonly emailOutbox: EmailOutboxService) {}

  public async notifyClientCreated(input: ClientCreatedNotificationInput): Promise<void> {
    try {
      const recipient = normalizeRecipient(input.clientEmail);
      if (!recipient) {
        logger.warn(
          { clientId: input.clientId },
          "Client created without a usable email — skipping CLIENT_CREATED notification",
        );
        return;
      }

      const payload: ClientCreatedEmailData = {
        clientFirstName: input.clientFirstName,
        businessName: input.businessName,
      };

      await this.emailOutbox.enqueue({
        eventKey: `CLIENT_CREATED:${input.clientId}`,
        templateKey: "CLIENT_CREATED",
        recipient,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, clientId: input.clientId, recipient: maskEmail(input.clientEmail) },
        "Failed to enqueue CLIENT_CREATED notification (client creation is unaffected)",
      );
    }
  }
}
