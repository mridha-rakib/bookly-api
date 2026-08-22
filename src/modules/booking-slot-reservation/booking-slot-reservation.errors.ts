import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BOOKING_SLOT_RESERVATION_CONFLICT: "This time slot is no longer available",
  BOOKING_SLOT_RESERVATION_CAPACITY_UNAVAILABLE: "Not enough remaining capacity for this slot",
  BOOKING_SLOT_RESERVATION_NOT_FOUND: "Reservation not found",
  BOOKING_SLOT_RESERVATION_INVALID_INTERVAL: "Reservation interval is invalid",
  BOOKING_SLOT_RESERVATION_CROSSES_MIDNIGHT:
    "A reservation cannot cross a business-local midnight boundary",
  BOOKING_SLOT_RESERVATION_RELEASE_INVALID:
    "This reservation cannot be released with the given party size",
};

export class BookingSlotReservationError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 409,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
