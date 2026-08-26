import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSendGridSupportProvider = async () => {
  vi.resetModules();
  process.env["EMAIL_PROVIDER"] = "sendgrid";
  process.env["SENDGRID_API_KEY"] = "test-sendgrid-key";
  process.env["EMAIL_FROM"] = "noreply@example.com";
  process.env["EMAIL_FROM_NAME"] = "Bookly";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
  return import("../../src/modules/support/support-email.provider.js");
};

const loadResendSupportProvider = async () => {
  vi.resetModules();
  process.env["EMAIL_PROVIDER"] = "resend";
  process.env["RESEND_API_KEY"] = "test-resend-key";
  process.env["RESEND_FROM_EMAIL"] = "noreply@example.com";
  process.env["RESEND_FROM_NAME"] = "Bookly";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
  return import("../../src/modules/support/support-email.provider.js");
};

/** Batch 19.1 — Support/Contact has its own parallel email-provider hierarchy (see
 * support-email.provider.ts's own top-of-file comment on why it can't reuse EmailOtpProvider's
 * purpose-templated interface). These tests confirm SendGrid was added there too, not just to
 * the OTP-facing provider, and that Resend/SMTP support-email delivery is unaffected. */
describe("support email provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env["EMAIL_PROVIDER"] = "smtp";
    process.env["EMAIL_FROM"] = "noreply@example.com";
    process.env["EMAIL_FROM_NAME"] = "Bookly";
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_PORT"] = "587";
    process.env["SMTP_SECURE"] = "false";
    process.env["SMTP_USER"] = "smtp-user";
    process.env["SMTP_PASS"] = "smtp-pass";
    process.env["OTP_PROVIDER"] = "dummy";
    process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
    delete process.env["RESEND_API_KEY"];
    delete process.env["RESEND_FROM_EMAIL"];
    delete process.env["RESEND_FROM_NAME"];
    delete process.env["SENDGRID_API_KEY"];
  });

  it("selects SendGridSupportEmailProvider when EMAIL_PROVIDER=sendgrid", async () => {
    const providers = await loadSendGridSupportProvider();
    expect(providers.createSupportEmailProvider()).toBeInstanceOf(
      providers.SendGridSupportEmailProvider,
    );
  });

  it("sends a Support notification via SendGrid to the expected recipient/sender", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { SendGridSupportEmailProvider } = await loadSendGridSupportProvider();

    await new SendGridSupportEmailProvider(() => ({ send })).send({
      to: "customer@example.com",
      subject: "Your Bookly support ticket #123",
      text: "We've received your ticket and will respond shortly.",
    });

    expect(send).toHaveBeenCalledWith({
      to: "customer@example.com",
      from: "Bookly <noreply@example.com>",
      subject: "Your Bookly support ticket #123",
      text: "We've received your ticket and will respond shortly.",
    });
  });

  it("fails safely with SupportEmailDeliveryError when SendGrid is not configured", async () => {
    vi.resetModules();
    const { SendGridSupportEmailProvider, SupportEmailDeliveryError } = await import(
      "../../src/modules/support/support-email.provider.js"
    );

    const error = await new SendGridSupportEmailProvider()
      .send({ to: "a@example.com", subject: "x", text: "y" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SupportEmailDeliveryError);
    expect((error as InstanceType<typeof SupportEmailDeliveryError>).category).toBe(
      "not_configured",
    );
  });

  it("classifies a SendGrid rate-limit rejection as SupportEmailDeliveryError('rate_limited')", async () => {
    const send = vi.fn().mockRejectedValue({ code: 429 });
    const { SendGridSupportEmailProvider, SupportEmailDeliveryError } =
      await loadSendGridSupportProvider();

    const error = await new SendGridSupportEmailProvider(() => ({ send }))
      .send({ to: "a@example.com", subject: "x", text: "y" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SupportEmailDeliveryError);
    expect((error as InstanceType<typeof SupportEmailDeliveryError>).category).toBe("rate_limited");
  });

  it("never lets a SendGrid API key reach the thrown error", async () => {
    const send = vi.fn().mockRejectedValue({ code: 401, response: { body: "secret leak test" } });
    const { SendGridSupportEmailProvider } = await loadSendGridSupportProvider();

    const error = await new SendGridSupportEmailProvider(() => ({ send }))
      .send({ to: "a@example.com", subject: "x", text: "y" })
      .catch((e: unknown) => e);

    expect(JSON.stringify(error)).not.toContain("test-sendgrid-key");
  });

  it("still selects ResendSupportEmailProvider when EMAIL_PROVIDER=resend (regression)", async () => {
    const providers = await loadResendSupportProvider();
    expect(providers.createSupportEmailProvider()).toBeInstanceOf(
      providers.ResendSupportEmailProvider,
    );
  });

  it("still selects SmtpSupportEmailProvider by default (regression)", async () => {
    vi.resetModules();
    const providers = await import("../../src/modules/support/support-email.provider.js");
    expect(providers.createSupportEmailProvider()).toBeInstanceOf(
      providers.SmtpSupportEmailProvider,
    );
  });

  it("resolveContactInboxEmail falls back to EMAIL_FROM for SendGrid (not just Resend)", async () => {
    const providers = await loadSendGridSupportProvider();
    expect(providers.resolveContactInboxEmail()).toBe("noreply@example.com");
  });
});
