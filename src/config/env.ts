import "dotenv/config";

import { isIP } from "node:net";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development");
const rawNodeEnv = nodeEnvSchema.parse(process.env["NODE_ENV"] ?? "development");
const emailProviderSchema = z
  .enum(["smtp", "resend", "sendgrid"])
  // Production default is SendGrid — the provider this project actually uses. A prod deploy that
  // forgets to set EMAIL_PROVIDER then still fails fast on a missing SENDGRID_API_KEY / EMAIL_FROM
  // rather than silently selecting an unconfigured transport.
  .default(rawNodeEnv === "production" ? "sendgrid" : "smtp");
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

// Resolved the same way the AUTH_COOKIE_SECURE schema does (explicit value wins, otherwise
// defaults to "production"). Needed at module scope so AUTH_COOKIE_SAME_SITE can cross-validate
// against it — browsers reject `SameSite=None` unless the cookie is also `Secure`.
const rawAuthCookieSecure =
  process.env["AUTH_COOKIE_SECURE"] !== undefined
    ? ["true", "1"].includes(process.env["AUTH_COOKIE_SECURE"])
    : rawNodeEnv === "production";

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

/**
 * A URL env var that is OPTIONAL in development / test but REQUIRED (and still a valid URL) in
 * production. Used for the backend's own OAuth callback URLs — GOOGLE_CLIENT_ID/SECRET are
 * already production-required, so a Google OAuth client always exists in production and every
 * flow's redirect URI must be configured too; without this a flow silently 302s the browser
 * back with `status=error` and nothing signals the misconfiguration at boot.
 */
