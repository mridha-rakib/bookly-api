import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for Customer Facebook authentication. Same shape/convention as
 * CustomerGoogleAuthError. Almost never surfaced to the browser — the callback always redirects
 * to the frontend with a coarse `status` param — but `CUSTOMER_FACEBOOK_AUTH_NOT_CONFIGURED` can
 * reach the `start` endpoint before any redirect exists.
 */
const defaultMessages: Record<string, string> = {
  CUSTOMER_FACEBOOK_AUTH_NOT_CONFIGURED: "Facebook sign-in is not configured on this server",
  CUSTOMER_FACEBOOK_OAUTH_FAILED: "Could not complete Facebook sign-in. Please try again",
  CUSTOMER_FACEBOOK_INVALID_STATE: "This Facebook sign-in request has expired. Please try again",
};

export class CustomerFacebookAuthError extends AppError {
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
