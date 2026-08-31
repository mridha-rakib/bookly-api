import type { EmailTransportSendResult, RenderedEmail } from "./email.types.js";
import { createEmailTransport } from "./email-transport.factory.js";
import type { EmailTransport } from "./email-transport.js";
import { type EmailTemplateKey, renderEmailTemplate } from "./template-registry.js";

/**
 * Thin application-level facade over {@link renderEmailTemplate} + {@link EmailTransport}. Used
 * by the outbox worker (and, later, any synchronous branded send). Holds no provider knowledge.
 */
export class EmailService {
  public constructor(private readonly transport: EmailTransport = createEmailTransport()) {}

  public render(templateKey: EmailTemplateKey, payload: unknown): RenderedEmail {
    return renderEmailTemplate(templateKey, payload);
  }

  public sendRendered(
    to: string,
    rendered: RenderedEmail,
    metadata?: Record<string, string>,
  ): Promise<EmailTransportSendResult> {
    return this.transport.send({
      to,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html ? { html: rendered.html } : {}),
      ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  public renderAndSend(
    to: string,
    templateKey: EmailTemplateKey,
    payload: unknown,
    metadata?: Record<string, string>,
  ): Promise<EmailTransportSendResult> {
    return this.sendRendered(to, this.render(templateKey, payload), metadata);
  }
}
