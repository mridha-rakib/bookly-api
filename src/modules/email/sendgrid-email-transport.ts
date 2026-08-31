import sgMail from "@sendgrid/mail";

import { env } from "../../config/env.js";
import { classifyEmailProviderError, EmailError } from "./email.errors.js";
import type {
  EmailAttachment,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./email.types.js";
import type { EmailTransport } from "./email-transport.js";

/**
 * THE canonical SendGrid transport (Phase C). This is the only file in the codebase that calls
 * `sgMail.setApiKey` / `sgMail.send`. The OTP and Support providers now delegate here through
 * {@link SendGridEmailTransport} instead of each constructing their own `@sendgrid/mail` client.
 */

type SendGridLikeClient = {
  send(payload: Record<string, unknown>): Promise<unknown>;
};

const defaultSendGridClientFactory = (apiKey: string): SendGridLikeClient => {
  sgMail.setApiKey(apiKey);
  return sgMail as unknown as SendGridLikeClient;
};

const toSendGridAttachment = (attachment: EmailAttachment): Record<string, unknown> => ({
  content: attachment.content.toString("base64"),
  filename: attachment.filename,
  type: attachment.type,
  disposition: attachment.disposition ?? "attachment",
  ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
});

const extractMessageId = (response: unknown): string | undefined => {
  const clientResponse = Array.isArray(response) ? response[0] : response;
  if (typeof clientResponse !== "object" || clientResponse === null) {
    return undefined;
  }
  const headers = (clientResponse as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const value =
    record["x-message-id"] ?? record["X-Message-Id"] ?? record["x-message-id".toUpperCase()];
  return typeof value === "string" ? value : undefined;
};

export class SendGridEmailTransport implements EmailTransport {
  public readonly provider = "sendgrid" as const;

  public constructor(
    private readonly clientFactory: (
      apiKey: string,
    ) => SendGridLikeClient = defaultSendGridClientFactory,
  ) {}

  public isConfigured(): boolean {
    return Boolean(env.SENDGRID_API_KEY && env.EMAIL_FROM);
  }

  public async send(input: EmailTransportSendInput): Promise<EmailTransportSendResult> {
    if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) {
      throw new EmailError("NOT_CONFIGURED");
    }

    const payload: Record<string, unknown> = {
      to: input.to,
      from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
      subject: input.subject,
      text: input.text,
    };
    if (input.html) {
      payload["html"] = input.html;
    }
    if (input.attachments && input.attachments.length > 0) {
      payload["attachments"] = input.attachments.map(toSendGridAttachment);
    }
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      payload["customArgs"] = input.metadata;
    }

    try {
      const response = await this.clientFactory(env.SENDGRID_API_KEY).send(payload);
      const providerMessageId = extractMessageId(response);
      return {
        provider: "sendgrid",
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
