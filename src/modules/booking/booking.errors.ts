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
  BOOKING_INVALID_DEPOSIT_BASIS:
    "Booking deposit basis must be a non-negative integer amount in cents",
  BOOKING_REFERENCE_GENERATION_FAILED: "Could not generate a unique booking reference",
  BOOKING_FULFILMENT_MODE_MISMATCH:
    "Booking fulfilment mode must match the Business's own configured fulfilment mode",
  BOOKING_FULFILMENT_SNAPSHOT_INVALID:
    "An AT_BUSINESS_LOCATION booking must snapshot the business location (and no travel address); a TRAVEL_TO_CUSTOMER booking must snapshot a travel address (and no business location)",
  BOOKING_MANUAL_FEE_NOT_ZERO:
    "A Manual booking must have zero Bookly platform fee and zero deposit",
  BOOKING_RANGE_INVALID: "The date range's start must be before its end",
  BOOKING_RANGE_TOO_WIDE: "The requested date range is too wide",
  BOOKING_NO_SERVICE_LINES: "A booking must include at least one service line",
  BOOKING_PACKAGE_SERVICE_NOT_SUPPORTED_YET:
    "Booking a package service is not yet supported — package remaining-session tracking is not built yet",
  BOOKING_PRICING_INPUT_INVALID: "The booked quantity for this service line is invalid",
  BOOKING_SCHEDULE_INVALID: "The requested booking time is invalid",
  BOOKING_CLIENT_CROSS_BUSINESS: "This client does not belong to the selected business",
  BOOKING_CUSTOMER_CLIENT_PROFILE_REQUIRED:
    "This business does not yet have a client record for you, and self-service sign-up is only available when a delivery address is provided as part of the booking (travel bookings). Please contact the business directly for your first booking, or provide a travel address.",
  BOOKING_CUSTOMER_CLIENT_CONTACT_CONFLICT:
    "A client record with matching contact details already exists at this business but is not linked to your account. Please contact the business directly to complete your first booking.",
  BOOKING_IDEMPOTENCY_KEY_REQUIRED: "An idempotency key is required to create a booking",
  BOOKING_TRANSACTION_UNAVAILABLE:
    "The database does not support the transactions this operation requires",
  BOOKING_INVALID_STATUS_TRANSITION: "This booking cannot move to the requested status right now",
  BOOKING_ALREADY_IN_TERMINAL_STATUS: "This booking has already reached a final status",
  BOOKING_RESCHEDULE_LIMIT_REACHED:
    "This booking has already been rescheduled the maximum number of times",
  BOOKING_NOT_OWNED_BY_CUSTOMER: "This booking does not belong to you",
  BOOKING_CANCELLATION_POLICY_NOT_AVAILABLE:
    "A cancellation policy was not on file for this booking at creation time",
  BOOKING_NO_WAIVABLE_FEE:
    "This booking has no outstanding no-show or cancellation fee to waive right now",
  BOOKING_FEE_ALREADY_CHARGED: "This fee has already been charged and can no longer be waived",
  BOOKING_FEE_CHARGE_IN_PROGRESS:
    "A charge for this fee is already in progress — please try again shortly",
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
