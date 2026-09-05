import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MAILING STAGE A — central transport (Phase C) + provider error classification (Phase L).
 * Covers Part Y items 1–10.
 */

const RESET_ENV = () => {
  process.env["EMAIL_PROVIDER"] = "smtp";
  process.env["EMAIL_FROM"] = "noreply@example.com";
  process.env["EMAIL_FROM_NAME"] = "Bookly";
  process.env["SMTP_HOST"] = "smtp.example.com";
  process.env["SMTP_PORT"] = "587";
  process.env["SMTP_SECURE"] = "false";
  process.env["SMTP_USER"] = "smtp-user";
  process.env["SMTP_PASS"] = "smtp-pass";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "123456";
  delete process.env["SENDGRID_API_KEY"];
  delete process.env["RESEND_API_KEY"];
  delete process.env["RESEND_FROM_EMAIL"];
  delete process.env["RESEND_FROM_NAME"];
};

const loadSendGridTransport = async () => {
  vi.resetModules();
  RESET_ENV();
  process.env["EMAIL_PROVIDER"] = "sendgrid";
  process.env["SENDGRID_API_KEY"] = "SG.super-secret-key";
  return import("../../src/modules/email/sendgrid-email-transport.js");
};

const buildInput = (overrides: Record<string, unknown> = {}) => ({
  to: "customer@example.com",
  subject: "Test subject",
  text: "Plain text body",
  html: "<p>HTML body</p>",
  ...overrides,
});

describe("central email transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    RESET_ENV();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("1/2 sends HTML and a text fallback in one payload", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { SendGridEmailTransport } = await loadSendGridTransport();

    await new SendGridEmailTransport(() => ({ send })).send(buildInput());

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "customer@example.com",
        from: "Bookly <noreply@example.com>",
        subject: "Test subject",
        text: "Plain text body",
        html: "<p>HTML body</p>",
      }),
    );
  });

  it("3 maps an inline CID attachment to SendGrid's content_id/disposition shape", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { SendGridEmailTransport } = await loadSendGridTransport();

    await new SendGridEmailTransport(() => ({ send })).send(
      buildInput({
        attachments: [
          {
            filename: "bookly-wordmark.png",
            content: Buffer.from("PNGDATA"),
            type: "image/png",
            disposition: "inline",
            contentId: "bookly-wordmark",
          },
        ],
      }),
    );

    const payload = send.mock.calls[0]?.[0] as { attachments: Array<Record<string, unknown>> };
    expect(payload.attachments[0]).toEqual({
      content: Buffer.from("PNGDATA").toString("base64"),
      filename: "bookly-wordmark.png",
      type: "image/png",
      disposition: "inline",
      content_id: "bookly-wordmark",
    });
  });

  it("4 supports a regular (non-inline) attachment", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { SendGridEmailTransport } = await loadSendGridTransport();

    await new SendGridEmailTransport(() => ({ send })).send(
      buildInput({
        attachments: [
          {
            filename: "Bookly-Invoice-BK-1.pdf",
            content: Buffer.from("%PDF-1.7"),
            type: "application/pdf",
          },
        ],
      }),
    );

    const payload = send.mock.calls[0]?.[0] as { attachments: Array<Record<string, unknown>> };
    expect(payload.attachments[0]).toMatchObject({
      filename: "Bookly-Invoice-BK-1.pdf",
      type: "application/pdf",
      disposition: "attachment",
    });
    expect(payload.attachments[0]).not.toHaveProperty("content_id");
  });

  it("5 @sendgrid/mail is imported from exactly one module — the canonical transport", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (
          entry.endsWith(".ts") &&
          /["']@sendgrid\/mail["']/.test(readFileSync(full, "utf8"))
        ) {
          hits.push(full.replace(/\\/g, "/"));
        }
      }
    };
    walk("src");

    expect(hits).toEqual(["src/modules/email/sendgrid-email-transport.ts"]);
  });

  it("6 captures the provider message id from the x-message-id response header", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: { "x-message-id": "msg-abc-123" } }, {}]);
    const { SendGridEmailTransport } = await loadSendGridTransport();

    const result = await new SendGridEmailTransport(() => ({ send })).send(buildInput());

    expect(result).toMatchObject({
      provider: "sendgrid",
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "msg-abc-123",
    });
  });

  it("7 classifies HTTP 429 as a transient (retryable) error", async () => {
    vi.resetModules();
    const { classifyEmailProviderError, isRetryableEmailErrorCategory } = await import(
      "../../src/modules/email/email.errors.js"
    );
    const { category } = classifyEmailProviderError({ code: 429 });
    expect(category).toBe("RATE_LIMITED");
    expect(isRetryableEmailErrorCategory(category)).toBe(true);
  });

  it("8 classifies HTTP 5xx as a transient (retryable) error", async () => {
    vi.resetModules();
    const { classifyEmailProviderError, isRetryableEmailErrorCategory } = await import(
      "../../src/modules/email/email.errors.js"
    );
    const { category } = classifyEmailProviderError({ statusCode: 503 });
    expect(category).toBe("PROVIDER_TRANSIENT");
    expect(isRetryableEmailErrorCategory(category)).toBe(true);
  });

  it("9 classifies HTTP 403 (sender/permission) as permanent (not retryable)", async () => {
    vi.resetModules();
    const { classifyEmailProviderError, isRetryableEmailErrorCategory } = await import(
      "../../src/modules/email/email.errors.js"
    );
    const { category } = classifyEmailProviderError({ code: 403 });
    expect(category).toBe("PROVIDER_PERMISSION_OR_SENDER_ERROR");
    expect(isRetryableEmailErrorCategory(category)).toBe(false);
  });

  it("10 never lets the API key or a provider response body escape on the thrown error", async () => {
    const send = vi.fn().mockRejectedValue({
      code: 401,
      response: { body: { errors: [{ message: "leaked-secret-detail" }] } },
    });
    const { SendGridEmailTransport } = await loadSendGridTransport();

    const error = await new SendGridEmailTransport(() => ({ send }))
      .send(buildInput())
      .catch((e: unknown) => e);

    const serialised = JSON.stringify(error) + String((error as Error).message);
    expect(serialised).not.toContain("SG.super-secret-key");
    expect(serialised).not.toContain("leaked-secret-detail");
  });
});

