import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  EMAIL_ALREADY_REGISTERED: "Email is already registered",
  PORTAL_MISMATCH: "This account belongs to a different portal",
  INVALID_CREDENTIALS: "Invalid email or password",
  INVALID_REGISTRATION_STEP: "Registration step is invalid",
  REGISTRATION_SESSION_EXPIRED: "Registration session has expired",
  REGISTRATION_ALREADY_COMPLETED: "Registration is already completed",
  OTP_INVALID: "Verification code is invalid",
  OTP_EXPIRED: "Verification code has expired",
  OTP_ATTEMPTS_EXCEEDED: "Verification attempt limit exceeded",
  OTP_RESEND_COOLDOWN: "Please wait before requesting another code",
  OTP_RESEND_LIMIT_EXCEEDED: "Verification resend limit exceeded",
  EMAIL_NOT_VERIFIED: "Email is not verified",
  PHONE_NOT_VERIFIED: "Phone number is not verified",
  USER_SUSPENDED: "User account is suspended",
  BUSINESS_PENDING_APPROVAL: "Business is pending approval",
  BUSINESS_SUSPENDED: "Business is suspended",
  SESSION_EXPIRED: "Session has expired",
  REFRESH_TOKEN_REUSED: "Refresh token reuse detected",
  PROVIDER_NOT_CONFIGURED: "Verification provider is not configured",
  REGISTRATION_COMPLETION_FAILED: "Registration completion failed",
  DATABASE_TRANSACTION_UNAVAILABLE: "Database transaction support is unavailable",
  OTP_DELIVERY_FAILED: "Verification code delivery failed",
  OTP_VERIFICATION_FAILED: "Verification check failed",
  PROVIDER_RATE_LIMITED: "Verification provider rate limit exceeded",
  INVALID_CURRENT_PASSWORD: "Current password is incorrect",
  PHONE_ALREADY_REGISTERED: "This phone number is already registered to another account",
  CONTACT_UNCHANGED: "That's already your current email or phone number",
  CONTACT_CHANGE_NOT_FOUND:
    "No pending change request was found. Please request a new verification code",
};

export class AuthError extends AppError {
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
