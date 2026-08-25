import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { logger } from "../../config/logger.js";
import { ContactError } from "./contact.errors.js";
import type { SubmitContactBody } from "./contact.schema.js";
import { resolveContactInboxEmail, type SupportEmailProvider } from "./support-email.provider.js";

/**
 * Public, unauthenticated Contact endpoint. Unlike Support Ticket creation, there is no persisted
 * record to fall back on here — the email delivery IS the entire operation, so (unlike
 * support.service.ts's best-effort/never-fails email sends) a genuine provider failure must be
 * surfaced honestly rather than silently reported as success (confirmed rule: "Do not fake
 * success").
 */
export class ContactController {
  public constructor(private readonly emailProvider: SupportEmailProvider) {}

  public submit = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as SubmitContactBody;
    const inbox = resolveContactInboxEmail();

    if (!inbox) {
      logger.warn("Contact message dropped: no inbox email configured");
      throw new ContactError("CONTACT_DELIVERY_FAILED", 503);
    }

    try {
      await this.emailProvider.send({
        to: inbox,
        subject: `[Contact] ${body.subject}`,
        text: `New contact message from ${body.name} <${body.email}>:\n\n${body.message}`,
      });
    } catch (error) {
      logger.warn({ error }, "Contact message delivery failed");
      throw new ContactError("CONTACT_DELIVERY_FAILED", 502);
    }

    sendSuccess(response, 200, "Your message has been sent");
  };
}
