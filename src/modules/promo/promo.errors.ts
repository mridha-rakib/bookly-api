import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  PROMO_NOT_FOUND: "Promo not found",
  PROMO_CODE_ALREADY_EXISTS: "A promo with this code already exists",
  PROMO_INVALID: "This promo code is not valid",
  PROMO_NOT_STARTED: "This promo code is not active yet",
  PROMO_EXPIRED: "This promo code has expired",
  PROMO_DEACTIVATED: "This promo code is no longer active",
  PROMO_NOT_ELIGIBLE_FOR_BUSINESS: "This promo code is not valid for this business",
  PROMO_FIRST_BOOKING_ONLY: "This promo code is only valid for a first booking with this business",
  PROMO_USAGE_LIMIT_REACHED: "This promo code has reached its usage limit",
  PROMO_PER_USER_LIMIT_REACHED: "You have already used this promo code the maximum number of times",
  PROMO_INVALID_STATUS_TRANSITION: "This promo cannot move to the requested status",
  PROMO_HAS_REDEMPTIONS: "This promo has redemption history and cannot be deleted",
};

export class PromoError extends AppError {
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
