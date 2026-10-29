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
  /**
   * The request may have reached the provider but no definitive answer came back (timeout,
   * abort, dropped connection). The email MAY have been accepted. Retryable — Bookly is
   * at-least-once — but never evidence of rejection.
   */
  | "PROVIDER_OUTCOME_UNKNOWN"
  | "INVALID_MESSAGE"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_PERMISSION_OR_SENDER_ERROR"
  | "PROVIDER_PERMANENT"
  | "NOT_CONFIGURED";

const RETRYABLE_CATEGORIES: ReadonlySet<EmailProviderErrorCategory> =
  new Set<EmailProviderErrorCategory>([
    "RATE_LIMITED",
    "PROVIDER_TRANSIENT",
    "NETWORK_TRANSIENT",
    "PROVIDER_OUTCOME_UNKNOWN",
  ]);

/**
 * Upper bound for one provider request. Must stay below the email worker's PM2 drain grace
 * (60 s, ecosystem.email-worker.config.cjs) and EMAIL_OUTBOX_CLAIM_TIMEOUT_MS (120 s default).
 * How strictly each transport enforces it differs — see docs/EMAIL-PROVIDER-TIMEOUTS.md.
 */
export const EMAIL_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

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

// The connection was never established, so the provider cannot have accepted anything.
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

// Timed out, aborted or dropped after (possibly) sending: acceptance is unknown. Includes the
// axios timeout code (ECONNABORTED) and nodemailer's timeouts (ETIMEDOUT, any phase).
const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ABORT_ERR",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const OUTCOME_UNKNOWN_NAMES: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const SMTP_AUTH_CODES: ReadonlySet<number> = new Set([530, 534, 535]);
const SMTP_INVALID_MESSAGE_CODES: ReadonlySet<number> = new Set([500, 501, 503, 504, 552, 555]);

/**
 * F4A Tier 3 — an SMTP server reply (RFC 5321): a definitive answer, so never "unknown".
 *  - 4xx: transient (try again later; includes 421/450/451/452 throttling and greylisting).
 *  - 530/534/535: authentication. 500/501/503/504/555 syntax and 552 size: invalid message.
 *  - other 5xx (550/551/553/554…): permanent rejection.
 * `429` is not an SMTP code; it keeps its existing RATE_LIMITED mapping for callers that put an
 * HTTP-style value in `responseCode`. Any other value is not a recognised failure reply.
 */
const classifySmtpResponseCode = (
  code: number,
): {
  category: EmailProviderErrorCategory;
  providerStatus: number;
  safeProviderMessage: string;
} => {
  const safeProviderMessage = `SMTP server replied ${code}`;
  const category: EmailProviderErrorCategory =
    code === 429
      ? "RATE_LIMITED"
      : code >= 400 && code < 500
        ? "PROVIDER_TRANSIENT"
        : SMTP_AUTH_CODES.has(code)
          ? "PROVIDER_AUTH_ERROR"
          : SMTP_INVALID_MESSAGE_CODES.has(code)
            ? "INVALID_MESSAGE"
            : code >= 500 && code < 600
              ? "PROVIDER_PERMANENT"
              : "PROVIDER_OUTCOME_UNKNOWN";
  return { category, providerStatus: code, safeProviderMessage };
};

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
  const httpStatus =
    readNumber(rawCode) ?? readNumber(record["statusCode"]) ?? readNumber(record["status"]);
  const smtpResponseCode = readNumber(record["responseCode"]);
  // F4A Tier 3: nodemailer reports the SMTP reply in `responseCode` (and no HTTP status).
  // SMTP semantics are NOT HTTP semantics: 4xx is temporary, 5xx is permanent.
  if (httpStatus === undefined && smtpResponseCode !== undefined) {
    return classifySmtpResponseCode(smtpResponseCode);
  }
  const status = httpStatus;
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

  const name = readString(record["name"]);
  if (
    (codeString !== undefined && OUTCOME_UNKNOWN_CODES.has(codeString)) ||
    (name !== undefined && OUTCOME_UNKNOWN_NAMES.has(name)) ||
    /timeout|timed out|socket hang up|aborted/i.test(message)
  ) {
    return {
      category: "PROVIDER_OUTCOME_UNKNOWN",
      providerStatus: status,
      safeProviderMessage: "no definitive provider response; acceptance unknown",
    };
  }

  if (
    (codeString !== undefined && NETWORK_ERROR_CODES.has(codeString)) ||
    /network|ecconn|dns/i.test(message)
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
