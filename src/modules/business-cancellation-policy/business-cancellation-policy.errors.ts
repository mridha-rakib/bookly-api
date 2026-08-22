import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  CANCELLATION_POLICY_BUSINESS_NOT_FOUND: "Business not found",
  CANCELLATION_POLICY_MISSING_TIERS: "A rule is required for every cancellation window",
  CANCELLATION_POLICY_PERCENTAGE_REQUIRED: "A PERCENTAGE cancellation window requires a percentage",
};

export class BusinessCancellationPolicyError extends AppError {
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
