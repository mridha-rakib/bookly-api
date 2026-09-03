import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for Google account linking. Same shape/convention as IntegrationError — extends
 * the shared AppError so the global error handler renders it in the standard envelope, and every
 * message is a static, safe string (the OAuth callback never surfaces these to the browser
 * anyway; it redirects with `result=error` only).
 */
const defaultMessages: Record<string, string> = {
  LINKED_ACCOUNT_NOT_CONFIGURED: "Google account linking is not configured on this server",
  LINKED_ACCOUNT_INVALID_STATE:
    "This Google account link request has expired. Please try connecting again",
  LINKED_ACCOUNT_OAUTH_FAILED: "Couldn't complete linking your Google account. Please try again",
  LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE:
    "This Google account is already linked to another Bookly account",
  LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED:
    "A Google account is already linked to your Bookly account. Unlink it first",
  LINKED_ACCOUNT_NOT_FOUND: "No linked Google account was found",
  LINKED_ACCOUNT_LAST_CREDENTIAL: "You can't unlink your only sign-in method. Set a password first",
};

export class LinkedAccountError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 400,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
