import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  CLIENT_BUSINESS_NOT_FOUND: "Business not found",
  CLIENT_NOT_FOUND: "Client not found",
  CLIENT_ALREADY_ARCHIVED: "This client is already archived",
  CLIENT_NOT_ARCHIVED: "This client is not archived",
  CLIENT_PHONE_INVALID: "Enter a valid phone number, including the country code",
  CLIENT_DUPLICATE_EMAIL:
    "A client with this email already exists for this business. If they were archived, restore them instead of creating a new record.",
  CLIENT_DUPLICATE_PHONE:
    "A client with this phone number already exists for this business. If they were archived, restore them instead of creating a new record.",
  CLIENT_IDENTITY_LOCKED:
    "Name, email, phone, and gender are managed by the customer's own Bookly account and cannot be edited here",
};

export class ClientError extends AppError {
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
