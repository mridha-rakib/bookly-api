import "dotenv/config";

import { isIP } from "node:net";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development");
const rawNodeEnv = nodeEnvSchema.parse(process.env["NODE_ENV"] ?? "development");
const emailProviderSchema = z
  .enum(["smtp", "resend"])
  .default(rawNodeEnv === "production" ? "resend" : "smtp");
const rawEmailProvider = emailProviderSchema.parse(process.env["EMAIL_PROVIDER"] || undefined);
const phoneOtpProviderSchema = z
  .enum(["dummy", "twilio"])
  .default(rawNodeEnv === "production" ? "twilio" : "dummy");
const rawPhoneOtpProvider = phoneOtpProviderSchema.parse(process.env["OTP_PROVIDER"] || undefined);
const storageProviderSchema = z.enum(["s3"]).default("s3");
const rawStorageProvider = storageProviderSchema.parse(
  process.env["STORAGE_PROVIDER"] || undefined,
);

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const optionalBooleanString = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const docsEnabledSchema = z
  .enum(["true", "false", "1", "0"])
  .default(rawNodeEnv === "production" ? "false" : "true")
  .transform((value) => value === "true" || value === "1");

const corsOriginsSchema = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .superRefine((origins, context) => {
    if (origins.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one CORS origin must be configured",
      });
    }

    if (rawNodeEnv === "production" && origins.includes("*")) {
      context.addIssue({
        code: "custom",
        message: "Wildcard CORS origins are not allowed in production",
      });
    }
  });

const mongodbUriSchema = z.preprocess(
  (value) => {
    if (rawNodeEnv === "test" && (value === undefined || value === "")) {
      return "mongodb://127.0.0.1:27017/bookly-test";
    }

    return value;
  },
  z
    .string()
    .min(1, "MONGODB_URI is required")
    .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must start with mongodb:// or mongodb+srv://"),
);

const mongodbDnsServersSchema = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean),
  )
  .superRefine((servers, context) => {
    for (const server of servers) {
      if (isIP(server) === 0) {
        context.addIssue({
          code: "custom",
          message: "MONGODB_DNS_SERVERS must contain only comma-separated IP addresses",
        });
      }
    }
  });

const optionalProductionRequiredString = (name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (rawNodeEnv === "production" && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required in production`,
        });
      }
    });

const optionalProviderRequiredString = (provider: "smtp" | "resend", name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (rawEmailProvider === provider && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required when EMAIL_PROVIDER=${provider}`,
        });
      }
    });

const optionalPhoneProviderRequiredString = (provider: "dummy" | "twilio", name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (rawPhoneOtpProvider === provider && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required when OTP_PROVIDER=${provider}`,
        });
      }
    });

const optionalStorageRequiredString = (name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (rawNodeEnv === "production" && rawStorageProvider === "s3" && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required when STORAGE_PROVIDER=s3 in production`,
        });
      }
    });

const jwtSecretSchema = z
  .string()
  .default(
    rawNodeEnv === "production"
      ? ""
      : "development-only-change-me-bookly-access-token-secret-minimum-32-chars",
  )
  .superRefine((value, context) => {
    if (value.length < 32) {
      context.addIssue({
        code: "custom",
        message: "JWT_ACCESS_TOKEN_SECRET must be at least 32 characters",
      });
    }

    if (rawNodeEnv === "production" && value.includes("development-only")) {
      context.addIssue({
        code: "custom",
        message: "JWT_ACCESS_TOKEN_SECRET must be explicit in production",
      });
    }
  });

const otpHashSecretSchema = z
  .string()
  .default(
    rawNodeEnv === "production"
      ? ""
      : "development-only-change-me-bookly-otp-hash-secret-minimum-32-chars",
  )
  .superRefine((value, context) => {
    if (value.length < 32) {
      context.addIssue({
        code: "custom",
        message: "OTP_HASH_SECRET must be at least 32 characters",
      });
    }

    if (rawNodeEnv === "production" && value.includes("development-only")) {
      context.addIssue({
        code: "custom",
        message: "OTP_HASH_SECRET must be explicit in production",
      });
    }
  });

