import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  APPLE_CLIENT_ID: "cy.bookly.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "YXBwbGUtcHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
  APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "https://bookly.cy/api/v1/auth/professional/oauth/apple/callback",
  APPLE_CUSTOMER_OAUTH_REDIRECT_URI: "https://bookly.cy/api/v1/auth/customer/oauth/apple/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signProfessionalAppleState, verifyProfessionalAppleState } = await import(
  "../../src/modules/professional-apple-auth/professional-apple-auth.state.js"
);
const { signCustomerAppleState } = await import(
  "../../src/modules/customer-apple-auth/customer-apple-auth.state.js"
);

describe("professional Apple OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips nonce + visitType", async () => {
    const token = await signProfessionalAppleState({
      nonce: "n1",
      visitType: "AT_BUSINESS_LOCATION",
    });
    await expect(verifyProfessionalAppleState(token)).resolves.toEqual({
      nonce: "n1",
      visitType: "AT_BUSINESS_LOCATION",
    });
  });

  it("rejects a forged token with PROFESSIONAL_APPLE_INVALID_STATE (400)", async () => {
    await expect(verifyProfessionalAppleState("garbage")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "PROFESSIONAL_APPLE_INVALID_STATE" }],
    });
  });

  it("rejects a tampered payload", async () => {
    const good = await signProfessionalAppleState({ nonce: "n", visitType: "TRAVEL_TO_CUSTOMER" });
    const parts = good.split(".");
    parts[1] = `${parts[1]?.[0] === "e" ? "X" : "e"}${parts[1]?.slice(1)}`;
    await expect(verifyProfessionalAppleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const token = await signProfessionalAppleState({
      nonce: "expiring",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));
    await expect(verifyProfessionalAppleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("context isolation: a Customer-Apple state cannot verify here", async () => {
    const customerState = await signCustomerAppleState({ nonce: "n" });
    await expect(verifyProfessionalAppleState(customerState)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
