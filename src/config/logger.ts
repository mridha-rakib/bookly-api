import type { LoggerOptions } from "pino";
import pino from "pino";

import { env } from "./env.js";

const redactPaths = [
  "req.headers.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.cookie",
  "headers.cookie",
  "*.headers.cookie",
  "res.headers.set-cookie",
  "password",
  "*.password",
  "confirmPassword",
  "*.confirmPassword",
  "currentPassword",
  "*.currentPassword",
  "newPassword",
  "*.newPassword",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "otp",
  "*.otp",
  "emailOtp",
  "*.emailOtp",
  "phoneOtp",
  "*.phoneOtp",
  "code",
  "*.code",
  "otpHash",
  "*.otpHash",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "refreshTokenHash",
  "*.refreshTokenHash",
  "set-cookie",
  "*.set-cookie",
  "RESEND_API_KEY",
  "*.RESEND_API_KEY",
  "SMTP_PASS",
  "*.SMTP_PASS",
  "SMTP_USER",
  "*.SMTP_USER",
  "TWILIO_AUTH_TOKEN",
  "*.TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "*.TWILIO_ACCOUNT_SID",
  "TWILIO_VERIFY_SERVICE_SID",
  "*.TWILIO_VERIFY_SERVICE_SID",
  "JWT_ACCESS_TOKEN_SECRET",
  "*.JWT_ACCESS_TOKEN_SECRET",
  "OTP_HASH_SECRET",
  "*.OTP_HASH_SECRET",
  "DUMMY_PHONE_OTP_CODE",
  "*.DUMMY_PHONE_OTP_CODE",
  "SUPER_ADMIN_PASSWORD",
  "*.SUPER_ADMIN_PASSWORD",
  "providerVerificationId",
  "*.providerVerificationId",
  "providerResponse",
  "*.providerResponse",
  "emailVerification",
  "*.emailVerification",
  "phoneVerification",
  "*.phoneVerification",
  "secret",
  "*.secret",
  "mongodbUri",
  "*.mongodbUri",
  "MONGODB_URI",
  "*.MONGODB_URI",
];

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
};

if (env.NODE_ENV === "development") {
  loggerOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  };
}

export const logger = pino(loggerOptions);
