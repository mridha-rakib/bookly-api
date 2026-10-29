import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { verifyPackageBatchActivation } from "../../src/modules/booking/package-batch-authority.js";
import {
  APPROVED_CONSENT_TIME_AUTHORITIES,
  assessConsentCommitDeadline,
  PACKAGE_CONSENT_STRICT_LIFETIME_MS,
  type TrustedTimeInterval,
} from "../../src/modules/booking/package-consent-commit-deadline.js";

/**
 * P1A — decision logic of the strict consent-commit deadline. These are arithmetic tests over
 * synthetic, pre-verified intervals. They are NOT a durable-commit proof: no time authority is
 * approved (D7) and no real commit timing is observed here.
 */

const Q = Date.UTC(2026, 9, 27, 9, 0, 0, 0);
const D = Q + PACKAGE_CONSENT_STRICT_LIFETIME_MS;
const SYNTHETIC = ["synthetic-test-authority"]; // engineering-only registry, not an approval

const interval = (earliestMs: number, latestMs: number, authorityId = SYNTHETIC[0] as string) =>
  ({ authorityId, earliestMs, latestMs }) satisfies TrustedTimeInterval;

const input = (over: Partial<Parameters<typeof assessConsentCommitDeadline>[0]> = {}) => ({
  retainedIssuedAtMs: Q,
  retainedExpiresAtMs: D,
  issuanceAttestation: interval(Q - 1_000, Q + 1_000),
  postCommitObservation: interval(D - 10_000, D - 5_000),
  ...over,
});

describe("shipped state", () => {
  it("approves no time authority and so never certifies", () => {
    expect(APPROVED_CONSENT_TIME_AUTHORITIES).toEqual([]);
    expect(Object.isFrozen(APPROVED_CONSENT_TIME_AUTHORITIES)).toBe(true);
    expect(assessConsentCommitDeadline(input())).toEqual({
      kind: "UNRESOLVED",
      reason: "TIME_AUTHORITY_NOT_APPROVED",
    });
  });

  it("Package purchase activation stays denied regardless of any assessment", async () => {
    await expect(verifyPackageBatchActivation()).rejects.toMatchObject({ statusCode: 503 });
    const source = readFileSync(
      new URL("../../src/modules/booking/package-batch-authority.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("package-consent-commit-deadline");
  });

  it("uses exactly the Owner-approved 30-minute lifetime", () => {
    expect(PACKAGE_CONSENT_STRICT_LIFETIME_MS).toBe(1_800_000);
  });
});

describe("strict deadline arithmetic (synthetic registry)", () => {
  it("certifies only when the post-commit upper bound is strictly before the deadline", () => {
    expect(assessConsentCommitDeadline(input(), SYNTHETIC)).toEqual({
      kind: "CERTIFIED",
      deadlineMs: Q - 1_000 + PACKAGE_CONSENT_STRICT_LIFETIME_MS,
      commitLatestMs: D - 5_000,
    });
  });

  it("valid boundary: latest = deadline − 1 ms certifies; latest = deadline does not", () => {
    const issuance = interval(Q, Q);
    const ok = input({
      issuanceAttestation: issuance,
      postCommitObservation: interval(D - 2, D - 1),
    });
    const equal = input({
      issuanceAttestation: issuance,
      postCommitObservation: interval(D - 1, D),
    });
    expect(assessConsentCommitDeadline(ok, SYNTHETIC).kind).toBe("CERTIFIED");
    expect(assessConsentCommitDeadline(equal, SYNTHETIC)).toEqual({
      kind: "UNRESOLVED",
      reason: "COMMIT_NOT_PROVEN_BEFORE_DEADLINE",
    });
  });

  it("request started before expiry but commit observed after it is never certified", () => {
    // The application-clock acceptedAt would be before D; only the commit bound counts.
    const late = input({ postCommitObservation: interval(D + 1, D + 3_000) });
    expect(assessConsentCommitDeadline(late, SYNTHETIC).kind).toBe("UNRESOLVED");
  });

  it("an uncertain interval straddling the deadline is unresolved, never certified or 'late'", () => {
    const straddle = input({ postCommitObservation: interval(D - 3_000, D + 3_000) });
    expect(assessConsentCommitDeadline(straddle, SYNTHETIC)).toEqual({
      kind: "UNRESOLVED",
      reason: "COMMIT_NOT_PROVEN_BEFORE_DEADLINE",
    });
  });

  it("commit outcome unknown (no commit evidence) is unresolved", () => {
    expect(
      assessConsentCommitDeadline(input({ postCommitObservation: undefined }), SYNTHETIC),
    ).toEqual({ kind: "UNRESOLVED", reason: "NO_COMMIT_EVIDENCE" });
  });

  it("issuance without trusted attestation is unresolved (application clock is not trusted)", () => {
    expect(
      assessConsentCommitDeadline(input({ issuanceAttestation: undefined }), SYNTHETIC),
    ).toEqual({ kind: "UNRESOLVED", reason: "ISSUANCE_NOT_ATTESTED" });
  });

  it("never extends the window: a later attested issuance does not move the deadline", () => {
    const laterIssuance = input({
      issuanceAttestation: interval(Q + 60_000, Q + 61_000),
      postCommitObservation: interval(D + 10_000, D + 20_000),
    });
    expect(assessConsentCommitDeadline(laterIssuance, SYNTHETIC).kind).toBe("UNRESOLVED");
  });

  it("an earlier attested issuance shortens the window (conservative under every D3 reading)", () => {
    const earlier = input({
      issuanceAttestation: interval(Q - 60_000, Q - 59_000),
      postCommitObservation: interval(D - 50_000, D - 30_000),
    });
    expect(assessConsentCommitDeadline(earlier, SYNTHETIC)).toEqual({
      kind: "UNRESOLVED",
      reason: "COMMIT_NOT_PROVEN_BEFORE_DEADLINE",
    });
  });

  it.each([
    [
      "a non-30-minute retained window",
      { retainedExpiresAtMs: D + 1 },
      "LIFETIME_NOT_OWNER_APPROVED",
    ],
    [
      "a reset / renewed expiry",
      { retainedExpiresAtMs: D + 60_000 },
      "LIFETIME_NOT_OWNER_APPROVED",
    ],
    ["a fractional timestamp", { retainedIssuedAtMs: Q + 0.5 }, "INVALID_INPUT"],
    ["an inverted interval", { postCommitObservation: interval(D - 1, D - 2) }, "INVALID_INPUT"],
    [
      "an unapproved commit authority",
      { postCommitObservation: interval(D - 10, D - 5, "other") },
      "TIME_AUTHORITY_NOT_APPROVED",
    ],
    [
      "an unapproved issuance authority",
      { issuanceAttestation: interval(Q, Q, "other") },
      "TIME_AUTHORITY_NOT_APPROVED",
    ],
  ] as const)("refuses %s", (_name, over, reason) => {
    expect(assessConsentCommitDeadline(input(over as never), SYNTHETIC)).toEqual({
      kind: "UNRESOLVED",
      reason,
    });
  });
});
