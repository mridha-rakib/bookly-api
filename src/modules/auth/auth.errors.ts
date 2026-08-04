import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  EMAIL_ALREADY_REGISTERED: "Email is already registered",
  PORTAL_MISMATCH: "This account belongs to a different portal",
  INVALID_CREDENTIALS: "Invalid email or password",
  INVALID_REGISTRATION_STEP: "Registration step is invalid",
  REGISTRATION_SESSION_EXPIRED: "Registration session has expired",
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
