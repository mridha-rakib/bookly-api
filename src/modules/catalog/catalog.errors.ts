import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  CATALOG_BUSINESS_NOT_FOUND: "Business not found",
  CATALOG_SERVICE_NOT_FOUND: "Service not found",
};

export class CatalogError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 404,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
