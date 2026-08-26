import { beforeEach, describe, expect, it, vi } from "vitest";

const loadEmailProvider = async () => {
  vi.resetModules();
  process.env["RESEND_API_KEY"] = "test-resend-key";
  process.env["RESEND_FROM_EMAIL"] = "noreply@example.com";
  process.env["RESEND_FROM_NAME"] = "Bookly";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
  process.env["OTP_EXPIRY_MINUTES"] = "7";
  return import("../../src/modules/verification/email-otp.provider.js");
};

const loadSendGridProvider = async () => {
  vi.resetModules();
  process.env["EMAIL_PROVIDER"] = "sendgrid";
  process.env["SENDGRID_API_KEY"] = "test-sendgrid-key";
  process.env["EMAIL_FROM"] = "noreply@example.com";
  process.env["EMAIL_FROM_NAME"] = "Bookly";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
  process.env["OTP_EXPIRY_MINUTES"] = "7";
  return import("../../src/modules/verification/email-otp.provider.js");
};

const loadSmtpProvider = async () => {
  vi.resetModules();
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
  process.env["OTP_EXPIRY_MINUTES"] = "7";
  return import("../../src/modules/verification/email-otp.provider.js");
};

const loadPhoneProvider = async () => {
  vi.resetModules();
  process.env["OTP_PROVIDER"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC123";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_VERIFY_SERVICE_SID"] = "VA123";
  return import("../../src/modules/verification/phone-otp.provider.js");
};

