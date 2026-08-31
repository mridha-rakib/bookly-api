import { AppError } from "../../common/errors/app-error.js";

/**
 * SMS-provider error taxonomy — same shape/category names as the email module's
 * {@link import("../email/email.errors.js").EmailProviderErrorCategory} so the SmsOutbox worker
 * can share the "retryable vs terminal" convention without a second mental model.
 */
export type SmsProviderErrorCategory =
  | "RATE_LIMITED"
  | "PROVIDER_TRANSIENT"
  | "NETWORK_TRANSIENT"
  | "INVALID_DESTINATION"
  | "RECIPIENT_UNREACHABLE"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_PERMISSION_OR_SENDER_ERROR"
  | "PROVIDER_PERMANENT"
  | "NOT_CONFIGURED";

const RETRYABLE_CATEGORIES: ReadonlySet<SmsProviderErrorCategory> =
  new Set<SmsProviderErrorCategory>(["RATE_LIMITED", "PROVIDER_TRANSIENT", "NETWORK_TRANSIENT"]);

export const isRetryableSmsErrorCategory = (category: SmsProviderErrorCategory): boolean =>
  RETRYABLE_CATEGORIES.has(category);

type SmsErrorOptions = {
  httpStatus?: number;
  providerStatus?: number;
  /** Short, already-sanitised string safe to persist/log — NEVER a raw provider body. */
  safeProviderMessage?: string;
  cause?: unknown;
};

/**
 * Raised by SMS transports for any delivery failure. `expose: false` — the raw `cause` (which
 * may carry a Twilio response body) is kept for local logging only and is never serialised onto
 * an HTTP surface. The worker branches on `category` / `retryable`, copying nothing else.
 */
export class SmsError extends AppError {
  public readonly category: SmsProviderErrorCategory;
  public readonly retryable: boolean;
  public readonly providerStatus: number | undefined;
  public readonly safeProviderMessage: string | undefined;

  public constructor(category: SmsProviderErrorCategory, options: SmsErrorOptions = {}) {
    const statusCode =
      options.httpStatus ??
      (category === "RATE_LIMITED" ? 429 : category === "NOT_CONFIGURED" ? 503 : 502);
    super(`SMS delivery failed: ${category}`, statusCode, { cause: options.cause, expose: false });
    this.category = category;
    this.retryable = isRetryableSmsErrorCategory(category);
    this.providerStatus = options.providerStatus;
    this.safeProviderMessage = options.safeProviderMessage;
  }
}

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

/**
 * The documented subset of Twilio Messaging error `code`s that can never succeed on retry
 * (https://www.twilio.com/docs/api/errors). Anything not listed falls back to HTTP-status
 * classification below — we never guess a code as permanent without a documented basis.
 */
const TWILIO_PERMANENT_CODES: ReadonlyMap<number, SmsProviderErrorCategory> = new Map<
  number,
  SmsProviderErrorCategory
>([
  [21211, "INVALID_DESTINATION"], // invalid 'To' number
  [21214, "INVALID_DESTINATION"], // 'To' number failed validation
  [21606, "PROVIDER_PERMISSION_OR_SENDER_ERROR"], // 'From'/sender not SMS-capable for the 'To'
  [21610, "PROVIDER_PERMISSION_OR_SENDER_ERROR"], // recipient has opted out (STOP)
  [21612, "RECIPIENT_UNREACHABLE"], // cannot route to this number
  [21614, "INVALID_DESTINATION"], // 'To' not a valid mobile number
  [21408, "PROVIDER_PERMISSION_OR_SENDER_ERROR"], // permission to send to region not enabled
  [20003, "PROVIDER_AUTH_ERROR"], // authentication failed
]);
const TWILIO_RATE_LIMIT_CODE = 20429;

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Maps an arbitrary provider rejection to `{ category, providerStatus, safeProviderMessage }`.
 * `safeProviderMessage` is intentionally generic (status/kind only) — provider response bodies
 * are never echoed, so a leaked credential or PII in a body cannot ride out on a classified
 * error. Twilio SDK errors carry a numeric `code` (Twilio error id) AND `status` (HTTP status);
 * the documented permanent `code`s are checked first, then HTTP status, then network heuristics.
 */
export const classifySmsProviderError = (
  error: unknown,
): {
  category: SmsProviderErrorCategory;
  providerStatus: number | undefined;
  safeProviderMessage: string | undefined;
} => {
  if (typeof error !== "object" || error === null) {
    return {
      category: "PROVIDER_TRANSIENT",
      providerStatus: undefined,
      safeProviderMessage: undefined,
    };
  }

  const record = error as Record<string, unknown>;
  const twilioCode = readNumber(record["code"]);
  const httpStatus = readNumber(record["status"]) ?? readNumber(record["statusCode"]) ?? undefined;
  const message = readString(record["message"]) ?? "";

  if (twilioCode === TWILIO_RATE_LIMIT_CODE) {
    return {
      category: "RATE_LIMITED",
      providerStatus: httpStatus,
      safeProviderMessage: "provider rate limited (20429)",
    };
  }
  if (twilioCode !== undefined && TWILIO_PERMANENT_CODES.has(twilioCode)) {
    return {
      category: TWILIO_PERMANENT_CODES.get(twilioCode) as SmsProviderErrorCategory,
      providerStatus: httpStatus,
      safeProviderMessage: `provider error ${twilioCode}`,
    };
  }

  if (httpStatus !== undefined) {
    if (httpStatus === 429) {
      return {
        category: "RATE_LIMITED",
        providerStatus: httpStatus,
        safeProviderMessage: "provider returned 429",
      };
    }
    if (httpStatus >= 500) {
      return {
        category: "PROVIDER_TRANSIENT",
        providerStatus: httpStatus,
        safeProviderMessage: `provider returned ${httpStatus}`,
      };
    }
    if (httpStatus === 401) {
      return {
        category: "PROVIDER_AUTH_ERROR",
        providerStatus: httpStatus,
        safeProviderMessage: "provider authentication failed (401)",
      };
    }
    if (httpStatus === 403) {
      return {
        category: "PROVIDER_PERMISSION_OR_SENDER_ERROR",
        providerStatus: httpStatus,
        safeProviderMessage: "provider permission / sender error (403)",
      };
    }
    if (httpStatus === 400) {
      return {
        category: "INVALID_DESTINATION",
        providerStatus: httpStatus,
        safeProviderMessage: "provider rejected the message as invalid (400)",
      };
    }
    if (httpStatus >= 400) {
      return {
        category: "PROVIDER_PERMANENT",
        providerStatus: httpStatus,
        safeProviderMessage: `provider returned ${httpStatus}`,
      };
    }
  }

  const codeString = readString(record["code"]);
  if (
    (codeString !== undefined && NETWORK_ERROR_CODES.has(codeString)) ||
    /timeout|timed out|network|socket hang up|econn|dns/i.test(message)
  ) {
    return {
      category: "NETWORK_TRANSIENT",
      providerStatus: httpStatus,
      safeProviderMessage: "network error contacting provider",
    };
  }

  return {
    category: "PROVIDER_TRANSIENT",
    providerStatus: httpStatus,
    safeProviderMessage: "unclassified provider error",
  };
};
