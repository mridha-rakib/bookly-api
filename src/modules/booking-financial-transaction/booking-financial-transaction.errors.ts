import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BOOKING_FINANCIAL_TRANSACTION_DIRECTION_MISMATCH:
    "This transaction type does not permit the given direction",
  BOOKING_FINANCIAL_TRANSACTION_DUPLICATE_IDEMPOTENCY_KEY:
    "A transaction with this idempotency key already exists",
  BOOKING_FINANCIAL_TRANSACTION_RANGE_REQUIRED:
    "A bounded date range is required to list a Business's financial transactions",
  BOOKING_FINANCIAL_TRANSACTION_RANGE_TOO_WIDE: "The requested date range is too wide",
};

export class BookingFinancialTransactionError extends AppError {
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
