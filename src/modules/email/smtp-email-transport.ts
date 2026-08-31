import nodemailer from "nodemailer";

import { env } from "../../config/env.js";
import { classifyEmailProviderError, EmailError } from "./email.errors.js";
import type {
  EmailAttachment,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./email.types.js";
import type { EmailTransport } from "./email-transport.js";

/**
 * SMTP compatibility adapter (Phase B). Kept so `EMAIL_PROVIDER=smtp` (the local-dev / test
 * default) keeps working through the SAME {@link EmailTransport} contract as SendGrid — no
 * second provider stack, no duplicated classification.
 */

type SmtpLikeTransporter = {
  sendMail(payload: Record<string, unknown>): Promise<unknown>;
};

const defaultSmtpTransporterFactory = (): SmtpLikeTransporter =>
  nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  }) as unknown as SmtpLikeTransporter;

const toNodemailerAttachment = (attachment: EmailAttachment): Record<string, unknown> => ({
  filename: attachment.filename,
  content: attachment.content,
  contentType: attachment.type,
  ...(attachment.contentId ? { cid: attachment.contentId } : {}),
  ...(attachment.disposition ? { contentDisposition: attachment.disposition } : {}),
});

export class SmtpEmailTransport implements EmailTransport {
  public readonly provider = "smtp" as const;

  public constructor(
    private readonly transporterFactory: () => SmtpLikeTransporter = defaultSmtpTransporterFactory,
  ) {}

  public isConfigured(): boolean {
    return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
  }

  public async send(input: EmailTransportSendInput): Promise<EmailTransportSendResult> {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.EMAIL_FROM) {
      throw new EmailError("NOT_CONFIGURED");
    }

    const payload: Record<string, unknown> = {
      from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
    };
    if (input.html) {
      payload["html"] = input.html;
    }
    if (input.attachments && input.attachments.length > 0) {
      payload["attachments"] = input.attachments.map(toNodemailerAttachment);
    }

    try {
      const info = (await this.transporterFactory().sendMail(payload)) as { messageId?: unknown };
      const providerMessageId = typeof info?.messageId === "string" ? info.messageId : undefined;
      return {
        provider: "smtp",
        status: "PROVIDER_ACCEPTED",
        ...(providerMessageId ? { providerMessageId } : {}),
      };
    } catch (error) {
      const { category, providerStatus, safeProviderMessage } = classifyEmailProviderError(error);
      throw new EmailError(category, {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(safeProviderMessage === undefined ? {} : { safeProviderMessage }),
        cause: error,
      });
    }
  }
}
