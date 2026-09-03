import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_STAFF_OAUTH_REDIRECT_URI:
    "http://localhost:3000/api/v1/auth/staff/invitation/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const { signStaffInvitationGoogleState, verifyStaffInvitationGoogleState } = await import(
  "../../src/modules/staff-invitation/staff-invitation-google.state.js"
);

const VALID_ID = "0123456789abcdef01234567";

describe("staff invitation Google OAuth state", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the nonce + invitationId through a signed token", async () => {
    const token = await signStaffInvitationGoogleState({
      nonce: "nonce-abc-123",
      invitationId: VALID_ID,
    });

    await expect(verifyStaffInvitationGoogleState(token)).resolves.toEqual({
      nonce: "nonce-abc-123",
      invitationId: VALID_ID,
    });
  });

  it("rejects a forged / garbage token with STAFF_INVITATION_INVALID_STATE (400)", async () => {
    await expect(verifyStaffInvitationGoogleState("not-a-real-token")).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "STAFF_INVITATION_INVALID_STATE" }],
    });
  });

  it("rejects a token whose signature was tampered with", async () => {
    const good = await signStaffInvitationGoogleState({ nonce: "n", invitationId: VALID_ID });
    const parts = good.split(".");
    const flipped = parts[2]?.slice(-1) === "A" ? "B" : "A";
    parts[2] = `${parts[2]?.slice(0, -1)}${flipped}`;
    await expect(verifyStaffInvitationGoogleState(parts.join("."))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects an empty nonce", async () => {
    const bad = await signStaffInvitationGoogleState({ nonce: "", invitationId: VALID_ID });
    await expect(verifyStaffInvitationGoogleState(bad)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a non-ObjectId invitationId (no id manipulation via a crafted state)", async () => {
    const bad = await signStaffInvitationGoogleState({
      nonce: "n",
      invitationId: "not-an-object-id",
    });
    await expect(verifyStaffInvitationGoogleState(bad)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired token once the 10 minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const token = await signStaffInvitationGoogleState({ nonce: "exp", invitationId: VALID_ID });
    vi.setSystemTime(new Date("2026-09-03T12:10:31.000Z"));
    await expect(verifyStaffInvitationGoogleState(token)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
