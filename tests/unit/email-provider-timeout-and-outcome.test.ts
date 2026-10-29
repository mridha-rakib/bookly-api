import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/**
 * F4A Tier 1 — truthful provider outcomes and bounded provider calls for the SendGrid, Resend
 * and SMTP transports, as seen by the email outbox worker and the OTP path. Synthetic clients
 * only; no SDK performs a network call and no email is sent.
 */

const sdk = vi.hoisted(() => ({
  sgSetApiKey: vi.fn(),
  sgSetTimeout: vi.fn(),
  sgSend: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: sdk.sgSetApiKey, setTimeout: sdk.sgSetTimeout, send: sdk.sgSend },
}));
vi.mock("nodemailer", () => ({ default: { createTransport: sdk.createTransport } }));
vi.mock("../../src/config/logger.js", () => ({ logger: sdk.logger }));

const SECRET_KEY = "re_super_secret_key";

const baseEnv = (provider: "sendgrid" | "resend" | "smtp") => {
  vi.resetModules();
  process.env["EMAIL_PROVIDER"] = provider;
  process.env["EMAIL_FROM"] = "noreply@example.com";
  process.env["EMAIL_FROM_NAME"] = "Bookly";
  process.env["SMTP_HOST"] = "smtp.example.com";
  process.env["SMTP_PORT"] = "587";
  process.env["SMTP_SECURE"] = "false";
  process.env["SMTP_USER"] = "smtp-user";
  process.env["SMTP_PASS"] = "smtp-pass";
  process.env["OTP_PROVIDER"] = "dummy";
  process.env["DUMMY_PHONE_OTP_CODE"] = "123456";
  process.env["SENDGRID_API_KEY"] = "SG.super-secret-key";
  process.env["RESEND_API_KEY"] = SECRET_KEY;
  process.env["RESEND_FROM_EMAIL"] = "noreply@example.com";
  process.env["RESEND_FROM_NAME"] = "Bookly";
};

const input = { to: "customer@example.com", subject: "s", text: "t" };

const loadErrors = () => import("../../src/modules/email/email.errors.js");
const loadResend = async () => {
  baseEnv("resend");
  const [transport, errors] = await Promise.all([
    import("../../src/modules/email/resend-email-transport.js"),
    loadErrors(),
  ]);
  return { ...transport, ...errors };
};

