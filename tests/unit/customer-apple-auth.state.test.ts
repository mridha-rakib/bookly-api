import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  APPLE_CLIENT_ID: "cy.bookly.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "YXBwbGUtcHJpdmF0ZS1rZXktbWF0ZXJpYWw=", // base64("apple-private-key-material")
  APPLE_CUSTOMER_OAUTH_REDIRECT_URI: "https://bookly.cy/api/v1/auth/customer/oauth/apple/callback",
  APPLE_ACCOUNT_LINK_REDIRECT_URI: "https://bookly.cy/api/v1/auth/oauth/apple/callback",
  GOOGLE_CLIENT_SECRET: "g-secret",
  FACEBOOK_CLIENT_SECRET: "f-secret",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signCustomerAppleState, verifyCustomerAppleState } = await import(
  "../../src/modules/customer-apple-auth/customer-apple-auth.state.js"
);
const { signAppleLinkState } = await import(
  "../../src/modules/linked-account/linked-account.state.js"
);
const { signProfessionalAppleState } = await import(
  "../../src/modules/professional-apple-auth/professional-apple-auth.state.js"
);
const { signCustomerGoogleState } = await import(
  "../../src/modules/customer-google-auth/customer-google-auth.state.js"
);
const { signCustomerFacebookState } = await import(
  "../../src/modules/customer-facebook-auth/customer-facebook-auth.state.js"
);

describe("customer Apple OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce", async () => {
    const token = await signCustomerAppleState({ nonce: "nonce-abc" });
    await expect(verifyCustomerAppleState(token)).resolves.toEqual({ nonce: "nonce-abc" });
  });

  it("rejects a forged token with CUSTOMER_APPLE_INVALID_STATE (400)", async () => {
    await expect(verifyCustomerAppleState("garbage")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "CUSTOMER_APPLE_INVALID_STATE" }],
    });
  });

  it("rejects a tampered payload", async () => {
    const good = await signCustomerAppleState({ nonce: "n" });
    const parts = good.split(".");
    parts[1] = `${parts[1]?.[0] === "e" ? "X" : "e"}${parts[1]?.slice(1)}`;
    await expect(verifyCustomerAppleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an expired token (10-min TTL)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const token = await signCustomerAppleState({ nonce: "expiring" });
    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));
    await expect(verifyCustomerAppleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("context isolation: cannot verify an Apple-link / Professional-Apple / Google / Facebook state", async () => {
    for (const other of [
      await signAppleLinkState({ userId: "u1", nonce: "n" }),
      await signProfessionalAppleState({ nonce: "n", visitType: "TRAVEL_TO_CUSTOMER" }),
      await signCustomerGoogleState({ nonce: "n" }),
      await signCustomerFacebookState({ nonce: "n" }),
    ]) {
      await expect(verifyCustomerAppleState(other)).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});
