import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailOutboxModel } from "../../src/modules/email-outbox/email-outbox.model.js";

/**
 * MAILING STAGE A — OTP branded template + synchronous compatibility (Phase U/V).
 * Part Y items 26–30.
 */

const RESET_ENV = () => {
  process.env["EMAIL_PROVIDER"] = "sendgrid";
  process.env["SENDGRID_API_KEY"] = "SG.test-key";
  process.env["EMAIL_FROM"] = "noreply@example.com";
  process.env["EMAIL_FROM_NAME"] = "Bookly";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "1234";
  process.env["OTP_EXPIRY_MINUTES"] = "9";
};

const load = async () => {
  vi.resetModules();
  RESET_ENV();
  return {
    provider: await import("../../src/modules/verification/email-otp.provider.js"),
    template: await import("../../src/modules/email/templates/otp/otp-verification.template.js"),
  };
};

describe("OTP branded template + delivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    RESET_ENV();
  });

  it("26 OTP is sent through the central transport (single sgMail.send payload with html+text)", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: { "x-message-id": "m1" } }, {}]);
    const { provider } = await load();

    await new provider.SendGridEmailOtpProvider(() => ({ send })).sendOtp({
      to: "person@example.com",
      code: "4821",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["html"]).toContain("Verify your email");
    expect(typeof payload["text"]).toBe("string");
    expect(payload["attachments"]).toBeInstanceOf(Array);
  });

  it("27 OTP email has both an HTML body and a meaningful text fallback", async () => {
    const { template } = await load();
    const rendered = template.renderOtpVerificationEmail({ code: "4821", expiryMinutes: 9 });

    expect(rendered.html).toContain("cid:bookly-wordmark");
    expect(rendered.html).toContain("4821");
    expect(rendered.text).toContain("Your verification code: 4821");
    expect(rendered.text).toContain("If you didn't request this code");
  });

  it("28 expiry text uses the real OTP_EXPIRY_MINUTES config value", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { provider, template } = await load();

    const rendered = template.renderOtpVerificationEmail({ code: "0000", expiryMinutes: 9 });
    expect(rendered.text).toContain("expire in 9 minutes");

    await new provider.SendGridEmailOtpProvider(() => ({ send })).sendOtp({
      to: "person@example.com",
      code: "0000",
    });
    const payload = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(payload["text"])).toContain("9 minutes");
  });

  it("29 a provider failure still surfaces to the caller (OTP stays fail-loud)", async () => {
    const send = vi.fn().mockRejectedValue({ code: 500 });
    const { provider } = await load();

    await expect(
      new provider.SendGridEmailOtpProvider(() => ({ send })).sendOtp({
        to: "person@example.com",
        code: "4821",
      }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_DELIVERY_FAILED" }] });
  });

  it("30 OTP is never written to the EmailOutbox", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { provider } = await load();
    const saveSpy = vi
      .spyOn(EmailOutboxModel.prototype, "save")
      .mockResolvedValue(undefined as never);

    await new provider.SendGridEmailOtpProvider(() => ({ send })).sendOtp({
      to: "person@example.com",
      code: "4821",
    });

    expect(saveSpy).not.toHaveBeenCalled();
  });
});
