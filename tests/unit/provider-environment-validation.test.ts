import { afterEach, describe, expect, it, vi } from "vitest";

const appleNames = [
  "APPLE_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_ACCOUNT_LINK_REDIRECT_URI",
  "APPLE_CUSTOMER_OAUTH_REDIRECT_URI",
  "APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI",
];
const emailNames = [
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_FROM_NAME",
  "SENDGRID_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
];
const configure = (overrides: Record<string, string | undefined> = {}) => {
  for (const name of [...appleNames, ...emailNames]) vi.stubEnv(name, undefined);
  const values: Record<string, string | undefined> = {
    NODE_ENV: "production",
    APPLE_OAUTH_ENABLED: "false",
    FRONTEND_BASE_URL: "https://staging.bookly.cy",
    PUBLIC_API_BASE_URL: "https://api-staging.bookly.cy/api/v1",
    CORS_ORIGINS: "https://staging.bookly.cy",
    MONGODB_URI: "mongodb://127.0.0.1:27017/schema-fixture-not-connected",
    JWT_ACCESS_TOKEN_SECRET: "synthetic-access-secret-at-least-32-characters",
    OTP_HASH_SECRET: "synthetic-otp-secret-at-least-32-characters",
    EMAIL_PROVIDER: "sendgrid",
    EMAIL_FROM: "noreply@example.test",
    SENDGRID_API_KEY: "SG.synthetic-fixture",
    OTP_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: "synthetic-twilio-account",
    TWILIO_AUTH_TOKEN: "synthetic-twilio-token",
    TWILIO_VERIFY_SERVICE_SID: "synthetic-twilio-verify",
    STRIPE_SECRET_KEY: "sk_test_synthetic_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_synthetic_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic_fixture",
    STORAGE_PROVIDER: "s3",
    S3_ENDPOINT: "https://storage.example.test",
    S3_BUCKET: "synthetic-bucket",
    S3_ACCESS_KEY_ID: "synthetic-access",
    S3_SECRET_ACCESS_KEY: "synthetic-secret",
    GOOGLE_CLIENT_ID: "synthetic-google-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "01".repeat(32),
    PAYOUT_DESTINATION_ENCRYPTION_KEY_V1: "02".repeat(32),
    FACEBOOK_CLIENT_ID: "synthetic-facebook-client",
    FACEBOOK_CLIENT_SECRET: "synthetic-facebook-secret",
  };
  for (const name of [
    "GOOGLE_CALENDAR_REDIRECT_URI",
    "GOOGLE_ACCOUNT_LINK_REDIRECT_URI",
    "GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI",
    "GOOGLE_PROFESSIONAL_OAUTH_REDIRECT_URI",
    "GOOGLE_STAFF_OAUTH_REDIRECT_URI",
    "FACEBOOK_ACCOUNT_LINK_REDIRECT_URI",
    "FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI",
    "FACEBOOK_PROFESSIONAL_OAUTH_REDIRECT_URI",
  ])
    values[name] = "https://api-staging.bookly.cy/api/v1/fixture/callback";
  for (const [key, value] of Object.entries({ ...values, ...overrides })) vi.stubEnv(key, value);
  vi.resetModules();
};
const load = () => import("../../src/config/env.js");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("selected email provider requirements", () => {
  it("accepts SendGrid without any Resend or SMTP credentials", async () => {
    configure();
    expect((await load()).env.EMAIL_PROVIDER).toBe("sendgrid");
  });
  it("still rejects missing SendGrid credentials when selected", async () => {
    configure({ SENDGRID_API_KEY: undefined });
    await expect(load()).rejects.toThrow("SENDGRID_API_KEY");
  });
  it("requires Resend credentials only when selected", async () => {
    configure({ EMAIL_PROVIDER: "resend", SENDGRID_API_KEY: undefined });
    await expect(load()).rejects.toThrow("RESEND_API_KEY");
    configure({
      EMAIL_PROVIDER: "resend",
      SENDGRID_API_KEY: undefined,
      RESEND_API_KEY: "synthetic-resend",
      RESEND_FROM_EMAIL: "noreply@example.test",
      RESEND_FROM_NAME: "Bookly",
    });
    expect((await load()).env.EMAIL_PROVIDER).toBe("resend");
  });
  it("preserves selected SMTP validation without requiring other providers", async () => {
    configure({ EMAIL_PROVIDER: "smtp", SENDGRID_API_KEY: undefined });
    await expect(load()).rejects.toThrow("SMTP_HOST");
    configure({
      EMAIL_PROVIDER: "smtp",
      SENDGRID_API_KEY: undefined,
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "synthetic-user",
      SMTP_PASS: "synthetic-password",
    });
    expect((await load()).env.EMAIL_PROVIDER).toBe("smtp");
  });
});

describe("explicit staging-only Apple pending state", () => {
  it("accepts an explicitly disabled staging deployment with no Apple credentials or redirects", async () => {
    configure();
    expect((await load()).env.APPLE_OAUTH_ENABLED).toBe(false);
  });
  it("keeps Apple required by default in production mode", async () => {
    configure({ APPLE_OAUTH_ENABLED: undefined });
    await expect(load()).rejects.toThrow("APPLE_CLIENT_ID");
  });
  it("keeps credentials required when explicitly enabled", async () => {
    configure({ APPLE_OAUTH_ENABLED: "true" });
    await expect(load()).rejects.toThrow("APPLE_PRIVATE_KEY");
  });
  it.each(["https://bookly.cy", "https://staging.bookly.cy.attacker.test"])(
    "rejects the disabled production state for %s",
    async (origin) => {
      configure({ FRONTEND_BASE_URL: origin });
      await expect(load()).rejects.toThrow("APPLE_OAUTH_ENABLED");
    },
  );
  it("rejects disabling with a non-staging API origin", async () => {
    configure({ PUBLIC_API_BASE_URL: "https://api.bookly.cy/api/v1" });
    await expect(load()).rejects.toThrow("APPLE_OAUTH_ENABLED");
  });
});
