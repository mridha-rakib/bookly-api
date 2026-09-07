import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  FACEBOOK_CLIENT_ID: "fb-app-123",
  FACEBOOK_CLIENT_SECRET: "fb-professional-secret",
  FACEBOOK_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/professional/oauth/facebook/callback",
  FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/customer/oauth/facebook/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signProfessionalFacebookState, verifyProfessionalFacebookState } = await import(
  "../../src/modules/professional-facebook-auth/professional-facebook-auth.state.js"
);
const { signCustomerFacebookState } = await import(
  "../../src/modules/customer-facebook-auth/customer-facebook-auth.state.js"
);

describe("professional Facebook OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce + visitType through a signed token", async () => {
    const token = await signProfessionalFacebookState({
      nonce: "n1",
      visitType: "AT_BUSINESS_LOCATION",
    });
    await expect(verifyProfessionalFacebookState(token)).resolves.toEqual({
      nonce: "n1",
      visitType: "AT_BUSINESS_LOCATION",
    });
  });

  it("rejects a forged token with PROFESSIONAL_FACEBOOK_INVALID_STATE (400)", async () => {
    await expect(verifyProfessionalFacebookState("garbage")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "PROFESSIONAL_FACEBOOK_INVALID_STATE" }],
    });
  });

  it("rejects a token whose payload was tampered with (signature no longer matches)", async () => {
    const good = await signProfessionalFacebookState({
      nonce: "n",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    const parts = good.split(".");
    // Mutate the payload segment — guarantees an HS256 signature mismatch.
    const payload = parts[1] ?? "";
    const swapped = payload[0] === "e" ? `X${payload.slice(1)}` : `e${payload.slice(1)}`;
    parts[1] = swapped;
    await expect(verifyProfessionalFacebookState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const token = await signProfessionalFacebookState({
      nonce: "expiring",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));
    await expect(verifyProfessionalFacebookState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("cannot be satisfied by a Customer-Facebook state (context isolation)", async () => {
    const customerState = await signCustomerFacebookState({ nonce: "n" });
    await expect(verifyProfessionalFacebookState(customerState)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