describe("generic MIME header forwarding (Marketing Email Stage M2)", () => {
  const LIST_UNSUB_HEADERS = {
    "List-Unsubscribe": "<https://api.bookly.cy/api/v1/marketing/unsubscribe?token=abc>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    RESET_ENV();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("SendGrid: forwards `headers` verbatim, and omits the key entirely when unset", async () => {
    const send = vi.fn().mockResolvedValue([{ headers: {} }, {}]);
    const { SendGridEmailTransport } = await loadSendGridTransport();
    const transport = new SendGridEmailTransport(() => ({ send }));

    await transport.send(buildInput({ headers: LIST_UNSUB_HEADERS }));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ headers: LIST_UNSUB_HEADERS });

    await transport.send(buildInput());
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty("headers");
  });

  it("Resend: forwards `headers` verbatim, and omits the key entirely when unset", async () => {
    vi.resetModules();
    RESET_ENV();
    process.env["EMAIL_PROVIDER"] = "resend";
    process.env["RESEND_API_KEY"] = "re_test_key";
    process.env["RESEND_FROM_EMAIL"] = "noreply@example.com";
    process.env["RESEND_FROM_NAME"] = "Bookly";
    const { ResendEmailTransport } = await import(
      "../../src/modules/email/resend-email-transport.js"
    );
    const send = vi.fn().mockResolvedValue({ data: { id: "re-1" } });
    const transport = new ResendEmailTransport(() => ({ emails: { send } }));

    await transport.send(buildInput({ headers: LIST_UNSUB_HEADERS }));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ headers: LIST_UNSUB_HEADERS });

    await transport.send(buildInput());
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty("headers");
  });

  it("SMTP: forwards `headers` verbatim, and omits the key entirely when unset", async () => {
    vi.resetModules();
    RESET_ENV();
    const { SmtpEmailTransport } = await import("../../src/modules/email/smtp-email-transport.js");
    const sendMail = vi.fn().mockResolvedValue({ messageId: "smtp-1" });
    const transport = new SmtpEmailTransport(() => ({ sendMail }));

    await transport.send(buildInput({ headers: LIST_UNSUB_HEADERS }));
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ headers: LIST_UNSUB_HEADERS });

    await transport.send(buildInput());
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty("headers");
  });
});
