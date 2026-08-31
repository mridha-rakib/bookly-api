import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { EmailError } from "../email/email.errors.js";
import type { EmailTransport } from "../email/email-transport.js";
import { ResendEmailTransport } from "../email/resend-email-transport.js";
import { SendGridEmailTransport } from "../email/sendgrid-email-transport.js";
import { SmtpEmailTransport } from "../email/smtp-email-transport.js";

/**
 * Support/Contact transactional sender. Previously this file carried a second, fully parallel
 * SMTP/Resend/SendGrid hierarchy plus its own `classifyProviderError`. It now delegates to the
 * ONE central {@link EmailTransport} (Phase B / Phase W); the class names, factory,
 * `SupportEmailProvider` interface, `SupportEmailDeliveryError`, and `resolveContactInboxEmail`
 * are preserved so support/contact business behaviour is unchanged.
 *
 * Content stays plain-text here (no branded layout) so the raw acknowledgement / admin-reply
 * semantics — and callers that catch-and-log rather than fail the surrounding request — are
 * untouched.
 */
export interface SupportEmailProvider {
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export class SupportEmailDeliveryError extends Error {
  public constructor(
    public readonly category: "not_configured" | "rate_limited" | "delivery_failed",
    cause?: unknown,
  ) {
    super(`Support email delivery failed: ${category}`, { cause });
    this.name = "SupportEmailDeliveryError";
  }
}

const toSupportCategory = (
  error: EmailError,
): "not_configured" | "rate_limited" | "delivery_failed" => {
  if (error.category === "NOT_CONFIGURED") {
    return "not_configured";
  }
  if (error.category === "RATE_LIMITED") {
    return "rate_limited";
  }
  return "delivery_failed";
};

abstract class TransportBackedSupportEmailProvider implements SupportEmailProvider {
  protected constructor(private readonly transport: EmailTransport) {}

  public async send(input: { to: string; subject: string; text: string }): Promise<void> {
    try {
      await this.transport.send({ to: input.to, subject: input.subject, text: input.text });
    } catch (error) {
      if (error instanceof EmailError) {
        const category = toSupportCategory(error);
        logger.warn(
          { provider: this.transport.provider, category },
          "Support email delivery failed",
        );
        throw new SupportEmailDeliveryError(category, error);
      }
      throw error;
    }
  }
}

type SendGridClientFactory = ConstructorParameters<typeof SendGridEmailTransport>[0];
type SmtpTransporterFactory = ConstructorParameters<typeof SmtpEmailTransport>[0];
type ResendClientFactory = ConstructorParameters<typeof ResendEmailTransport>[0];

export class SendGridSupportEmailProvider extends TransportBackedSupportEmailProvider {
  public constructor(clientFactory?: SendGridClientFactory) {
    super(clientFactory ? new SendGridEmailTransport(clientFactory) : new SendGridEmailTransport());
  }
}

export class SmtpSupportEmailProvider extends TransportBackedSupportEmailProvider {
  public constructor(transporterFactory?: SmtpTransporterFactory) {
    super(
      transporterFactory ? new SmtpEmailTransport(transporterFactory) : new SmtpEmailTransport(),
    );
  }
}

export class ResendSupportEmailProvider extends TransportBackedSupportEmailProvider {
  public constructor(clientFactory?: ResendClientFactory) {
    super(clientFactory ? new ResendEmailTransport(clientFactory) : new ResendEmailTransport());
  }
}

export const createSupportEmailProvider = (): SupportEmailProvider => {
  if (env.EMAIL_PROVIDER === "sendgrid") {
    return new SendGridSupportEmailProvider();
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return new ResendSupportEmailProvider();
  }
  return new SmtpSupportEmailProvider();
};

/** The address the public Contact form's message is sent TO — unchanged: falls back to whichever
 * address the configured provider already sends FROM. */
export const resolveContactInboxEmail = (): string | undefined =>
  env.SUPPORT_CONTACT_INBOX_EMAIL ??
  (env.EMAIL_PROVIDER === "resend" ? env.RESEND_FROM_EMAIL : env.EMAIL_FROM);
