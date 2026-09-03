import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_PROFESSIONAL_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/professional/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signProfessionalGoogleState, verifyProfessionalGoogleState } = await import(
  "../../src/modules/professional-google-auth/professional-google-auth.state.js"
);

describe("professional Google OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce + visitType through a signed token", async () => {
    const token = await signProfessionalGoogleState({
      nonce: "nonce-abc-123",
      visitType: "AT_BUSINESS_LOCATION",
    });

    await expect(verifyProfessionalGoogleState(token)).resolves.toEqual({
      nonce: "nonce-abc-123",
      visitType: "AT_BUSINESS_LOCATION",
    });
  });

  it("rejects a forged/garbage token with PROFESSIONAL_GOOGLE_INVALID_STATE (400)", async () => {
    await expect(verifyProfessionalGoogleState("not-a-real-signed-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "PROFESSIONAL_GOOGLE_INVALID_STATE" }],
    });
  });

  it("rejects a token whose signature was tampered with", async () => {
    const good = await signProfessionalGoogleState({
      nonce: "n",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    const parts = good.split(".");
    const flipped = parts[2]?.slice(-1) === "A" ? "B" : "A";
    parts[2] = `${parts[2]?.slice(0, -1)}${flipped}`;

    await expect(verifyProfessionalGoogleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a token with an unknown / missing visitType", async () => {
    const bad = await signProfessionalGoogleState({
      nonce: "n",
      visitType: "SOMETHING_ELSE" as never,
    });
    await expect(verifyProfessionalGoogleState(bad)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an empty nonce", async () => {
    const bad = await signProfessionalGoogleState({
      nonce: "",
      visitType: "AT_BUSINESS_LOCATION",
    });
    await expect(verifyProfessionalGoogleState(bad)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));

    const token = await signProfessionalGoogleState({
      nonce: "expiring",
      visitType: "AT_BUSINESS_LOCATION",
    });

    vi.setSystemTime(new Date("2026-09-03T12:10:31.000Z"));

    await expect(verifyProfessionalGoogleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });
});
