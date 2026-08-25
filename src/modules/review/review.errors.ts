import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  REVIEW_BOOKING_NOT_FOUND: "Booking not found",
  BOOKING_NOT_REVIEW_ELIGIBLE: "This booking is not eligible for a review",
  BOOKING_ALREADY_REVIEWED: "This booking has already been reviewed",
  REVIEW_NOT_FOUND: "Review not found",
  REVIEW_EDIT_WINDOW_EXPIRED: "The 14-day edit window for this review has expired",
  REVIEW_INVALID_STATUS_TRANSITION: "This review cannot move to the requested status",
};

export class ReviewError extends AppError {
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
