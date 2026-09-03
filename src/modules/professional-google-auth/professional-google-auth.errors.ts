import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for Business Owner Google authentication. Same shape/convention as
 * CustomerGoogleAuthError. Almost never surfaced to the browser — the callback always redirects
 * to the frontend with a coarse `status` param — but `PROFESSIONAL_GOOGLE_AUTH_NOT_CONFIGURED`
 * can reach the `start` endpoint before any redirect exists.
 */
const defaultMessages: Record<string, string> = {
  PROFESSIONAL_GOOGLE_AUTH_NOT_CONFIGURED: "Google sign-in is not configured on this server",
  PROFESSIONAL_GOOGLE_OAUTH_FAILED: "Could not complete Google sign-in. Please try again",
  PROFESSIONAL_GOOGLE_INVALID_STATE: "This Google sign-in request has expired. Please try again",
};

export class ProfessionalGoogleAuthError extends AppError {
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
