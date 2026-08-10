import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BUSINESS_NOT_FOUND: "Business not found",
  BUSINESS_ACCESS_DENIED: "You do not have access to this business",
  BUSINESS_ACCOUNT_NOT_FOUND: "No Business Owner account was found for that email",
  CANNOT_LINK_OWN_BUSINESS: "You cannot link your own business",
  BUSINESS_ALREADY_LINKED: "This business is already linked to your account",
  BUSINESS_LINK_NOT_FOUND: "Business link not found",
  BUSINESS_LINK_VERIFICATION_NOT_FOUND: "Verification request not found or expired",
  BUSINESS_LINK_VERIFICATION_CONSUMED: "This verification code has already been used",
};

export class BusinessError extends AppError {
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
