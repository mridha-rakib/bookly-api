import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  FINANCE_BUSINESS_NOT_FOUND: "Business not found",
  FINANCE_RANGE_REQUIRED: "A period `from`/`to` range is required",
  FINANCE_RANGE_INVALID: "`from` must be before `to`",
  FINANCE_RANGE_TOO_WIDE: "The date range is too wide",
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
