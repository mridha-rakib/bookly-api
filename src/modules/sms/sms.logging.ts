import { logger } from "../../config/logger.js";
import type { SmsProviderErrorCategory } from "./sms.errors.js";
import { maskPhone } from "./sms-transport.js";

/**
 * Safe structured logging for SMS delivery — mirrors `email.logging.ts`. Only ever emits:
 * provider, eventKey, masked recipient number, provider HTTP status, safe error category, safe
 * (generic) provider message, provider message id. Never the auth token, the Messaging Service
 * SID, the full body, or a raw provider object — those are also covered by the pino redaction
 * list.
 */
export type SmsLogContext = {
  provider?: string | undefined;
  eventKey?: string | undefined;
  /** Raw E.164 — masked here before it is written. */
  recipientE164?: string | undefined;
};

const base = (context: SmsLogContext): Record<string, unknown> => ({
  ...(context.provider ? { provider: context.provider } : {}),
  ...(context.eventKey ? { eventKey: context.eventKey } : {}),
  ...(context.recipientE164 ? { recipient: maskPhone(context.recipientE164) } : {}),
});

export const logSmsAccepted = (context: SmsLogContext & { providerMessageId?: string }): void => {
  logger.info(
    {
      ...base(context),
      status: "PROVIDER_ACCEPTED",
      ...(context.providerMessageId ? { providerMessageId: context.providerMessageId } : {}),
    },
    "SMS accepted by provider",
  );
};

export const logSmsFailed = (
  context: SmsLogContext & {
    errorCategory: SmsProviderErrorCategory | "UNKNOWN";
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
    context.willRetry ? "SMS delivery failed — retry scheduled" : "SMS delivery failed",
  );
};
