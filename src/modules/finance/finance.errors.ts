import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  FINANCE_BUSINESS_NOT_FOUND: "Business not found",
  FINANCE_RANGE_REQUIRED: "A period `from`/`to` range is required",
  FINANCE_RANGE_INVALID: "`from` must be before `to`",
  FINANCE_RANGE_TOO_WIDE: "The date range is too wide",
  FINANCE_NO_ELIGIBLE_PAYABLE: "This Business has no pending payable balance to pay out right now",
  /** Raised by BusinessPayoutService.executePayout when the Business has no configured
   * BusinessPayoutDestination at confirm time — BEFORE any ledger row is claimed or mutated.
   * Deliberately says nothing about the Business's balance or its bank details. */
  PAYOUT_DESTINATION_NOT_CONFIGURED:
    "This Business has not configured payout bank details yet — a payout cannot be recorded",
  FINANCE_PAYOUT_CONFLICT:
    "This Business's pending balance changed while processing the payout — please try again",
};

export class FinanceError extends AppError {
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
