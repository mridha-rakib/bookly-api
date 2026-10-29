/** P4K isolated interactive harness — synthetic substitutions.
 *
 * Registered ONLY as a setupFile of vitest.p4k-interactive.config.ts. It uses the same
 * module-substitution mechanism as the approved P3B/P4J Vitest lane
 * (package-consent-production-proof / package-final-next). No src/ module gains a grant
 * factory, flag, registry or environment switch; shipped composition stays fail-closed.
 *
 * Substituted (and nothing else):
 *  - package-batch-authority: verifyPackageBatchActivation resolves (rollout gate only).
 *  - qualified-host: synthetic consent host + exact-identity synthetic verification profile.
 *  - host-clock observeConsentHost: synthetic HMAC observation (no chronyc, no /proc, no clock change).
 *    verifyConsentHostObservation, deadline assessment, majority evidence and the genuine
 *    v2 completion verifier remain the real source.
 *  - package-consent-http-activation: the shipped Consent HTTP composition value set to
 *    { enabled: true }, read by both the mounted consent route and catalogue availability.
 *  - Stripe payment/tax gateways: one shared in-memory fake. `stripe` SDK + client: throw.
 *  - SMTP/SendGrid/Resend transports: in-memory capture. Google/Twilio/S3 SDKs: throw.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// src/config/env.ts runs `import "dotenv/config"`, which would re-add any operational api/.env
// values (MONGODB_URI, provider keys) AFTER the stripping below. Point it at a path that
// cannot exist, whatever the caller's shell provided.
process.env["DOTENV_CONFIG_PATH"] = join(tmpdir(), `bookly-p4k-no-dotenv-${randomUUID()}`, ".env");
process.env["DOTENV_CONFIG_QUIET"] = "true";
delete process.env["DOTENV_CONFIG_OVERRIDE"];

const uiOrigin = process.env["BOOKLY_P4K_UI_ORIGIN"] ?? "http://127.0.0.1:3101";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(uiOrigin))
  throw Error("P4K UI origin must be http://127.0.0.1:<port>");
process.env["CORS_ORIGINS"] = uiOrigin;
process.env["PUBLIC_API_BASE_URL"] =
  `http://127.0.0.1:${process.env["BOOKLY_P4K_API_PORT"] ?? "3100"}/api/v1`;
// The production lifetime check path is used unchanged: exactly the approved 30 minutes.
process.env["PACKAGE_CONSENT_QUOTE_LIFETIME_MS"] = "1800000";
process.env["AUTH_COOKIE_SECURE"] = "false";
process.env["AUTH_COOKIE_SAME_SITE"] = "lax";
process.env["SMTP_HOST"] = "127.0.0.1";
process.env["SMTP_PORT"] = "9";
for (const key of Object.keys(process.env))
  if (/^(STRIPE_|GOOGLE_|FACEBOOK_|APPLE_|AWS_|S3_|SENDGRID_|RESEND_|TWILIO_)/.test(key))
    delete process.env[key];
// Disposable synthetic accounts only; journeys log several roles in repeatedly.
process.env["AUTH_LOGIN_RATE_LIMIT_MAX"] = "500";
process.env["EMAIL_PROVIDER"] = "smtp";
process.env["OTP_PROVIDER"] = "dummy";

vi.mock("../../src/modules/booking/package-batch-authority.js", async (original) => ({
  ...(await original<typeof import("../../src/modules/booking/package-batch-authority.js")>()),
  verifyPackageBatchActivation: async () => undefined,
}));
vi.mock("../../src/modules/booking/trusted-time/qualified-host.js", async () => {
  const { syntheticConsentHost } = await import("../helpers/consent-host-fixture.js");
  const state = await import("./p4k-harness-state.js");
  return {
    requireQualifiedConsentHost: () => syntheticConsentHost,
    requireConsentHostVerificationProfile: state.requireSyntheticVerificationProfile,
  };
});
vi.mock("../../src/modules/booking/trusted-time/host-clock.js", async (original) => ({
  ...(await original<typeof import("../../src/modules/booking/trusted-time/host-clock.js")>()),
  observeConsentHost: (await import("./p4k-harness-state.js")).observeSyntheticConsentHost,
}));
// The existing Consent HTTP composition value (route default + catalogue availability read
// the same module). Lifetime stays unset so the shipped 30-minute check path is used.
vi.mock("../../src/modules/booking/package-consent-http-activation.js", async (original) => ({
  ...(await original<
    typeof import("../../src/modules/booking/package-consent-http-activation.js")
  >()),
  shippedPackageConsentHttpActivation: Object.freeze({ enabled: true }),
}));
vi.mock("../../src/modules/payment/stripe-payment-gateway.js", async () => {
  const { harnessGateway } = await import("./p4k-harness-state.js");
  return {
    StripePaymentGateway: function StripePaymentGateway() {
      return harnessGateway;
    },
  };
});
vi.mock("../../src/modules/payment/stripe-tax-gateway.js", async () => {
  const { harnessTax } = await import("./p4k-harness-state.js");
  return {
    StripeTaxGateway: function StripeTaxGateway() {
      return harnessTax;
    },
  };
});
vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => {
    throw Error("P4K harness: real Stripe client is unavailable");
  },
  resetStripeClientForTests: () => undefined,
}));
vi.mock("stripe", () => ({
  default: function Stripe() {
    throw Error("P4K harness: real Stripe SDK is unavailable");
  },
}));
// Node SDK clients bypass the fetch guard, so they throw on construction (all are lazily
// constructed; provider credentials are also stripped above).
vi.mock("google-auth-library", async (original) => ({
  ...(await original<object>()),
  OAuth2Client: function OAuth2Client() {
    throw Error("P4K harness: Google client is unavailable");
  },
}));
vi.mock("twilio", () => ({
  default: function twilio() {
    throw Error("P4K harness: Twilio is unavailable");
  },
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<object>()),
  S3Client: function S3Client() {
    throw Error("P4K harness: S3 is unavailable");
  },
}));
vi.mock("../../src/modules/email/smtp-email-transport.js", async () => ({
  SmtpEmailTransport: (await import("./p4k-harness-state.js")).CaptureEmailTransport,
}));
vi.mock("../../src/modules/email/sendgrid-email-transport.js", async () => ({
  SendGridEmailTransport: (await import("./p4k-harness-state.js")).CaptureEmailTransport,
}));
vi.mock("../../src/modules/email/resend-email-transport.js", async () => ({
  ResendEmailTransport: (await import("./p4k-harness-state.js")).CaptureEmailTransport,
}));

const state = await import("./p4k-harness-state.js");
state.installLoopbackFetchGuard();
(globalThis as Record<symbol, unknown>)[state.P4K_SETUP_MARKER] = true;
