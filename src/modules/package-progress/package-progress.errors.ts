import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  PACKAGE_PROGRESS_UNRESOLVED_APPOINTMENT:
    "Resolve started appointments and pending no-shows before cancelling the package",
  PACKAGE_PROGRESS_NOT_FOUND: "Package not found",
  PACKAGE_PROGRESS_NO_SESSIONS_REMAINING: "No sessions remain on this package",
  PACKAGE_PROGRESS_SERVICE_MISMATCH:
    "This package no longer matches an available Package Deal service",
  PACKAGE_PROGRESS_BALANCE_NOT_SETTLED:
    "The remaining Package balance must be settled at the venue before further sessions can be booked",
  PACKAGE_PROGRESS_VOIDED: "This package has been cancelled",
  PACKAGE_PROGRESS_NOT_ELIGIBLE_FOR_REFUND:
    "This package has already been used and can no longer be fully refunded",
  PACKAGE_PROGRESS_ALREADY_VOIDED: "This package has already been cancelled",
  PACKAGE_BALANCE_CHANGED:
    "The package balance changed since it was displayed. Refresh and review the current outstanding amount",
  PACKAGE_BALANCE_ALREADY_SETTLED: "The package balance is already recorded as paid in full",
  PACKAGE_BALANCE_INVALID_AMOUNT:
    "Enter a whole amount greater than zero and less than the outstanding balance, or record the full balance",
  PACKAGE_BALANCE_ORIGIN_NOT_FINAL:
    "Record the balance when completing the purchase appointment, or after it has been cancelled or resolved",
  PACKAGE_BALANCE_DECISION_REQUIRED:
    "The online payment for this package purchase was refunded or disputed, so the outstanding balance cannot be recorded here",
  PACKAGE_BALANCE_IDEMPOTENCY_CONFLICT:
    "This payment request was already used for a different payment. Refresh and try again",
  PACKAGE_BALANCE_UNAVAILABLE: "Package balance recording is temporarily unavailable",
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
