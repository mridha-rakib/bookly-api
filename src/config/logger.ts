import type { LoggerOptions } from "pino";
import pino from "pino";

import { env } from "./env.js";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "password",
  "*.password",
  "token",
  "*.token",
  "otp",
  "*.otp",
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
  "TWILIO_AUTH_TOKEN",
  "*.TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "*.TWILIO_ACCOUNT_SID",
  "TWILIO_VERIFY_SERVICE_SID",
  "*.TWILIO_VERIFY_SERVICE_SID",
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
