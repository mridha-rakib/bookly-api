import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  SERVICE_BUSINESS_NOT_FOUND: "Business not found",
  SERVICE_NOT_FOUND: "Service not found",
  SERVICE_ALREADY_ARCHIVED: "This service is already archived",
  SERVICE_NOT_ARCHIVED: "This service is not archived",
  SERVICE_DRAFT_CANNOT_TOGGLE:
    "This service is still a draft — save it as Active or Inactive from the edit form first",
  SERVICE_CATEGORY_NOT_FOUND: "Service category not found or not available for this business",
  SERVICE_CATEGORY_ALREADY_EXISTS: "A service category with this name already exists",
  SERVICE_SUBCATEGORY_INVALID: "Sub category must be one of this business's selected subcategories",
  SERVICE_STAFF_INVALID: "One or more assigned staff members do not belong to this business",
  SERVICE_CITY_NOT_SERVED: "One or more selected cities are not enabled in Travel Settings",
  SERVICE_CITIES_NOT_APPLICABLE:
    "This business does not travel to customers, so cities served cannot be set",
};

export class ServiceError extends AppError {
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
