import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_ACCOUNT_LINK_REDIRECT_URI: "http://localhost:3000/api/v1/auth/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signGoogleLinkState, verifyGoogleLinkState } = await import(
  "../../src/modules/linked-account/linked-account.state.js"
);

describe("linked-account OAuth state", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips the userId through a signed token", async () => {
    const userId = "64b7f0c2a1b2c3d4e5f60718";
    const token = await signGoogleLinkState({ userId });

    await expect(verifyGoogleLinkState(token)).resolves.toEqual({ userId });
  });

  it("rejects a tampered/forged token with LINKED_ACCOUNT_INVALID_STATE (400)", async () => {
    await expect(verifyGoogleLinkState("not-a-real-signed-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "LINKED_ACCOUNT_INVALID_STATE" }],
    });
  });

  it("rejects a token signed with a different secret (signature mismatch)", async () => {
    const good = await signGoogleLinkState({ userId: "abc" });

    // Flip the final character of the signature segment.
    const parts = good.split(".");
    const lastChar = parts[2]?.slice(-1) === "A" ? "B" : "A";
    parts[2] = `${parts[2]?.slice(0, -1)}${lastChar}`;

    await expect(verifyGoogleLinkState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));

    const token = await signGoogleLinkState({ userId: "expiry-user" });

    // 10m TTL + a small margin.
    vi.setSystemTime(new Date("2026-09-02T12:10:31.000Z"));

    await expect(verifyGoogleLinkState(token)).rejects.toMatchObject({ statusCode: 400 });
  });
});
