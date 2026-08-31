import { logger } from "../../config/logger.js";
import type { EmailProviderErrorCategory } from "./email.errors.js";
import { maskEmail } from "./email-transport.js";

/**
 * Safe structured logging for email delivery (Phase M / Phase S). Only ever emits: provider,
 * templateKey, eventKey, masked recipient, provider HTTP status, safe error category, safe
 * (generic) provider message, provider message id. Never the API key, OTP, token, or a raw
 * provider body — those are additionally covered by the pino redaction list.
 */

export type EmailLogContext = {
  provider?: string | undefined;
  templateKey?: string | undefined;
  eventKey?: string | undefined;
  recipient?: string | undefined;
};

const base = (context: EmailLogContext): Record<string, unknown> => ({
  ...(context.provider ? { provider: context.provider } : {}),
  ...(context.templateKey ? { templateKey: context.templateKey } : {}),
  ...(context.eventKey ? { eventKey: context.eventKey } : {}),
  ...(context.recipient ? { recipient: maskEmail(context.recipient) } : {}),
});

export const logEmailAccepted = (
  context: EmailLogContext & { providerMessageId?: string },
): void => {
  logger.info(
    {
      ...base(context),
      status: "PROVIDER_ACCEPTED",
      ...(context.providerMessageId ? { providerMessageId: context.providerMessageId } : {}),
    },
    "Email accepted by provider",
  );
};

export const logEmailFailed = (
  context: EmailLogContext & {
    errorCategory: EmailProviderErrorCategory | "RENDER_ERROR" | "UNKNOWN";
    providerStatus?: number | undefined;
    safeMessage?: string | undefined;
    willRetry: boolean;
  },
): void => {
  logger.warn(
    {
      ...base(context),
      errorCategory: context.errorCategory,
      ...(context.providerStatus === undefined ? {} : { providerStatus: context.providerStatus }),
      ...(context.safeMessage ? { safeMessage: context.safeMessage } : {}),
      willRetry: context.willRetry,
    },
    context.willRetry ? "Email delivery failed — retry scheduled" : "Email delivery failed",
  );
};
