import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  GOOGLE_CALENDAR_NOT_CONFIGURED: "Google Calendar integration is not configured on this server",
  GOOGLE_CALENDAR_ACCESS_DENIED:
    "You do not have access to this business's Google Calendar integration",
  GOOGLE_CALENDAR_INVALID_STATE:
    "This Google Calendar connection link has expired. Please try connecting again",
  GOOGLE_CALENDAR_OAUTH_FAILED:
    "Couldn't complete the Google Calendar connection. Please try again",
};

export class IntegrationError extends AppError {
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
