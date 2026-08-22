import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  AVAILABILITY_BUSINESS_NOT_FOUND: "Business not found",
  AVAILABILITY_SERVICE_NOT_FOUND: "Service not found for this business",
  AVAILABILITY_STAFF_NOT_FOUND: "Staff member not found for this business",
  AVAILABILITY_STAFF_NOT_ELIGIBLE:
    "This staff member is not eligible to provide the selected service",
  AVAILABILITY_RANGE_INVALID: "The date range's start must be before its end",
  AVAILABILITY_RANGE_TOO_WIDE: "The requested date range is too wide",
  AVAILABILITY_CITY_REQUIRED: "A customer city is required for a travel-to-customer service",
  AVAILABILITY_CITY_NOT_SERVED: "This business does not serve the selected city",
  AVAILABILITY_PARTY_SIZE_INVALID: "Party size is invalid for this service",
  AVAILABILITY_SLOT_NOT_BOOKABLE:
    "This staff member is not available for the requested time — it is outside their schedule, on a day off, or (for a fixed-schedule service) not one of its configured times",
};

export class AvailabilityError extends AppError {
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
