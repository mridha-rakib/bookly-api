import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  ADDON_BUSINESS_NOT_FOUND: "Business not found",
  ADDON_NOT_FOUND: "Add-on not found",
  ADDON_ALREADY_ARCHIVED: "This add-on is already archived",
  ADDON_NOT_ARCHIVED: "This add-on is not archived",
  ADDON_DRAFT_CANNOT_TOGGLE:
    "This add-on is still a draft — save it as Active or Inactive from the edit form first",
  ADDON_CATEGORY_NOT_FOUND: "Service category not found or not available for this business",
  ADDON_SERVICE_INVALID: "One or more assigned services do not belong to this business",
  ADDON_SERVICE_ARCHIVED: "Cannot assign an add-on to a newly selected archived service",
};

export class AddonError extends AppError {
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
