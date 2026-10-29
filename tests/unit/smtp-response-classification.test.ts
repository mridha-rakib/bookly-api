import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * F4A Tier 3 — SMTP reply codes (nodemailer `responseCode`) use SMTP semantics, not HTTP:
 * 4xx temporary, 5xx permanent. SendGrid/Resend (HTTP) and Tier 1 timeouts are unchanged.
 * Synthetic error objects only.
 */

const loadErrors = async () => {
  vi.resetModules();
  return import("../../src/modules/email/email.errors.js");
};

afterEach(() => vi.restoreAllMocks());

describe("SMTP response-code classification (21)", () => {
  it.each([
    [{ responseCode: 421, code: "EENVELOPE" }, "PROVIDER_TRANSIENT", true],
    [{ responseCode: 450, code: "EENVELOPE" }, "PROVIDER_TRANSIENT", true],
    [{ responseCode: 451, code: "EMESSAGE" }, "PROVIDER_TRANSIENT", true],
    [{ responseCode: 452, code: "EENVELOPE" }, "PROVIDER_TRANSIENT", true],
    [{ responseCode: 535, code: "EAUTH" }, "PROVIDER_AUTH_ERROR", false],
    [{ responseCode: 530, code: "EAUTH" }, "PROVIDER_AUTH_ERROR", false],
    [{ responseCode: 550, code: "EENVELOPE" }, "PROVIDER_PERMANENT", false],
    [{ responseCode: 553, code: "EENVELOPE" }, "PROVIDER_PERMANENT", false],
    [{ responseCode: 554, code: "EMESSAGE" }, "PROVIDER_PERMANENT", false],
    [{ responseCode: 552, code: "EMESSAGE" }, "INVALID_MESSAGE", false],
    [{ responseCode: 501, code: "EENVELOPE" }, "INVALID_MESSAGE", false],
    // Not an SMTP code — keeps its existing mapping (verification-providers.test.ts relies on it).
    [{ responseCode: 429 }, "RATE_LIMITED", true],
  ] as const)("%j → %s (retryable=%s)", async (error, category, retryable) => {
    const { classifyEmailProviderError, isRetryableEmailErrorCategory } = await loadErrors();
    const result = classifyEmailProviderError(error);
    expect(result.category).toBe(category);
    expect(isRetryableEmailErrorCategory(result.category)).toBe(retryable);
    expect(result.providerStatus).toBe(error.responseCode);
    expect(result.safeProviderMessage).toBe(`SMTP server replied ${error.responseCode}`);
  });

  it("an SMTP reply is definitive; a timeout without a reply stays unknown (Tier 1)", async () => {
    const { classifyEmailProviderError } = await loadErrors();
    expect(classifyEmailProviderError({ responseCode: 451 }).category).not.toBe(
      "PROVIDER_OUTCOME_UNKNOWN",
    );
    expect(classifyEmailProviderError({ code: "ETIMEDOUT", command: "CONN" }).category).toBe(
      "PROVIDER_OUTCOME_UNKNOWN",
    );
  });

  it("HTTP providers are unaffected (SendGrid `code`, Resend `statusCode`)", async () => {
    const { classifyEmailProviderError } = await loadErrors();
    expect(classifyEmailProviderError({ code: 503 }).category).toBe("PROVIDER_TRANSIENT");
    expect(classifyEmailProviderError({ code: 400 }).category).toBe("INVALID_MESSAGE");
    expect(classifyEmailProviderError({ statusCode: 500 }).category).toBe("PROVIDER_TRANSIENT");
    expect(classifyEmailProviderError({ statusCode: 422 }).category).toBe("PROVIDER_PERMANENT");
  });

  it("never echoes the SMTP server's response text", async () => {
    const { classifyEmailProviderError } = await loadErrors();
    const result = classifyEmailProviderError({
      responseCode: 550,
      response: "550 5.1.1 <victim@example.com>: user unknown",
    });
    expect(JSON.stringify(result)).not.toContain("victim@example.com");
  });
});
