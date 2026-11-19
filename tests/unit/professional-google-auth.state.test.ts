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

  it("round-trips the nonce through a signed token", async () => {
    const token = await signProfessionalGoogleState({ nonce: "nonce-abc-123" });

    await expect(verifyProfessionalGoogleState(token)).resolves.toEqual({
      nonce: "nonce-abc-123",
    });
  });

  it("rejects a forged/garbage token with PROFESSIONAL_GOOGLE_INVALID_STATE (400)", async () => {
    await expect(verifyProfessionalGoogleState("not-a-real-signed-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "PROFESSIONAL_GOOGLE_INVALID_STATE" }],
    });
  });

  it("rejects a token whose signature was tampered with", async () => {
    const good = await signProfessionalGoogleState({ nonce: "n" });
    const parts = good.split(".");
    // Change the FIRST signature character: the last base64url character of a 32-byte HS256
    // signature carries padding bits, so swapping A<->B there can leave the signature valid.
    const signature = parts[2] ?? "";
    const flipped = signature[0] === "A" ? "B" : "A";
    parts[2] = `${flipped}${signature.slice(1)}`;

    await expect(verifyProfessionalGoogleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an empty nonce", async () => {
    const bad = await signProfessionalGoogleState({ nonce: "" });
    await expect(verifyProfessionalGoogleState(bad)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));

    const token = await signProfessionalGoogleState({ nonce: "expiring" });

    vi.setSystemTime(new Date("2026-09-03T12:10:31.000Z"));

    await expect(verifyProfessionalGoogleState(token)).rejects.toMatchObject({ statusCode: 400 });
  });
});
