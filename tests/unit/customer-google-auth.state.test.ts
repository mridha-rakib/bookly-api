import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/customer/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signCustomerGoogleState, verifyCustomerGoogleState } = await import(
  "../../src/modules/customer-google-auth/customer-google-auth.state.js"
);

describe("customer Google OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce through a signed token", async () => {
    const nonce = "nonce-abc-123";
    const token = await signCustomerGoogleState({ nonce });

    await expect(verifyCustomerGoogleState(token)).resolves.toEqual({ nonce });
  });

  it("rejects a forged/garbage token with CUSTOMER_GOOGLE_INVALID_STATE (400)", async () => {
    await expect(verifyCustomerGoogleState("not-a-real-signed-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "CUSTOMER_GOOGLE_INVALID_STATE" }],
    });
  });

  it("rejects a token whose signature was tampered with", async () => {
    const good = await signCustomerGoogleState({ nonce: "n" });
    const parts = good.split(".");
    const flipped = parts[2]?.slice(-1) === "A" ? "B" : "A";
    parts[2] = `${parts[2]?.slice(0, -1)}${flipped}`;

    await expect(verifyCustomerGoogleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a token missing the nonce claim", async () => {
    // A validly-signed token for a different payload shape.
    const token = await signCustomerGoogleState({ nonce: "" });
    await expect(verifyCustomerGoogleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));

    const token = await signCustomerGoogleState({ nonce: "expiring" });

    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));

    await expect(verifyCustomerGoogleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });
});
