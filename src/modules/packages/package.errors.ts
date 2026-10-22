import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const messages = {
  PACKAGE_NOT_FOUND: "Package or owned business not found",
  PACKAGE_ITEM_NOT_FOUND: "Package item not found",
  PACKAGE_COMPOSITION_INVALID: "Package composition or grouping is invalid",
  PACKAGE_REVISION_CONFLICT: "Package has changed; refresh before editing",
  PACKAGE_NOT_SELLABLE: "Package dependencies are not ready for publication",
  PACKAGE_INVALID_STATUS_TRANSITION: "Package status transition is not allowed",
} as const;
export class PackageError extends AppError {
  public constructor(code: keyof typeof messages, statusCode = 400, details?: ErrorDetail[]) {
    const message = messages[code];
    super(message, statusCode, { details: details ?? [{ code, message }], expose: true });
  }
}