export const env = createEnv({
  server: {
    NODE_ENV: nodeEnvSchema,
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    APP_NAME: z.string().min(1).default("Bookly API"),
    API_VERSION: z
      .string()
      .regex(/^v\d+$/)
      .default("v1"),
    MONGODB_URI: mongodbUriSchema,
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default(rawNodeEnv === "development" ? "debug" : "info"),
    MONGODB_DNS_SERVERS: mongodbDnsServersSchema,
    CORS_ORIGINS: corsOriginsSchema,
    RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    API_DOCS_ENABLED: docsEnabledSchema,
    TRUST_PROXY: booleanString,
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    JWT_ACCESS_TOKEN_SECRET: jwtSecretSchema,
    JWT_ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    AUTH_COOKIE_NAME: z.string().min(1).default("bookly_refresh_token"),
    AUTH_COOKIE_DOMAIN: z.string().optional(),
    AUTH_COOKIE_PATH: z.string().min(1).default("/api/v1/auth"),
    AUTH_COOKIE_SECURE: optionalBooleanString.default(rawNodeEnv === "production"),
    AUTH_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    OTP_LENGTH: z.coerce.number().int().min(4).max(4).default(4),
    OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
    OTP_MAX_VERIFICATION_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_MAX_RESENDS_PER_HOUR: z.coerce.number().int().positive().default(5),
    OTP_HASH_SECRET: otpHashSecretSchema,
    REGISTRATION_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    EMAIL_PROVIDER: emailProviderSchema,
    EMAIL_FROM: optionalProviderRequiredString("smtp", "EMAIL_FROM"),
    EMAIL_FROM_NAME: z
      .string()
      .min(1)
      .default(process.env["APP_NAME"] ?? "Bookly"),
    SMTP_HOST: optionalProviderRequiredString("smtp", "SMTP_HOST"),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
    SMTP_SECURE: booleanString,
    SMTP_USER: optionalProviderRequiredString("smtp", "SMTP_USER"),
    SMTP_PASS: optionalProviderRequiredString("smtp", "SMTP_PASS"),
    RESEND_API_KEY:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString("resend", "RESEND_API_KEY")
        : optionalProductionRequiredString("RESEND_API_KEY"),
    RESEND_FROM_EMAIL:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString("resend", "RESEND_FROM_EMAIL")
        : optionalProductionRequiredString("RESEND_FROM_EMAIL"),
    RESEND_FROM_NAME:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString("resend", "RESEND_FROM_NAME")
        : optionalProductionRequiredString("RESEND_FROM_NAME"),
    OTP_PROVIDER: phoneOtpProviderSchema.superRefine((value, context) => {
      if (rawNodeEnv === "production" && value === "dummy") {
        context.addIssue({
          code: "custom",
          message: "OTP_PROVIDER=dummy is not allowed in production",
        });
      }
    }),
    DUMMY_PHONE_OTP_CODE: z
      .string()
      .optional()
      .superRefine((value, context) => {
        if (rawPhoneOtpProvider === "dummy" && !value) {
          context.addIssue({
            code: "custom",
            message: "DUMMY_PHONE_OTP_CODE is required when OTP_PROVIDER=dummy",
          });
        }

        if (value && !/^\d{4}$/.test(value)) {
          context.addIssue({
            code: "custom",
            message: "DUMMY_PHONE_OTP_CODE must be exactly 4 digits",
          });
        }
      }),
    TWILIO_ACCOUNT_SID:
      rawPhoneOtpProvider === "twilio"
        ? optionalPhoneProviderRequiredString("twilio", "TWILIO_ACCOUNT_SID")
        : optionalProductionRequiredString("TWILIO_ACCOUNT_SID"),
    TWILIO_AUTH_TOKEN:
      rawPhoneOtpProvider === "twilio"
        ? optionalPhoneProviderRequiredString("twilio", "TWILIO_AUTH_TOKEN")
        : optionalProductionRequiredString("TWILIO_AUTH_TOKEN"),
    TWILIO_VERIFY_SERVICE_SID:
      rawPhoneOtpProvider === "twilio"
        ? optionalPhoneProviderRequiredString("twilio", "TWILIO_VERIFY_SERVICE_SID")
        : optionalProductionRequiredString("TWILIO_VERIFY_SERVICE_SID"),
    STORAGE_PROVIDER: storageProviderSchema,
    S3_ENDPOINT: optionalStorageRequiredString("S3_ENDPOINT"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: optionalStorageRequiredString("S3_BUCKET"),
    S3_ACCESS_KEY_ID: optionalStorageRequiredString("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: optionalStorageRequiredString("S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: optionalBooleanString.default(true),
    S3_PUBLIC_BASE_URL: z.string().url().optional(),
    BUSINESS_MEDIA_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    // Governs the Staff avatar upload endpoint only; reuses BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS
    // for read URLs since the TTL is baked into the shared S3 client at construction time.
    STAFF_AVATAR_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    // Stripe: required in production (real payment flows), optional in development/test — no
    // real Stripe TEST credentials exist in this environment as of Batch 4 (confirmed by
    // inspecting every .env/.env.example file in the repo; none define STRIPE_*). The payment
    // gateway abstraction (see payment/stripe-payment-gateway.ts) throws a clear
    // PAYMENT_PROVIDER_NOT_CONFIGURED domain error at the moment a real charge is attempted
    // without a key, rather than crashing app boot — matching this codebase's existing
    // provider-optionality convention (OTP_PROVIDER=dummy, RESEND_API_KEY unset outside
    // EMAIL_PROVIDER=resend, etc.).
    STRIPE_SECRET_KEY: optionalProductionRequiredString("STRIPE_SECRET_KEY"),
    STRIPE_PUBLISHABLE_KEY: optionalProductionRequiredString("STRIPE_PUBLISHABLE_KEY"),
    STRIPE_WEBHOOK_SECRET: optionalProductionRequiredString("STRIPE_WEBHOOK_SECRET"),
    NO_SHOW_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    NO_SHOW_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    SUPER_ADMIN_EMAIL: z.string().email().optional(),
    SUPER_ADMIN_PASSWORD: z.string().min(6).optional(),
    SUPER_ADMIN_FIRST_NAME: z.string().min(1).optional(),
    SUPER_ADMIN_LAST_NAME: z.string().min(1).optional(),
    ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(65_536),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
    AUTH_ENTRY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    AUTH_OTP_SEND_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_OTP_VERIFY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    AUTH_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    BUSINESS_LINK_OTP_SEND_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    BUSINESS_LINK_OTP_SEND_PER_EMAIL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    // Batch 15B — the public Contact form's message recipient. Optional: when unset, the Contact
    // flow falls back to the same EMAIL_FROM/RESEND_FROM_EMAIL address the OTP provider already
    // sends FROM (see support/contact.controller.ts) rather than requiring a brand-new mandatory
    // env var just for this narrow purpose.
    SUPPORT_CONTACT_INBOX_EMAIL: z.string().email().optional(),
    CONTACT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: (issues) => {
    const details = issues
      .map((issue) => `${issue.path?.join(".") ?? "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  },
});
