import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  TAX_CALCULATION_FAILED: "The tax amount could not be calculated — please try again",
};

/**
 * Mirrors PaymentError's shape exactly (see payment.errors.ts). A tax-calculation failure must
 * never be swallowed into a guessed `taxCents = 0` (locked rule: "never invent VAT to
 * compensate") — this is the explicit, canonical backend error a positive-charge tax failure
 * throws instead.
 */
export class TaxError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 502,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
