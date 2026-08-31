import { describe, expect, it } from "vitest";

import {
  classifySmsProviderError,
  isRetryableSmsErrorCategory,
  SmsError,
} from "../../src/modules/sms/sms.errors.js";

describe("classifySmsProviderError", () => {
  it("maps documented permanent Twilio codes to terminal categories", () => {
    expect(classifySmsProviderError({ code: 21211, status: 400 }).category).toBe(
      "INVALID_DESTINATION",
    );
    expect(classifySmsProviderError({ code: 21610 }).category).toBe(
      "PROVIDER_PERMISSION_OR_SENDER_ERROR",
    );
    expect(classifySmsProviderError({ code: 21612 }).category).toBe("RECIPIENT_UNREACHABLE");
    expect(classifySmsProviderError({ code: 20003 }).category).toBe("PROVIDER_AUTH_ERROR");
  });

  it("maps Twilio 20429 and HTTP 429 to RATE_LIMITED (retryable)", () => {
    expect(classifySmsProviderError({ code: 20429 }).category).toBe("RATE_LIMITED");
    expect(classifySmsProviderError({ status: 429 }).category).toBe("RATE_LIMITED");
    expect(isRetryableSmsErrorCategory("RATE_LIMITED")).toBe(true);
  });

  it("maps 5xx to PROVIDER_TRANSIENT (retryable) and other 4xx to permanent", () => {
    expect(classifySmsProviderError({ status: 503 }).category).toBe("PROVIDER_TRANSIENT");
    expect(isRetryableSmsErrorCategory("PROVIDER_TRANSIENT")).toBe(true);
    expect(classifySmsProviderError({ status: 401 }).category).toBe("PROVIDER_AUTH_ERROR");
    expect(classifySmsProviderError({ status: 403 }).category).toBe(
      "PROVIDER_PERMISSION_OR_SENDER_ERROR",
    );
    expect(classifySmsProviderError({ status: 422 }).category).toBe("PROVIDER_PERMANENT");
    expect(isRetryableSmsErrorCategory("PROVIDER_PERMANENT")).toBe(false);
  });

  it("treats network error codes / messages as NETWORK_TRANSIENT (retryable)", () => {
    expect(classifySmsProviderError({ code: "ECONNRESET" }).category).toBe("NETWORK_TRANSIENT");
    expect(classifySmsProviderError({ message: "socket hang up" }).category).toBe(
      "NETWORK_TRANSIENT",
    );
  });

  it("defaults an unrecognised / non-object error to PROVIDER_TRANSIENT", () => {
    expect(classifySmsProviderError("boom").category).toBe("PROVIDER_TRANSIENT");
    expect(classifySmsProviderError({ weird: true }).category).toBe("PROVIDER_TRANSIENT");
  });

  it("never echoes a raw provider body — safeProviderMessage is generic", () => {
    const secretish = { status: 400, message: "AC_secret_sid leaked in body", code: 21211 };
    const { safeProviderMessage } = classifySmsProviderError(secretish);
    expect(safeProviderMessage).not.toContain("AC_secret_sid");
  });
});

describe("SmsError", () => {
  it("is non-exposing and carries category + retryable", () => {
    const err = new SmsError("NETWORK_TRANSIENT", { cause: { secret: "x" } });
    expect(err.retryable).toBe(true);
    expect(err.category).toBe("NETWORK_TRANSIENT");
    expect(err.statusCode).toBe(502);
    // expose is false → the raw cause never reaches an HTTP surface
    expect(err.expose).toBe(false);
  });

  it("NOT_CONFIGURED is a 503 and not retryable", () => {
    const err = new SmsError("NOT_CONFIGURED");
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(false);
  });
});
