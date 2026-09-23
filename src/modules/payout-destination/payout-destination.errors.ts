import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Same shape as FinanceError/AuthError/IntegrationError — a thin AppError subclass with a
 * code→default-message map, `expose: true`, and a caller-supplied status code.
 *
 * Every message here is deliberately generic: none of them distinguishes "this Business does not
 * exist" from "this Business is not yours" (both are PAYOUT_DESTINATION_BUSINESS_NOT_FOUND/404,
 * mirroring FinanceService.requireOwnedFinanceBusiness's existing precedent), and none leaks
 * whether a destination exists to a caller who is not allowed to see it.
 */
const defaultMessages: Record<string, string> = {
  PAYOUT_DESTINATION_BUSINESS_NOT_FOUND: "Business not found",
  PAYOUT_DESTINATION_NOT_CONFIGURED: "No payout bank details are configured for this Business",
  PAYOUT_DESTINATION_IBAN_INVALID: "Please enter a valid IBAN",
  PAYOUT_DESTINATION_IBAN_COUNTRY_UNSUPPORTED: "This IBAN's country is not supported",
  /** Fail-closed: a missing key version, an unknown key version, a tampered ciphertext/auth tag,
   * or a wrong-AAD ciphertext all surface as this ONE 500-class error — never a partial or
   * malformed IBAN, and never anything that distinguishes the four causes to a caller. */
  PAYOUT_DESTINATION_DECRYPT_FAILED: "Payout bank details could not be read",
  PAYOUT_DESTINATION_ENCRYPTION_NOT_CONFIGURED: "Payout bank details storage is not configured",
  PAYOUT_DESTINATION_STEP_UP_REQUIRED:
    "Please confirm your identity before changing payout bank details",
  PAYOUT_DESTINATION_STEP_UP_INVALID:
    "That confirmation is no longer valid. Please request a new code",
  PAYOUT_DESTINATION_STEP_UP_NOT_APPLICABLE:
    "This account signs in with a password — confirm with your current password instead",
};

export class PayoutDestinationError extends AppError {
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
