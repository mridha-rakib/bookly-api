import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  STAFF_BUSINESS_NOT_FOUND: "Business not found",
  STAFF_BUSINESS_ACCESS_DENIED: "You do not have access to manage staff for this business",
  STAFF_NOT_FOUND: "Staff member not found",
  STAFF_EMAIL_ALREADY_EXISTS: "An account with this email already exists",
  STAFF_ROLE_NOT_ALLOWED: "That role cannot be assigned to a staff member",
  STAFF_PHONE_INVALID: "Enter a valid phone number, including the country code",
  STAFF_OWNER_ROW_NOT_EDITABLE: "The business owner cannot be edited or removed from Staff",
  STAFF_TRANSACTION_UNAVAILABLE: "Staff changes cannot be completed right now. Please try again.",
  STAFF_TEMP_PASSWORD_EMAIL_FAILED:
    "The staff account was created, but the welcome email could not be sent. Please ask them to use forgot-password once that is available, or contact support.",
  STAFF_REMOVED_CANNOT_EDIT: "This staff member has been removed and can no longer be edited",
  STAFF_TIME_OFF_NOT_FOUND: "That time off entry was not found",
  STAFF_TIME_OFF_OVERLAP: "This time off overlaps with an existing entry for this staff member",
};

export class StaffError extends AppError {
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
