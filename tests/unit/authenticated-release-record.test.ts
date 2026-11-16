import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAuthenticatedReleaseRecord } from "../../src/modules/booking/trusted-time/authenticated-release-record.js";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const { auditKey: _secret, ...originalProfile } = syntheticConsentHost;
const profile = { ...originalProfile, referenceIds: [...originalProfile.referenceIds] };
const current = {
  version: 1 as const,
  qualificationReference: "synthetic-only",
  chronycSha256: "a".repeat(64),
  chronydSha256: "b".repeat(64),
  profile,
  keyReference: "synthetic",
  keyVersion: "v1",
  disposition: "CURRENT" as const,
};
const release = () => ({
  version: 1,
  approvalReference: "test-approval",
  releaseSha: "a".repeat(40),
  validFromMs: 1000,
  validUntilMs: 2000,
  lifetimeMs: 1_800_000,
  policy: {
    version: 1,
    approvalReference: "test-policy",
    maxAcquireMs: profile.maxAcquireMs,
    maxSampleAgeMs: profile.maxSampleAgeMs,
    maxErrorMs: profile.maxErrorMs,
    maxDriftPpm: profile.maxDriftPpm,
    minRemainingMs: profile.minRemainingMs,
  },
  entries: [current],
  keyRoot: "/var/lib/bookly/keys",
  readerGroupId: 42,
});
const signed = (payload: Buffer) =>
  sign(null, Buffer.concat([Buffer.from("bookly:first-class-release:v1\0"), payload]), privateKey);
const fixture = (value: unknown = release()) => {
  const payload = Buffer.from(JSON.stringify(value));
  return {
    payload,
    signature: signed(payload),
    approvalPublicKey: publicKey,
    verifiedRunningReleaseSha: "a".repeat(40),
    verifiedHostIdentity: profile,
    trustedNow: { earliestMs: 1100, latestMs: 1900 },
    previousEntries: [],
  };
};

describe("synthetic signed First-Class release verifier", () => {
  it("accepts a signed, bound, current release with an approved synthetic policy", () => {
    expect(verifyAuthenticatedReleaseRecord(fixture()).current.profile.authorityId).toBe(
      profile.authorityId,
    );
  });
  it("rejects altered data, wrong signatures and a different running SHA", () => {
    const good = fixture();
    const wrongKey = generateKeyPairSync("ed25519").publicKey;
    expect(() =>
      verifyAuthenticatedReleaseRecord({ ...good, payload: Buffer.from("{}") }),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord({ ...good, signature: Buffer.alloc(64) }),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord({ ...good, approvalPublicKey: wrongKey }),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord({ ...good, verifiedRunningReleaseSha: "b".repeat(40) }),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord({
        ...good,
        verifiedHostIdentity: {
          ...profile,
          approvedBootId: "bbbb2222-2222-4222-8222-222222222222",
        },
      }),
    ).toThrow();
  });
  it("rejects not-yet-valid, expired, malformed and noncanonical records", () => {
    const good = fixture();
    for (const trustedNow of [
      { earliestMs: 999, latestMs: 1200 },
      { earliestMs: 1500, latestMs: 2000 },
      { earliestMs: 1800, latestMs: 1700 },
    ])
      expect(() => verifyAuthenticatedReleaseRecord({ ...good, trustedNow })).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord(fixture({ ...release(), lifetimeMs: 1799999 })),
    ).toThrow();
    const duplicate = Buffer.from('{"version":1,"version":1}');
    expect(() =>
      verifyAuthenticatedReleaseRecord({
        ...good,
        payload: duplicate,
        signature: signed(duplicate),
      }),
    ).toThrow();
  });
  it("denies mismatched policy and removal or resurrection of prior authority", () => {
    expect(() =>
      verifyAuthenticatedReleaseRecord(
        fixture({ ...release(), policy: { ...release().policy, maxErrorMs: 999 } }),
      ),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord({
        ...fixture(),
        previousEntries: [{ ...current, disposition: "REVOKED" }],
      }),
    ).toThrow();
    expect(() =>
      verifyAuthenticatedReleaseRecord(
        fixture({ ...release(), entries: [{ ...current, disposition: "REVOKED" }] }),
      ),
    ).toThrow();
  });
  it("retains the exact historical verification generation", () => {
    const previous = {
      ...current,
      profile: { ...current.profile, authorityId: "older-generation" },
      disposition: "VERIFY_ONLY" as const,
    };
    const value = { ...release(), entries: [previous, current] };
    expect(
      verifyAuthenticatedReleaseRecord({ ...fixture(value), previousEntries: [previous] }).record
        .entries,
    ).toHaveLength(2);
    expect(() =>
      verifyAuthenticatedReleaseRecord({ ...fixture(), previousEntries: [previous] }),
    ).toThrow();
  });
});
