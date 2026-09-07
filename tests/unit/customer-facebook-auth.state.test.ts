import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  FACEBOOK_CLIENT_ID: "fb-app-123",
  FACEBOOK_CLIENT_SECRET: "fb-customer-secret",
  FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/customer/oauth/facebook/callback",
  // Distinct secret so a Facebook-link / professional-Facebook state can never verify here.
  FACEBOOK_ACCOUNT_LINK_REDIRECT_URI: "http://localhost:3000/api/v1/auth/oauth/facebook/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signCustomerFacebookState, verifyCustomerFacebookState } = await import(
  "../../src/modules/customer-facebook-auth/customer-facebook-auth.state.js"
);
const { signFacebookLinkState } = await import(
  "../../src/modules/linked-account/linked-account.state.js"
);
const { signProfessionalFacebookState } = await import(
  "../../src/modules/professional-facebook-auth/professional-facebook-auth.state.js"
);

describe("customer Facebook OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce through a signed token", async () => {
    const nonce = "nonce-abc-123";
    const token = await signCustomerFacebookState({ nonce });
    await expect(verifyCustomerFacebookState(token)).resolves.toEqual({ nonce });
  });

  it("rejects a forged/garbage token with CUSTOMER_FACEBOOK_INVALID_STATE (400)", async () => {
    await expect(verifyCustomerFacebookState("not-a-real-signed-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "CUSTOMER_FACEBOOK_INVALID_STATE" }],
    });
  });

  it("rejects a token whose signature was tampered with", async () => {
    const good = await signCustomerFacebookState({ nonce: "n" });
    const parts = good.split(".");
    const flipped = parts[2]?.slice(-1) === "A" ? "B" : "A";
    parts[2] = `${parts[2]?.slice(0, -1)}${flipped}`;
    await expect(verifyCustomerFacebookState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a token missing the nonce claim", async () => {
    const token = await signCustomerFacebookState({ nonce: "" });
    await expect(verifyCustomerFacebookState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const token = await signCustomerFacebookState({ nonce: "expiring" });
    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));
    await expect(verifyCustomerFacebookState(token)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("cannot be satisfied by a Facebook-link state or a Professional-Facebook state (context isolation)", async () => {
    const linkState = await signFacebookLinkState({ userId: "u1" });
    await expect(verifyCustomerFacebookState(linkState)).rejects.toMatchObject({ statusCode: 400 });

    const proState = await signProfessionalFacebookState({
      nonce: "n",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    await expect(verifyCustomerFacebookState(proState)).rejects.toMatchObject({ statusCode: 400 });
  });
});
