import { Resend } from "resend";

import { env } from "../../config/env.js";
import {
  classifyEmailProviderError,
  EMAIL_PROVIDER_REQUEST_TIMEOUT_MS,
  EmailError,
} from "./email.errors.js";
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

/**
 * resend@6 does NOT throw on provider or network failure: `fetchRequest` RETURNS
 * `{ data: null, error }` (HTTP errors carry `statusCode`; network failures, including an
 * abort, carry `statusCode: null`). Only `{ data, error: null }` is provider acceptance.
 * `options` are spread into `fetch`, so `signal` really cancels the request.
 */
type ResendLikeClient = {
  emails: {
    send(payload: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
};

type ResendLikeResponse = {
  data?: { id?: unknown } | null;
  error?: { name?: unknown; statusCode?: unknown } | null;
};

/** Never forward the provider's message body: keep only its name and status. */
const sanitizedResendError = (error: { name?: unknown; statusCode?: unknown }) => ({
  name: typeof error.name === "string" ? error.name : "resend_error",
  statusCode: typeof error.statusCode === "number" ? error.statusCode : null,
});

const unknownOutcome = (cause: unknown): EmailError =>
  new EmailError("PROVIDER_OUTCOME_UNKNOWN", {
    safeProviderMessage: "no definitive provider response; acceptance unknown",
    cause,
  });

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

    const signal = AbortSignal.timeout(EMAIL_PROVIDER_REQUEST_TIMEOUT_MS);
    let response: ResendLikeResponse | undefined;
    try {
      response = (await this.clientFactory(env.RESEND_API_KEY).emails.send(payload, {
        signal,
      })) as ResendLikeResponse | undefined;
    } catch (error) {
      // Thrown (not returned) failures — e.g. a client-side render error. Existing mapping.
      if (signal.aborted) throw unknownOutcome({ name: "TimeoutError" });
      const { category, providerStatus, safeProviderMessage } = classifyEmailProviderError(error);
      throw new EmailError(category, {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(safeProviderMessage === undefined ? {} : { safeProviderMessage }),
        cause: error,
      });
    }

    const returnedError = response?.error;
    if (returnedError) {
      const sanitized = sanitizedResendError(returnedError);
      // statusCode null = no HTTP response (network failure or our abort): unknown, not rejected.
      if (sanitized.statusCode === null) throw unknownOutcome(sanitized);
      const { category, providerStatus, safeProviderMessage } =
        classifyEmailProviderError(sanitized);
      throw new EmailError(category, {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(safeProviderMessage === undefined ? {} : { safeProviderMessage }),
        cause: sanitized,
      });
    }
    if (typeof response !== "object" || response === null) {
      // Not the SDK's `{ data, error }` envelope: no acceptance evidence. Do not record SENT.
      throw unknownOutcome({ name: "resend_invalid_response" });
    }

    // `error` absent/null is the SDK's success envelope (2xx). The message id is optional.
    const id = response.data?.id;
    const providerMessageId = typeof id === "string" ? id : undefined;
    return {
      provider: "resend",
      status: "PROVIDER_ACCEPTED",
      ...(providerMessageId ? { providerMessageId } : {}),
    };
  }
}
