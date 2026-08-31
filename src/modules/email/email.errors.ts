import { AppError } from "../../common/errors/app-error.js";

/**
 * THE canonical email-provider error taxonomy (Phase L). Both the OTP adapter and the Support
 * adapter previously carried their own copy of a `classifyProviderError` that only knew about
 * `429`; that duplication is deleted in favour of this module.
 */
export type EmailProviderErrorCategory =
  | "RATE_LIMITED"
  | "PROVIDER_TRANSIENT"
  | "NETWORK_TRANSIENT"
  | "INVALID_MESSAGE"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_PERMISSION_OR_SENDER_ERROR"
  | "PROVIDER_PERMANENT"
  | "NOT_CONFIGURED";

const RETRYABLE_CATEGORIES: ReadonlySet<EmailProviderErrorCategory> =
  new Set<EmailProviderErrorCategory>(["RATE_LIMITED", "PROVIDER_TRANSIENT", "NETWORK_TRANSIENT"]);

export const isRetryableEmailErrorCategory = (category: EmailProviderErrorCategory): boolean =>
  RETRYABLE_CATEGORIES.has(category);

type EmailErrorOptions = {
  httpStatus?: number;
  providerStatus?: number;
  /** A short, already-sanitised string safe to persist/log — NEVER a raw provider body. */
  safeProviderMessage?: string;
  cause?: unknown;
};

/**
 * Raised by transports for any delivery failure. `expose` is false: the raw `cause` (which may
 * carry a provider response body or key) is kept for local logging only and is never serialised
 * onto the HTTP error surface. Callers that must surface something to an end user (the OTP path)
 * translate this into their own domain error by `category`, copying nothing else across.
 */
export class EmailError extends AppError {
  public readonly category: EmailProviderErrorCategory;
  public readonly retryable: boolean;
  public readonly providerStatus: number | undefined;
  public readonly safeProviderMessage: string | undefined;

  public constructor(category: EmailProviderErrorCategory, options: EmailErrorOptions = {}) {
    const statusCode =
      options.httpStatus ??
      (category === "RATE_LIMITED" ? 429 : category === "NOT_CONFIGURED" ? 503 : 502);
    super(`Email delivery failed: ${category}`, statusCode, {
      cause: options.cause,
      expose: false,
    });
    this.category = category;
    this.retryable = isRetryableEmailErrorCategory(category);
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

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Maps an arbitrary provider rejection to `{ category, providerStatus, safeProviderMessage }`.
 * The returned `safeProviderMessage` is intentionally generic (status/kind only) — provider
 * response bodies are never echoed, so a leaked key or PII in a body cannot ride out on the
 * classified error.
 */
export const classifyEmailProviderError = (
  error: unknown,
): {
  category: EmailProviderErrorCategory;
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
  const rawCode = record["code"];
  const status =
    readNumber(rawCode) ??
    readNumber(record["statusCode"]) ??
    readNumber(record["status"]) ??
    readNumber(record["responseCode"]);
  const codeString = readString(rawCode);
  const message = readString(record["message"]) ?? "";

  if (status !== undefined) {
    if (status === 429) {
      return {
        category: "RATE_LIMITED",
        providerStatus: status,
        safeProviderMessage: "provider returned 429",
      };
    }
    if (status >= 500) {
      return {
        category: "PROVIDER_TRANSIENT",
        providerStatus: status,
        safeProviderMessage: `provider returned ${status}`,
      };
    }
    if (status === 400) {
      return {
        category: "INVALID_MESSAGE",
        providerStatus: status,
        safeProviderMessage: "provider rejected message as invalid (400)",
      };
    }
    if (status === 401) {
      return {
        category: "PROVIDER_AUTH_ERROR",
        providerStatus: status,
        safeProviderMessage: "provider authentication failed (401)",
      };
    }
    if (status === 403) {
      return {
        category: "PROVIDER_PERMISSION_OR_SENDER_ERROR",
        providerStatus: status,
        safeProviderMessage: "provider permission / sender verification error (403)",
      };
    }
    if (status >= 400) {
      return {
        category: "PROVIDER_PERMANENT",
        providerStatus: status,
        safeProviderMessage: `provider returned ${status}`,
      };
    }
  }

  if (
    (codeString !== undefined && NETWORK_ERROR_CODES.has(codeString)) ||
    /timeout|timed out|network|socket hang up|ecconn|dns/i.test(message)
  ) {
    return {
      category: "NETWORK_TRANSIENT",
      providerStatus: status,
      safeProviderMessage: "network error contacting provider",
    };
  }

  return {
    category: "PROVIDER_TRANSIENT",
    providerStatus: status,
    safeProviderMessage: "unclassified provider error",
  };
};
