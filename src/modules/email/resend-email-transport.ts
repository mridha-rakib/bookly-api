import { Resend } from "resend";

import { env } from "../../config/env.js";
import { classifyEmailProviderError, EmailError } from "./email.errors.js";
import type {
  EmailAttachment,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./email.types.js";
import type { EmailTransport } from "./email-transport.js";

/**
 * Resend compatibility adapter (Phase B). Present so a pre-existing `EMAIL_PROVIDER=resend`
 * deployment keeps working through the shared {@link EmailTransport} contract. Inline `cid:`
 * images are best-effort on Resend; the production provider is SendGrid.
 */

type ResendLikeClient = {
  emails: {
    send(payload: Record<string, unknown>): Promise<unknown>;
  };
};

const defaultResendClientFactory = (apiKey: string): ResendLikeClient =>
  new Resend(apiKey) as unknown as ResendLikeClient;

const toResendAttachment = (attachment: EmailAttachment): Record<string, unknown> => ({
  filename: attachment.filename,
  content: attachment.content,
  ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
});

export class ResendEmailTransport implements EmailTransport {
  public readonly provider = "resend" as const;

  public constructor(
    private readonly clientFactory: (
      apiKey: string,
    ) => ResendLikeClient = defaultResendClientFactory,
  ) {}

  public isConfigured(): boolean {
    return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.RESEND_FROM_NAME);
  }

  public async send(input: EmailTransportSendInput): Promise<EmailTransportSendResult> {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.RESEND_FROM_NAME) {
      throw new EmailError("NOT_CONFIGURED");
    }

    const payload: Record<string, unknown> = {
      from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
    };
    if (input.html) {
      payload["html"] = input.html;
    }
    if (input.attachments && input.attachments.length > 0) {
      payload["attachments"] = input.attachments.map(toResendAttachment);
    }
    if (input.headers && Object.keys(input.headers).length > 0) {
      payload["headers"] = input.headers;
    }

    try {
      const response = (await this.clientFactory(env.RESEND_API_KEY).emails.send(payload)) as {
        data?: { id?: unknown } | null;
      };
      const providerMessageId =
        typeof response?.data?.id === "string" ? response.data.id : undefined;
      return {
        provider: "resend",
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