type SendResult = { data?: unknown; error?: unknown } | undefined;
const resendClient = (result: SendResult | (() => Promise<SendResult>)) => {
  const send = vi.fn(async (_payload: unknown, _options?: { signal?: AbortSignal }) =>
    typeof result === "function" ? result() : result,
  );
  return { send, factory: () => ({ emails: { send } }) };
};

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Resend: returned errors are never acceptance (D1)", () => {
  it("1 a success envelope is accepted with its message id, and the call is bounded by a signal", async () => {
    const { ResendEmailTransport } = await loadResend();
    const { send, factory } = resendClient({ data: { id: "re-123" }, error: null });

    const result = await new ResendEmailTransport(factory).send(input);

    expect(result).toEqual({
      provider: "resend",
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "re-123",
    });
    expect(send.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [500, "PROVIDER_TRANSIENT", true],
    [429, "RATE_LIMITED", true],
    [422, "PROVIDER_PERMANENT", false],
    [403, "PROVIDER_PERMISSION_OR_SENDER_ERROR", false],
    [401, "PROVIDER_AUTH_ERROR", false],
    [400, "INVALID_MESSAGE", false],
  ] as const)(
    "2 a returned %s error throws %s (retryable=%s) instead of PROVIDER_ACCEPTED",
    async (statusCode, category, retryable) => {
      const { ResendEmailTransport, EmailError } = await loadResend();
      const { factory } = resendClient({
        data: null,
        error: { name: "validation_error", statusCode, message: "body for customer@example.com" },
      });

      const error = await caught(new ResendEmailTransport(factory).send(input));

      expect(error).toBeInstanceOf(EmailError);
      expect(error).toMatchObject({ category, retryable, providerStatus: statusCode });
    },
  );

  it("2b a returned network failure (statusCode null) is an unknown outcome, not a rejection", async () => {
    const { ResendEmailTransport } = await loadResend();
    const { factory } = resendClient({
      data: null,
      error: { name: "application_error", statusCode: null, message: "Unable to fetch data." },
    });

    const error = await caught(new ResendEmailTransport(factory).send(input));

    expect(error).toMatchObject({ category: "PROVIDER_OUTCOME_UNKNOWN", retryable: true });
  });

  it("3 a rejected promise keeps the existing classification", async () => {
    const { ResendEmailTransport } = await loadResend();
    const send = vi.fn().mockRejectedValue({ statusCode: 503 });

    const error = await caught(new ResendEmailTransport(() => ({ emails: { send } })).send(input));

    expect(error).toMatchObject({ category: "PROVIDER_TRANSIENT", retryable: true });
  });

  it("8 a non-envelope response yields no acceptance", async () => {
    const { ResendEmailTransport } = await loadResend();
    const { factory } = resendClient(undefined);

    const error = await caught(new ResendEmailTransport(factory).send(input));

    expect(error).toMatchObject({ category: "PROVIDER_OUTCOME_UNKNOWN" });
  });

  it("6/7 the 30 s deadline aborts the real request and is reported as unknown acceptance", async () => {
    const { ResendEmailTransport, EMAIL_PROVIDER_REQUEST_TIMEOUT_MS } = await loadResend();
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    // Mirrors resend@6 fetchRequest: an aborted fetch is caught and RETURNED as statusCode null.
    const send = vi.fn(
      (_payload: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve({ data: null, error: { name: "application_error", statusCode: null } }),
          );
        }),
    );

    const pending = caught(new ResendEmailTransport(() => ({ emails: { send } })).send(input));
    controller.abort();
    const error = await pending;

    expect(timeoutSpy).toHaveBeenCalledWith(EMAIL_PROVIDER_REQUEST_TIMEOUT_MS);
    expect(EMAIL_PROVIDER_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(error).toMatchObject({ category: "PROVIDER_OUTCOME_UNKNOWN", retryable: true });
  });

  it("16 neither the API key nor the provider's message body reaches the thrown error", async () => {
    const { ResendEmailTransport } = await loadResend();
    const { factory } = resendClient({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 422,
        message: "leaked-body customer@example.com",
      },
    });

    const error = (await caught(new ResendEmailTransport(factory).send(input))) as Error & {
      cause?: unknown;
    };
    const serialised = JSON.stringify(error) + error.message + JSON.stringify(error.cause);

    expect(serialised).not.toContain(SECRET_KEY);
    expect(serialised).not.toContain("leaked-body");
    expect(serialised).not.toContain("customer@example.com");
  });
});

