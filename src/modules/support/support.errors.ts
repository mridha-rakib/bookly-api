import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  SUPPORT_TICKET_NOT_FOUND: "Support ticket not found",
  SUPPORT_BOOKING_NOT_FOUND: "Booking not found",
  SUPPORT_BUSINESS_CONTEXT_UNAVAILABLE: "No active Business context is available for this account",
  SUPPORT_INVALID_STATUS_TRANSITION: "This ticket cannot move to the requested status",
  SUPPORT_TICKET_REPLY_NOT_ALLOWED: "This ticket must be reopened before it can be replied to",
  SUPPORT_TICKET_REOPEN_NOT_ALLOWED: "This ticket cannot be reopened from its current status",
  SUPPORT_REFERENCE_GENERATION_FAILED: "Could not generate a unique ticket reference",
};

export class SupportError extends AppError {
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
