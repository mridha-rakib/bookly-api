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
  /** Finance Gap 02 — the eligible balance differs from the amount/snapshot the Super Admin
   * confirmed. Nothing was recorded. */
  FINANCE_PAYOUT_SNAPSHOT_CHANGED:
    "This Business's payable balance changed after you reviewed it — nothing was recorded. Review the current amount before recording the transfer.",
  // P6 — Super Admin provider-reversal support surface
  FINANCE_DISPUTE_NOT_FOUND: "Dispute not found",
  FINANCE_WEBHOOK_EVENT_NOT_FOUND: "Webhook event not found",
  FINANCE_WEBHOOK_EVENT_NOT_REPLAYABLE:
    "Only a FAILED webhook event with a stored payload can be replayed",
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
