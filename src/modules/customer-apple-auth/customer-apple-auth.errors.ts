import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for Customer "Continue with Apple". Same shape/convention as
 * CustomerFacebookAuthError. Almost never surfaced to the browser — the callback always redirects
 * to the frontend with a coarse `status` param — but `CUSTOMER_APPLE_AUTH_NOT_CONFIGURED` can
 * reach the `start` endpoint before any redirect exists.
 */
const defaultMessages: Record<string, string> = {
  CUSTOMER_APPLE_AUTH_NOT_CONFIGURED: "Apple sign-in is not configured on this server",
  CUSTOMER_APPLE_OAUTH_FAILED: "Could not complete Apple sign-in. Please try again",
  CUSTOMER_APPLE_INVALID_STATE: "This Apple sign-in request has expired. Please try again",
};

export class CustomerAppleAuthError extends AppError {
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