const optionalProductionRequiredUrl = (name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (value !== undefined) {
        try {
          new URL(value);
        } catch {
          context.addIssue({ code: "custom", message: `${name} must be a valid URL` });
        }
      }
      if (rawNodeEnv === "production" && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required in production`,
        });
      }
    });

const optionalProviderRequiredString = (
  providers: ReadonlyArray<"smtp" | "resend" | "sendgrid">,
  name: string,
) =>
  z
    .string()
    .optional()
    .superRefine((value, context) => {
      if (providers.includes(rawEmailProvider) && !value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required when EMAIL_PROVIDER=${providers.join("|")}`,
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
    // A cookie `Domain` attribute is a BARE host — no scheme, port, path or spaces. e.g.
    // "bookly.cy" (host-only) or ".bookly.cy" (shared across subdomains). Leave blank for a
    // host-only cookie (correct for local dev). A URL here (e.g. "http://localhost:3001") makes
    // res.cookie() throw at request time → every auth endpoint 500s; reject it up front instead.
    AUTH_COOKIE_DOMAIN: z
      .string()
      .optional()
      .superRefine((value, context) => {
        if (value && !/^\.?(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(value)) {
          context.addIssue({
            code: "custom",
            message:
              'AUTH_COOKIE_DOMAIN must be a bare hostname (e.g. "bookly.cy" or ".bookly.cy"), not a URL — leave it blank for a host-only cookie',
          });
        }
      }),
    AUTH_COOKIE_PATH: z.string().min(1).default("/api/v1/auth"),
    AUTH_COOKIE_SECURE: optionalBooleanString.default(rawNodeEnv === "production"),
    // "lax" is the correct default: the refresh + OAuth nonce cookies must ride along on the
    // top-level GET redirect Google makes back to the callback, which "strict" would drop.
    // Use "none" only for a genuinely cross-site frontend/backend split — and then the cookie
    // MUST also be Secure, or every browser silently refuses to store it.
    AUTH_COOKIE_SAME_SITE: z
      .enum(["lax", "strict", "none"])
      .default("lax")
      .superRefine((value, context) => {
        if (value === "none" && !rawAuthCookieSecure) {
          context.addIssue({
            code: "custom",
            message:
              "AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true (browsers reject SameSite=None without Secure)",
          });
        }
      }),
    OTP_LENGTH: z.coerce.number().int().min(4).max(4).default(4),
    OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
    OTP_MAX_VERIFICATION_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_MAX_RESENDS_PER_HOUR: z.coerce.number().int().positive().default(5),
    OTP_HASH_SECRET: otpHashSecretSchema,
    REGISTRATION_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    EMAIL_PROVIDER: emailProviderSchema,
    // Reused as the sender identity for both SMTP and SendGrid — SendGrid has no
    // SENDGRID_FROM_EMAIL/NAME pair of its own in this codebase's .env, and these two already
    // exist and are populated; reusing them avoids introducing a redundant provider-specific pair.
    EMAIL_FROM: optionalProviderRequiredString(["smtp", "sendgrid"], "EMAIL_FROM"),
    EMAIL_FROM_NAME: z
      .string()
      .min(1)
      .default(process.env["APP_NAME"] ?? "Bookly"),
    SMTP_HOST: optionalProviderRequiredString(["smtp"], "SMTP_HOST"),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
    SMTP_SECURE: booleanString,
    SMTP_USER: optionalProviderRequiredString(["smtp"], "SMTP_USER"),
    SMTP_PASS: optionalProviderRequiredString(["smtp"], "SMTP_PASS"),
    RESEND_API_KEY:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString(["resend"], "RESEND_API_KEY")
        : optionalProductionRequiredString("RESEND_API_KEY"),
    RESEND_FROM_EMAIL:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString(["resend"], "RESEND_FROM_EMAIL")
        : optionalProductionRequiredString("RESEND_FROM_EMAIL"),
    RESEND_FROM_NAME:
      rawEmailProvider === "resend"
        ? optionalProviderRequiredString(["resend"], "RESEND_FROM_NAME")
        : optionalProductionRequiredString("RESEND_FROM_NAME"),
    SENDGRID_API_KEY:
      rawEmailProvider === "sendgrid"
        ? optionalProviderRequiredString(["sendgrid"], "SENDGRID_API_KEY")
        : optionalProductionRequiredString("SENDGRID_API_KEY"),
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
    // Twilio **Messaging** Service SID (starts "MG...") — the sender for appointment-reminder
    // SMS. DISTINCT from TWILIO_VERIFY_SERVICE_SID (OTP, starts "VA..."). Plain-optional even in
    // production: appointment-reminder SMS defaults OFF and its worker is opt-in, so requiring
    // this would break every existing deploy that doesn't run it. TwilioSmsTransport.send throws
    // SmsError("NOT_CONFIGURED") the moment a send is attempted without it (deferred-provider
    // pattern, same as STRIPE_SECRET_KEY).
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
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
    // Governs the Customer self-service avatar endpoint (PUT /auth/me/avatar) only. Separate
    // from STAFF_AVATAR_MAX_UPLOAD_BYTES so the two identity-media surfaces stay independently
    // tunable; read URLs reuse BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS like every other object.
    CUSTOMER_AVATAR_MAX_UPLOAD_BYTES: z.coerce
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
    // Canonical public URL of the Bookly customer/business web app. Frontend and backend are
    // separate repos that deploy independently, so this is configured directly and never
    // derived from CORS_ORIGINS. Used to build transactional-email links (/privacy,
    // /terms-of-use, and future booking/dashboard deep links). Trailing slashes are stripped
    // here so link builders can plain-concatenate. Dev default matches the local frontend;
    // production must override it with a real public https URL.
    FRONTEND_BASE_URL: z
      .string()
      .min(1)
      .default("http://localhost:3000")
      .transform((value) => value.replace(/\/+$/, ""))
      .superRefine((value, context) => {
        if (!/^https?:\/\//.test(value)) {
          context.addIssue({
            code: "custom",
            message: "FRONTEND_BASE_URL must start with http:// or https://",
          });
        }
        if (rawNodeEnv === "production" && /localhost|127\.0\.0\.1/.test(value)) {
          context.addIssue({
            code: "custom",
            message: "FRONTEND_BASE_URL must be a public URL in production",
          });
        }
      }),
    // Marketing Email M2/M3B — the backend's OWN public https base URL (including the
    // `/api/<version>` prefix), e.g. https://api.bookly.cy/api/v1. Needed ONLY to build the
    // RFC 8058 one-click `List-Unsubscribe` header target, which mail providers POST to directly
    // with no browser (so it must resolve to the API, not the web app). No existing "our own base
    // URL" env var exists to derive this from — same situation, and same "configured directly"
    // resolution, as GOOGLE_CALENDAR_REDIRECT_URI / S3_PUBLIC_BASE_URL. Optional in
    // development/test (envelope omits the one-click headers + logs); **REQUIRED in production**
    // as of M3B — the marketing campaign worker refuses to send without a working one-click
    // unsubscribe (assertMarketingOneClickConfigured), and the API will not boot in production
    // without it.
    PUBLIC_API_BASE_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, ""))
      .superRefine((value, context) => {
        if (rawNodeEnv === "production" && !value) {
          context.addIssue({
            code: "custom",
            message:
              "PUBLIC_API_BASE_URL is required in production (marketing one-click unsubscribe target)",
          });
        }
      }),
    // Marketing Email Stage M2 — public unsubscribe endpoint abuse guard. Mirrors
    // CONTACT_RATE_LIMIT_MAX (another genuinely-anonymous public POST): per-IP, 15-minute window.
    MARKETING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    // Marketing Email Stage M3B — the campaign delivery worker (scripts/run-marketing-campaign-
    // worker.ts, `pnpm worker:marketing`). Mirrors the EMAIL_WORKER_* / APPOINTMENT_REMINDER_
    // WORKER_* convention. Concurrency is deliberately LOWER than transactional email — a bulk
    // marketing blast should not hammer the provider. The worker is entirely separate from the
    // transactional EmailOutbox worker; MarketingCampaignRecipient is its own queue.
    MARKETING_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    MARKETING_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    MARKETING_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
    MARKETING_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
    MARKETING_WORKER_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
    MARKETING_WORKER_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    MARKETING_WORKER_PROMOTE_BATCH_SIZE: z.coerce.number().int().positive().default(5),
    // Async transactional-email delivery (EmailOutbox + worker, see
    // scripts/run-email-worker.ts). OTP stays synchronous and is never queued. Mirrors the
    // NO_SHOW_WORKER_* convention above.
    EMAIL_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    EMAIL_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
    EMAIL_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    EMAIL_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    EMAIL_WORKER_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
    EMAIL_OUTBOX_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // 24h appointment-reminder scheduler drain (AppointmentReminder + worker, see
    // scripts/run-appointment-reminder-worker.ts). Mirrors the EMAIL_WORKER_* convention; the
    // actual email send still goes through the EmailOutbox worker above. `MAX_ATTEMPTS` bounds
    // reminder ORCHESTRATION retries only — provider retries stay owned by the EmailOutbox.
    APPOINTMENT_REMINDER_WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    APPOINTMENT_REMINDER_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    APPOINTMENT_REMINDER_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    APPOINTMENT_REMINDER_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    APPOINTMENT_REMINDER_WORKER_CLAIM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120_000),
    // Transactional-SMS outbox worker (SmsOutbox + worker, see scripts/run-sms-worker.ts).
    // Mirrors the EMAIL_WORKER_* convention. Stage 3A ships the infrastructure only — nothing
    // enqueues an SMS row until Stage 3B.
    SMS_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    SMS_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
    SMS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    SMS_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    SMS_WORKER_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
    SMS_OUTBOX_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    SUPER_ADMIN_EMAIL: z.string().email().optional(),
    SUPER_ADMIN_PASSWORD: z.string().min(6).optional(),
    SUPER_ADMIN_FIRST_NAME: z.string().min(1).optional(),
    SUPER_ADMIN_LAST_NAME: z.string().min(1).optional(),
    // Local-development-only demo CUSTOMER (see src/scripts/seed-demo-customer.ts). Same
    // optional-secret convention as SUPER_ADMIN_* above — blank in .env.example, real values in
    // the local .env. The seed script itself refuses to run when NODE_ENV=production, so these
    // never need to be set (or valid) in a production environment.
    DEMO_CUSTOMER_EMAIL: z.string().email().optional(),
    DEMO_CUSTOMER_PASSWORD: z.string().min(6).optional(),
    DEMO_CUSTOMER_FIRST_NAME: z.string().min(1).default("Demo"),
    DEMO_CUSTOMER_LAST_NAME: z.string().min(1).default("Customer"),
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
    // Google OAuth client — required in production (the whole Google auth surface depends on it),
    // optional in development/test where the feature gates (`is*Configured()`) keep the app
    // booting and each flow returns a clear NOT_CONFIGURED error / status=error redirect instead.
    GOOGLE_CLIENT_ID: optionalProductionRequiredString("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: optionalProductionRequiredString("GOOGLE_CLIENT_SECRET"),
    // Every backend OAuth callback URL below is one "Authorized redirect URI" on the SAME Google
    // Cloud OAuth client. All are REQUIRED in production (GOOGLE_CLIENT_ID/SECRET already are, so
    // a client always exists in prod and every flow must have its callback configured) and
    // optional in dev/test. Each must also be registered verbatim in the Google Cloud Console.
    // e.g. https://api.bookly.cy/api/v1/businesses/integrations/google-calendar/callback
    GOOGLE_CALENDAR_REDIRECT_URI: optionalProductionRequiredUrl("GOOGLE_CALENDAR_REDIRECT_URI"),
    // e.g. https://api.bookly.cy/api/v1/auth/oauth/google/callback  (Customer → Google linking)
    GOOGLE_ACCOUNT_LINK_REDIRECT_URI: optionalProductionRequiredUrl(
      "GOOGLE_ACCOUNT_LINK_REDIRECT_URI",
    ),
    // e.g. https://api.bookly.cy/api/v1/auth/customer/oauth/google/callback
    GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI: optionalProductionRequiredUrl(
      "GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI",
    ),
    // e.g. https://api.bookly.cy/api/v1/auth/professional/oauth/google/callback
    GOOGLE_PROFESSIONAL_OAUTH_REDIRECT_URI: optionalProductionRequiredUrl(
      "GOOGLE_PROFESSIONAL_OAUTH_REDIRECT_URI",
    ),
    // e.g. https://api.bookly.cy/api/v1/auth/staff/invitation/oauth/google/callback
    GOOGLE_STAFF_OAUTH_REDIRECT_URI: optionalProductionRequiredUrl(
      "GOOGLE_STAFF_OAUTH_REDIRECT_URI",
    ),
    // 32-byte AES-256-GCM key, hex-encoded (64 hex chars) — encrypts Google OAuth
    // access/refresh tokens at rest. Generate with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex string (32 bytes)")
      .optional()
      .superRefine((value, context) => {
        if (rawNodeEnv === "production" && !value) {
          context.addIssue({
            code: "custom",
            message: "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY is required in production",
          });
        }
      }),
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
