import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for Business Owner "Continue with Apple". Same shape/convention as
 * ProfessionalFacebookAuthError.
 */
const defaultMessages: Record<string, string> = {
  PROFESSIONAL_APPLE_AUTH_NOT_CONFIGURED: "Apple sign-in is not configured on this server",
  PROFESSIONAL_APPLE_OAUTH_FAILED: "Could not complete Apple sign-in. Please try again",
  PROFESSIONAL_APPLE_INVALID_STATE: "This Apple sign-in request has expired. Please try again",
};

export class ProfessionalAppleAuthError extends AppError {
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