describe("verification providers", () => {
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
    delete process.env["TWILIO_ACCOUNT_SID"];
    delete process.env["TWILIO_AUTH_TOKEN"];
    delete process.env["TWILIO_VERIFY_SERVICE_SID"];
  });

  it("fails safely when Resend is not configured", async () => {
    vi.resetModules();
    const { ResendEmailOtpProvider } = await import(
      "../../src/modules/verification/email-otp.provider.js"
    );

    await expect(
      new ResendEmailOtpProvider().sendOtp({ to: "a@example.com", code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_NOT_CONFIGURED" }] });
  });

  it("sends Resend email with configured expiry text", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { ResendEmailOtpProvider } = await loadEmailProvider();

    await new ResendEmailOtpProvider(() => ({ emails: { send } })).sendOtp({
      to: "a@example.com",
      code: "1234",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("7 minutes"),
      }),
    );
  });

  it("normalizes Resend provider rejection", async () => {
    const send = vi.fn().mockRejectedValue({ statusCode: 500, response: { secret: "hidden" } });
    const { ResendEmailOtpProvider } = await loadEmailProvider();

    await expect(
      new ResendEmailOtpProvider(() => ({ emails: { send } })).sendOtp({
        to: "a@example.com",
        code: "1234",
      }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_DELIVERY_FAILED" }] });
  });

  it("sends SMTP email through the provider adapter", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const { SmtpEmailOtpProvider } = await loadSmtpProvider();

    await new SmtpEmailOtpProvider(() => ({ sendMail })).sendOtp({
      to: "a@example.com",
      code: "1234",
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Bookly <noreply@example.com>",
        text: expect.stringContaining("7 minutes"),
      }),
    );
  });

  it("normalizes SMTP provider rejection", async () => {
    const sendMail = vi.fn().mockRejectedValue({ responseCode: 429 });
    const { SmtpEmailOtpProvider } = await loadSmtpProvider();

    await expect(
      new SmtpEmailOtpProvider(() => ({ sendMail })).sendOtp({
        to: "a@example.com",
        code: "1234",
      }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_RATE_LIMITED" }] });
  });

  it("sends a plain notice email via Resend with caller-supplied subject/text (no code)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { ResendEmailOtpProvider } = await loadEmailProvider();

    await new ResendEmailOtpProvider(() => ({ emails: { send } })).sendNotice({
      to: "old@example.com",
      subject: "Your Bookly email was changed",
      text: "Your Bookly account email was changed to new@example.com.",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "old@example.com",
        subject: "Your Bookly email was changed",
        text: "Your Bookly account email was changed to new@example.com.",
      }),
    );
  });

  it("sends a plain notice email via SMTP with caller-supplied subject/text (no code)", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const { SmtpEmailOtpProvider } = await loadSmtpProvider();

    await new SmtpEmailOtpProvider(() => ({ sendMail })).sendNotice({
      to: "old@example.com",
      subject: "Your Bookly email was changed",
      text: "Your Bookly account email was changed to new@example.com.",
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "old@example.com", subject: "Your Bookly email was changed" }),
    );
  });

  it("fails safely when sending a notice without a configured provider", async () => {
    vi.resetModules();
    const { ResendEmailOtpProvider } = await import(
      "../../src/modules/verification/email-otp.provider.js"
    );

    await expect(
      new ResendEmailOtpProvider().sendNotice({ to: "a@example.com", subject: "x", text: "y" }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_NOT_CONFIGURED" }] });
  });

  it("includes EMAIL_CHANGE purpose text with configured expiry when sending a change OTP", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { ResendEmailOtpProvider } = await loadEmailProvider();

    await new ResendEmailOtpProvider(() => ({ emails: { send } })).sendOtp({
      to: "new@example.com",
      code: "1234",
      purpose: "EMAIL_CHANGE",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("new Bookly email"),
        text: expect.stringContaining("7 minutes"),
      }),
    );
  });

  it("fails safely when SendGrid is not configured", async () => {
    vi.resetModules();
    const { SendGridEmailOtpProvider } = await import(
      "../../src/modules/verification/email-otp.provider.js"
    );

    await expect(
      new SendGridEmailOtpProvider().sendOtp({ to: "a@example.com", code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_NOT_CONFIGURED" }] });
  });

  it("sends SendGrid OTP email to the expected recipient/sender with configured expiry text", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { SendGridEmailOtpProvider } = await loadSendGridProvider();

    await new SendGridEmailOtpProvider(() => ({ send })).sendOtp({
      to: "customer@example.com",
      code: "1234",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "customer@example.com",
        from: "Bookly <noreply@example.com>",
        text: expect.stringContaining("7 minutes"),
      }),
    );
  });

  it("normalizes SendGrid provider rejection", async () => {
    const send = vi.fn().mockRejectedValue({ code: 429 });
    const { SendGridEmailOtpProvider } = await loadSendGridProvider();

    await expect(
      new SendGridEmailOtpProvider(() => ({ send })).sendOtp({
        to: "a@example.com",
        code: "1234",
      }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_RATE_LIMITED" }] });
  });

  it("sends a plain notice email via SendGrid with caller-supplied subject/text (no code)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { SendGridEmailOtpProvider } = await loadSendGridProvider();

    await new SendGridEmailOtpProvider(() => ({ send })).sendNotice({
      to: "old@example.com",
      subject: "Your Bookly email was changed",
      text: "Your Bookly account email was changed to new@example.com.",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "old@example.com",
        subject: "Your Bookly email was changed",
        text: "Your Bookly account email was changed to new@example.com.",
      }),
    );
  });

  it("never lets a SendGrid API key or provider response reach an error surfaced to the caller", async () => {
    const send = vi.fn().mockRejectedValue({
      code: 401,
      response: { body: { errors: [{ message: "secret leaking test" }] } },
    });
    const { SendGridEmailOtpProvider } = await loadSendGridProvider();

    const error = await new SendGridEmailOtpProvider(() => ({ send }))
      .sendOtp({ to: "a@example.com", code: "1234" })
      .catch((e: unknown) => e);

    expect(JSON.stringify(error)).not.toContain("test-sendgrid-key");
    expect(JSON.stringify(error)).not.toContain("secret leaking test");
  });

  it("selects email provider from environment configuration", async () => {
    process.env["EMAIL_PROVIDER"] = "smtp";
    let providers = await loadSmtpProvider();
    expect(providers.createEmailOtpProvider()).toBeInstanceOf(providers.SmtpEmailOtpProvider);

    vi.resetModules();
    process.env["EMAIL_PROVIDER"] = "resend";
    process.env["RESEND_API_KEY"] = "test-resend-key";
    process.env["RESEND_FROM_EMAIL"] = "noreply@example.com";
    process.env["RESEND_FROM_NAME"] = "Bookly";
    providers = await import("../../src/modules/verification/email-otp.provider.js");
    expect(providers.createEmailOtpProvider()).toBeInstanceOf(providers.ResendEmailOtpProvider);

    vi.resetModules();
    process.env["EMAIL_PROVIDER"] = "sendgrid";
    process.env["SENDGRID_API_KEY"] = "test-sendgrid-key";
    process.env["EMAIL_FROM"] = "noreply@example.com";
    process.env["EMAIL_FROM_NAME"] = "Bookly";
    providers = await import("../../src/modules/verification/email-otp.provider.js");
    expect(providers.createEmailOtpProvider()).toBeInstanceOf(providers.SendGridEmailOtpProvider);
  });

  it("selects dummy phone OTP provider from environment configuration", async () => {
    vi.resetModules();
    process.env["OTP_PROVIDER"] = "dummy";
    process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
    const providers = await import("../../src/modules/verification/phone-otp.provider.js");

    expect(providers.createPhoneOtpProvider()).toBeInstanceOf(providers.DummyPhoneOtpProvider);
  });

  it("verifies dummy phone OTP without persisting plaintext OTPs", async () => {
    vi.resetModules();
    process.env["OTP_PROVIDER"] = "dummy";
    process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
    const { DummyPhoneOtpProvider } = await import(
      "../../src/modules/verification/phone-otp.provider.js"
    );
    const provider = new DummyPhoneOtpProvider();

    await expect(provider.sendOtp({ toE164: "+35712345678" })).resolves.toEqual({
      providerVerificationId: "dummy-phone-otp",
    });
    await expect(provider.verifyOtp({ toE164: "+35712345678", code: "1234" })).resolves.toBe(true);
    await expect(provider.verifyOtp({ toE164: "+35712345678", code: "0000" })).resolves.toBe(false);
  });

  it("normalizes Twilio delivery and verification failures", async () => {
    const services = vi.fn().mockReturnValue({
      verifications: {
        create: vi.fn().mockRejectedValue({ code: 20429 }),
      },
      verificationChecks: {
        create: vi.fn().mockRejectedValue({ statusCode: 500 }),
      },
    });
    const { TwilioVerifyPhoneOtpProvider } = await loadPhoneProvider();
    const provider = new TwilioVerifyPhoneOtpProvider(() => ({ verify: { v2: { services } } }));

    await expect(provider.sendOtp({ toE164: "+35712345678" })).rejects.toMatchObject({
      details: [{ code: "PROVIDER_RATE_LIMITED" }],
    });
    await expect(
      provider.verifyOtp({ toE164: "+35712345678", code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_VERIFICATION_FAILED" }] });
  });

  it("returns false for Twilio rejected OTP checks without storing plaintext OTPs", async () => {
    const services = vi.fn().mockReturnValue({
      verifications: {
        create: vi.fn().mockResolvedValue({ sid: "VE123" }),
      },
      verificationChecks: {
        create: vi.fn().mockResolvedValue({ status: "pending" }),
      },
    });
    const { TwilioVerifyPhoneOtpProvider } = await loadPhoneProvider();
    const provider = new TwilioVerifyPhoneOtpProvider(() => ({ verify: { v2: { services } } }));

    await expect(provider.sendOtp({ toE164: "+35712345678" })).resolves.toEqual({
      providerVerificationId: "VE123",
    });
    await expect(provider.verifyOtp({ toE164: "+35712345678", code: "1234" })).resolves.toBe(false);
  });
});
