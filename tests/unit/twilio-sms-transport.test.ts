import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TwilioSmsTransport — Twilio MESSAGING (never Verify). Uses a mock messages client; no real
 * Twilio call, no real credentials.
 */
const RESET_ENV = () => {
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "123456";
  delete process.env["TWILIO_ACCOUNT_SID"];
  delete process.env["TWILIO_AUTH_TOKEN"];
  delete process.env["TWILIO_MESSAGING_SERVICE_SID"];
};

const loadTransport = async (configured: boolean) => {
  vi.resetModules();
  RESET_ENV();
  if (configured) {
    process.env["TWILIO_ACCOUNT_SID"] = "AC_fake_account_sid";
    process.env["TWILIO_AUTH_TOKEN"] = "fake_auth_token";
    process.env["TWILIO_MESSAGING_SERVICE_SID"] = "MG_fake_messaging_sid";
  }
  return import("../../src/modules/sms/twilio-sms-transport.js");
};

describe("TwilioSmsTransport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    RESET_ENV();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("passes the Messaging Service SID, E.164 recipient and body, and returns the message SID", async () => {
    const { TwilioSmsTransport } = await loadTransport(true);
    const create = vi.fn().mockResolvedValue({ sid: "SM123", status: "queued" });
    const transport = new TwilioSmsTransport(() => ({ messages: { create } }) as never);

    const result = await transport.send({ to: "+35799123456", body: "hello" });

    expect(create).toHaveBeenCalledWith({
      messagingServiceSid: "MG_fake_messaging_sid",
      to: "+35799123456",
      body: "hello",
    });
    expect(result).toEqual({
      provider: "twilio",
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "SM123",
    });
    expect(transport.isConfigured()).toBe(true);
  });

  it("throws SmsError('NOT_CONFIGURED') and never calls the client when config is absent", async () => {
    const { TwilioSmsTransport } = await loadTransport(false);
    const { SmsError } = await import("../../src/modules/sms/sms.errors.js");
    const create = vi.fn();
    const transport = new TwilioSmsTransport(() => ({ messages: { create } }) as never);

    await expect(transport.send({ to: "+35799123456", body: "x" })).rejects.toBeInstanceOf(
      SmsError,
    );
    await expect(transport.send({ to: "+35799123456", body: "x" })).rejects.toMatchObject({
      category: "NOT_CONFIGURED",
    });
    expect(create).not.toHaveBeenCalled();
    expect(transport.isConfigured()).toBe(false);
  });

  it("maps a retryable provider error (HTTP 503) to a retryable SmsError", async () => {
    const { TwilioSmsTransport } = await loadTransport(true);
    const transport = new TwilioSmsTransport(
      () =>
        ({
          messages: { create: vi.fn().mockRejectedValue({ status: 503, message: "svc" }) },
        }) as never,
    );

    await expect(transport.send({ to: "+35799123456", body: "x" })).rejects.toMatchObject({
      category: "PROVIDER_TRANSIENT",
      retryable: true,
    });
  });

  it("maps a permanent provider error (Twilio code 21211) to a non-retryable SmsError", async () => {
    const { TwilioSmsTransport } = await loadTransport(true);
    const transport = new TwilioSmsTransport(
      () =>
        ({
          messages: { create: vi.fn().mockRejectedValue({ code: 21211, status: 400 }) },
        }) as never,
    );

    await expect(transport.send({ to: "+3570000", body: "x" })).rejects.toMatchObject({
      category: "INVALID_DESTINATION",
      retryable: false,
    });
  });

  it("treats a synchronous 'failed' message status / per-message errorCode as a rejection", async () => {
    const { TwilioSmsTransport } = await loadTransport(true);
    const transport = new TwilioSmsTransport(
      () =>
        ({
          messages: {
            create: vi.fn().mockResolvedValue({ sid: "SM9", status: "failed", errorCode: 21610 }),
          },
        }) as never,
    );

    await expect(transport.send({ to: "+35799123456", body: "x" })).rejects.toMatchObject({
      category: "PROVIDER_PERMISSION_OR_SENDER_ERROR",
    });
  });

  it("never leaks the raw provider error object to the caller (expose:false, no cause on the surface)", async () => {
    const { TwilioSmsTransport } = await loadTransport(true);
    const raw = { status: 500, message: "AC_secret in body", response: { data: "secret" } };
    const transport = new TwilioSmsTransport(
      () => ({ messages: { create: vi.fn().mockRejectedValue(raw) } }) as never,
    );

    await transport.send({ to: "+35799123456", body: "x" }).catch((err: unknown) => {
      const e = err as { expose?: boolean; safeProviderMessage?: string; message: string };
      expect(e.expose).toBe(false);
      expect(e.safeProviderMessage ?? "").not.toContain("AC_secret");
      expect(e.message).not.toContain("secret");
    });
  });
});