describe("SendGrid: bounded default client", () => {
  beforeEach(() => baseEnv("sendgrid"));

  it("4/6 the default client is configured with the 30 s request timeout; acceptance keeps its id", async () => {
    const { SendGridEmailTransport } = await import(
      "../../src/modules/email/sendgrid-email-transport.js"
    );
    sdk.sgSend.mockResolvedValue([{ headers: { "x-message-id": "sg-1" } }, {}]);

    const result = await new SendGridEmailTransport().send(input);

    expect(sdk.sgSetTimeout).toHaveBeenCalledWith(30_000);
    expect(result).toMatchObject({ status: "PROVIDER_ACCEPTED", providerMessageId: "sg-1" });
  });

  it("4/7 an axios timeout (ECONNABORTED) is unknown acceptance; an HTTP 400 is a rejection", async () => {
    const { SendGridEmailTransport } = await import(
      "../../src/modules/email/sendgrid-email-transport.js"
    );
    sdk.sgSend
      .mockRejectedValueOnce({ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" })
      .mockRejectedValueOnce({ code: 400 });
    const transport = new SendGridEmailTransport();

    expect(await caught(transport.send(input))).toMatchObject({
      category: "PROVIDER_OUTCOME_UNKNOWN",
      retryable: true,
    });
    expect(await caught(transport.send(input))).toMatchObject({
      category: "INVALID_MESSAGE",
      retryable: false,
    });
  });
});

describe("SMTP: per-phase limits on the default transporter", () => {
  beforeEach(() => {
    baseEnv("smtp");
    sdk.createTransport.mockReturnValue({ sendMail: sdk.sendMail });
  });

  it("5/6 connection, greeting, DNS and socket-idle limits are set; success keeps the message id", async () => {
    const { SmtpEmailTransport } = await import("../../src/modules/email/smtp-email-transport.js");
    sdk.sendMail.mockResolvedValue({ messageId: "<smtp-1@example.com>" });

    const result = await new SmtpEmailTransport().send(input);

    expect(sdk.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        dnsTimeout: 10_000,
        socketTimeout: 30_000,
      }),
    );
    expect(result).toMatchObject({ provider: "smtp", providerMessageId: "<smtp-1@example.com>" });
  });

  it("5/7 a nodemailer timeout is unknown acceptance; a refused connection is a definite network failure", async () => {
    const { SmtpEmailTransport } = await import("../../src/modules/email/smtp-email-transport.js");
    sdk.sendMail
      .mockRejectedValueOnce({ code: "ETIMEDOUT", command: "CONN", message: "Timeout" })
      .mockRejectedValueOnce({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" });
    const transport = new SmtpEmailTransport();

    expect(await caught(transport.send(input))).toMatchObject({
      category: "PROVIDER_OUTCOME_UNKNOWN",
    });
    expect(await caught(transport.send(input))).toMatchObject({ category: "NETWORK_TRANSIENT" });
  });
});

describe("classification table (10)", () => {
  it.each([
    [{ code: "ENOTFOUND" }, "NETWORK_TRANSIENT"],
    [{ code: "EAI_AGAIN" }, "NETWORK_TRANSIENT"],
    [{ code: "ECONNRESET" }, "PROVIDER_OUTCOME_UNKNOWN"],
    [{ code: "EPIPE" }, "PROVIDER_OUTCOME_UNKNOWN"],
    [{ name: "AbortError" }, "PROVIDER_OUTCOME_UNKNOWN"],
    [{ name: "TimeoutError" }, "PROVIDER_OUTCOME_UNKNOWN"],
    [{ message: "socket hang up" }, "PROVIDER_OUTCOME_UNKNOWN"],
    [{ statusCode: 503 }, "PROVIDER_TRANSIENT"],
    [{ code: 429 }, "RATE_LIMITED"],
    [{ code: 403 }, "PROVIDER_PERMISSION_OR_SENDER_ERROR"],
  ] as const)("%j → %s", async (error, category) => {
    vi.resetModules();
    const { classifyEmailProviderError, isRetryableEmailErrorCategory } = await loadErrors();
    expect(classifyEmailProviderError(error).category).toBe(category);
    if (category === "PROVIDER_OUTCOME_UNKNOWN")
      expect(isRetryableEmailErrorCategory(category)).toBe(true);
  });
});

describe("worker and consumers", () => {
  const loadWorkerStack = async () => {
    baseEnv("resend");
    const [transport, service, worker, bookingData] = await Promise.all([
      import("../../src/modules/email/resend-email-transport.js"),
      import("../../src/modules/email/email.service.js"),
      import("../../src/modules/email-outbox/email-outbox-worker.js"),
      import("../../src/modules/email/templates/booking/booking-email-data.js"),
    ]);
    return { ...transport, ...service, ...worker, ...bookingData };
  };

  const bookingRow = (payload: Record<string, unknown>) => ({
    _id: new Types.ObjectId(),
    dedupeKey: "BOOKING_CREATED:b1::BOOKING_CUSTOMER_CONFIRMED::dana@example.com",
    eventKey: "BOOKING_CREATED:b1",
    templateKey: "BOOKING_CUSTOMER_CONFIRMED",
    recipient: "dana@example.com",
    payload,
    status: "PENDING" as string,
    attemptCount: 0,
    claimedBy: undefined as string | undefined,
    lastErrorCategory: undefined as string | undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repoFor = (row: ReturnType<typeof bookingRow>) => ({
    resetStaleProcessing: vi.fn(async () => 0),
    claimNext: vi.fn(async () => {
      if (row.status !== "PENDING") return null;
      row.status = "PROCESSING";
      row.attemptCount += 1;
      row.claimedBy = "w";
      return { ...row };
    }),
    markSent: vi.fn(async () => {
      row.status = "SENT";
      return row;
    }),
    scheduleRetry: vi.fn(async (_id: unknown, i: { category: string }) => {
      row.status = "PENDING";
      row.lastErrorCategory = i.category;
      return row;
    }),
    markFailed: vi.fn(async (_id: unknown, i: { category: string }) => {
      row.status = "FAILED";
      row.lastErrorCategory = i.category;
      return row;
    }),
  });

  const options = {
    workerId: "w",
    maxAttempts: 5,
    claimTimeoutMs: 120_000,
    retryBaseMs: 60_000,
    concurrency: 1,
  };

  it("8/9/13/15 a returned Resend 500 on a Booking confirmation is retried under the same event, never SENT", async () => {
    const stack = await loadWorkerStack();
    const payload = stack.buildBookingEmailData(buildBooking({ businessId: buildBusiness()._id }), {
      businessName: "Soho Vintage Barbers",
      includeCustomerBookingLink: true,
    }) as unknown as Record<string, unknown>;
    const row = bookingRow(payload);
    const repo = repoFor(row);
    const { send, factory } = resendClient({ data: null, error: { name: "x", statusCode: 500 } });
    const worker = new stack.EmailOutboxWorker(
      repo as never,
      new stack.EmailService(new stack.ResendEmailTransport(factory)),
      options,
    );

    const counts = await worker.runOnce(5);

    expect(counts).toMatchObject({ sent: 0, retried: 1 });
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      status: "PENDING",
      lastErrorCategory: "PROVIDER_TRANSIENT",
      eventKey: "BOOKING_CREATED:b1",
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: "dana@example.com" });
  });

  it("7/9 an unknown outcome is retried and labelled, never marked FAILED on its own", async () => {
    const stack = await loadWorkerStack();
    const row = bookingRow({});
    const repo = repoFor(row);
    const { factory } = resendClient({ data: null, error: { name: "x", statusCode: null } });
    const service = new stack.EmailService(new stack.ResendEmailTransport(factory));
    vi.spyOn(service, "render").mockReturnValue({ subject: "s", text: "t" });

    await new stack.EmailOutboxWorker(repo as never, service, options).runOnce(5);

    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "PENDING", lastErrorCategory: "PROVIDER_OUTCOME_UNKNOWN" });
  });

  it("14 OTP via Resend: a returned provider error is an OTP delivery failure, not a silent success", async () => {
    baseEnv("resend");
    const { ResendEmailOtpProvider } = await import(
      "../../src/modules/verification/email-otp.provider.js"
    );
    const { factory } = resendClient({ data: null, error: { name: "x", statusCode: 500 } });

    await expect(
      new ResendEmailOtpProvider(factory).sendOtp({ to: "a@example.com", code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "OTP_DELIVERY_FAILED" }] });
  });

  it("14 OTP via Resend: a returned 429 keeps the existing rate-limit mapping", async () => {
    baseEnv("resend");
    const { ResendEmailOtpProvider } = await import(
      "../../src/modules/verification/email-otp.provider.js"
    );
    const { factory } = resendClient({ data: null, error: { name: "x", statusCode: 429 } });

    await expect(
      new ResendEmailOtpProvider(factory).sendOtp({ to: "a@example.com", code: "1234" }),
    ).rejects.toMatchObject({ details: [{ code: "PROVIDER_RATE_LIMITED" }] });
  });
});

describe("limits vs worker lifecycle (static)", () => {
  it("provider timeout < PM2 drain grace < default claim timeout", async () => {
    vi.resetModules();
    const { EMAIL_PROVIDER_REQUEST_TIMEOUT_MS } = await loadErrors();
    const require = createRequire(import.meta.url);
    const worker = require("../../ecosystem.email-worker.config.cjs");
    const envSource = readFileSync(new URL("../../src/config/env.ts", import.meta.url), "utf8");

    expect(envSource).toContain(
      "EMAIL_OUTBOX_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000)",
    );
    expect(EMAIL_PROVIDER_REQUEST_TIMEOUT_MS).toBeLessThan(worker.apps[0].kill_timeout);
    expect(worker.apps[0].kill_timeout).toBeLessThan(120_000);
  });
});
