import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BOOKING_BUSINESS_NOT_FOUND: "Business not found",
  BOOKING_NOT_FOUND: "Booking not found",
  BOOKING_SERVICE_NOT_FOUND: "Service not found for this business",
  BOOKING_SERVICE_ARCHIVED: "This service is archived and can no longer be booked",
  BOOKING_STAFF_NOT_FOUND: "Staff member not found for this business",
  BOOKING_STAFF_NOT_ELIGIBLE: "This staff member is not eligible to provide the selected service",
  BOOKING_CLIENT_NOT_FOUND: "Client not found for this business",
  BOOKING_ADDON_NOT_FOUND: "Add-on not found for this business",
  BOOKING_ADDON_NOT_ASSIGNED_TO_SERVICE: "This add-on is not assigned to the selected service",
  BOOKING_INVALID_PLATFORM_FEE_BASIS:
    "Platform fee basis must be a non-negative integer amount in cents",
  BOOKING_REFERENCE_GENERATION_FAILED: "Could not generate a unique booking reference",
  BOOKING_FULFILMENT_MODE_MISMATCH:
    "Booking fulfilment mode must match the Business's own configured fulfilment mode",
  BOOKING_FULFILMENT_SNAPSHOT_INVALID:
    "An AT_BUSINESS_LOCATION booking must snapshot the business location (and no travel address); a TRAVEL_TO_CUSTOMER booking must snapshot a travel address (and no business location)",
  BOOKING_MANUAL_FEE_NOT_ZERO:
    "A Manual booking must have zero Bookly platform fee and zero deposit",
};

export class BookingError extends AppError {
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
