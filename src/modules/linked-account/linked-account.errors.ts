import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for external account linking. Same shape/convention as IntegrationError — extends
 * the shared AppError so the global error handler renders it in the standard envelope, and every
 * message is a static, safe string (the OAuth callback never surfaces these to the browser
 * anyway; it redirects with `result=error` only).
 *
 * The message templates take the provider display name so Google and Facebook share one code set
 * (`LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE`, …). The constructor's `provider` param defaults to
 * `"Google"`, so every pre-existing Google call site produces byte-identical copy.
 */
const messageTemplates: Record<string, (provider: string) => string> = {
  LINKED_ACCOUNT_NOT_CONFIGURED: (p) => `${p} account linking is not configured on this server`,
  LINKED_ACCOUNT_INVALID_STATE: (p) =>
    `This ${p} account link request has expired. Please try connecting again`,
  LINKED_ACCOUNT_OAUTH_FAILED: (p) =>
    `Couldn't complete linking your ${p} account. Please try again`,
  LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE: (p) =>
    `This ${p} account is already linked to another Bookly account`,
  LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED: (p) =>
    `A ${p} account is already linked to your Bookly account. Unlink it first`,
  LINKED_ACCOUNT_NOT_FOUND: (p) => `No linked ${p} account was found`,
  LINKED_ACCOUNT_LAST_CREDENTIAL: () =>
    "You can't unlink your only sign-in method. Set a password first",
};

export class LinkedAccountError extends AppError {
  public constructor(
    code: keyof typeof messageTemplates,
    statusCode = 400,
    details?: ErrorDetail[],
    provider = "Google",
  ) {
    const message = messageTemplates[code]?.(provider) ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
