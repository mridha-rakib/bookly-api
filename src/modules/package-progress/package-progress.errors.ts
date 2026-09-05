import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  PACKAGE_PROGRESS_NOT_FOUND: "Package not found",
  PACKAGE_PROGRESS_NO_SESSIONS_REMAINING: "No sessions remain on this package",
  PACKAGE_PROGRESS_SERVICE_MISMATCH:
    "This package no longer matches an available Package Deal service",
  PACKAGE_PROGRESS_BALANCE_NOT_SETTLED:
    "The remaining Package balance must be settled at the venue before further sessions can be booked",
  PACKAGE_PROGRESS_VOIDED: "This package has been refunded and cancelled",
  PACKAGE_PROGRESS_NOT_ELIGIBLE_FOR_REFUND:
    "This package has already been used and can no longer be fully refunded",
  PACKAGE_PROGRESS_ALREADY_VOIDED: "This package has already been refunded",
};

export class PackageProgressError extends AppError {
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
