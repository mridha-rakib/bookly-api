import { afterEach, expect, it, vi } from "vitest";
import { syntheticConsentHost, syntheticHostObservation } from "../helpers/consent-host-fixture.js";

afterEach(() => {
  vi.doUnmock("../../src/modules/booking/trusted-time/approved-consent-host-input.js");
  vi.resetModules();
});

it("wires the shipped host and historical verifier to an explicit synthetic release input", async () => {
  const { auditKey, ...profile } = syntheticConsentHost;
  const resolve = vi.fn(() => Buffer.from(auditKey));
  const entry = {
    version: 1 as const,
    qualificationReference: "test-only",
    chronycSha256: "a".repeat(64),
    chronydSha256: "b".repeat(64),
    profile,
    keyReference: "test-key",
    keyVersion: "test-v1",
    disposition: "CURRENT" as const,
  };
  vi.doMock("../../src/modules/booking/trusted-time/approved-consent-host-input.js", () => ({
    approvedConsentHostInput: {
      policy: {
        version: 1,
        approvalReference: "synthetic-only",
        maxAcquireMs: profile.maxAcquireMs,
        maxSampleAgeMs: profile.maxSampleAgeMs,
        maxErrorMs: profile.maxErrorMs,
        maxDriftPpm: profile.maxDriftPpm,
        minRemainingMs: profile.minRemainingMs,
      },
      entries: [entry],
      resolveProtectedKey: resolve,
    },
  }));
  const host = await import("../../src/modules/booking/trusted-time/qualified-host.js");
  const clock = await import("../../src/modules/booking/trusted-time/host-clock.js");
  expect(host.requireQualifiedConsentHost().authorityId).toBe(profile.authorityId);
  const witness = "c".repeat(64);
  expect(
    clock.verifyConsentHostObservation(syntheticHostObservation(witness), witness).hostId,
  ).toBe(profile.hostId);
  expect(resolve.mock.calls).toHaveLength(2);
  expect(() =>
    host.requireConsentHostVerificationProfile({
      authorityId: profile.authorityId,
      hostId: profile.hostId,
      configurationHash: profile.configurationHash,
      approvedBootId: "bbbb2222-2222-4222-8222-222222222222",
    }),
  ).toThrow(expect.objectContaining({ statusCode: 503 }));
  expect(resolve.mock.calls).toHaveLength(2);
  const { readPackageCheckoutReadiness } = await import(
    "../../src/modules/booking/package-checkout-availability.js"
  );
  await expect(
    readPackageCheckoutReadiness({ enabled: true, lifetimeMs: 1_800_000 }),
  ).resolves.toEqual({ available: false, reason: "BATCH_AUTHORITY_UNAVAILABLE" });
  resolve.mockImplementation(() => {
    throw new Error("protected key unavailable");
  });
  expect(() => host.requireQualifiedConsentHost()).toThrow(
    expect.objectContaining({ statusCode: 503 }),
  );
  expect(() =>
    clock.verifyConsentHostObservation(syntheticHostObservation(witness), witness),
  ).toThrow(expect.objectContaining({ statusCode: 503 }));
});

it("denies a revoked release entry for issuance and historical verification", async () => {
  const { auditKey, ...profile } = syntheticConsentHost;
  const resolve = vi.fn(() => Buffer.from(auditKey));
  vi.doMock("../../src/modules/booking/trusted-time/approved-consent-host-input.js", () => ({
    approvedConsentHostInput: {
      policy: {
        version: 1,
        approvalReference: "synthetic-only",
        maxAcquireMs: profile.maxAcquireMs,
        maxSampleAgeMs: profile.maxSampleAgeMs,
        maxErrorMs: profile.maxErrorMs,
        maxDriftPpm: profile.maxDriftPpm,
        minRemainingMs: profile.minRemainingMs,
      },
      entries: [
        {
          version: 1,
          qualificationReference: "test-only",
          chronycSha256: "a".repeat(64),
          chronydSha256: "b".repeat(64),
          profile,
          keyReference: "test-key",
          keyVersion: "test-v1",
          disposition: "REVOKED",
        },
      ],
      resolveProtectedKey: resolve,
    },
  }));
  const host = await import("../../src/modules/booking/trusted-time/qualified-host.js");
  expect(() => host.requireQualifiedConsentHost()).toThrow(
    expect.objectContaining({ statusCode: 503 }),
  );
  expect(() => host.requireConsentHostVerificationProfile(profile)).toThrow(
    expect.objectContaining({ statusCode: 503 }),
  );
  expect(resolve).not.toHaveBeenCalled();
});
