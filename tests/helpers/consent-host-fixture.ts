import { createHmac } from "node:crypto";
import { hashCanonicalPackageCheckoutContent as digest } from "../../src/modules/booking/package-checkout-binding.js";
import type { HostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import type { QualifiedConsentHost } from "../../src/modules/booking/trusted-time/qualified-host.js";

/** Synthetic numerical policy and key ONLY for isolated tests. No deployment recommendation. */
export const syntheticConsentHost: QualifiedConsentHost = {
  approvedBootId: "aaaa1111-1111-4111-8111-111111111111",
  authorityId: "synthetic-host",
  hostId: "test-only",
  configurationHash: "a".repeat(64),
  chronycPath: "/never-execute-test-clock",
  chronycSocketPath: "/never-connect-test-socket",
  chronycVersionOutput: "synthetic-version",
  referenceIds: ["TEST"],
  maxAcquireMs: 5000,
  maxSampleAgeMs: 10000,
  maxErrorMs: 1000,
  maxDriftPpm: 100,
  minRemainingMs: 1000,
  auditKey: Buffer.alloc(32, 19),
};
export function syntheticHostObservation(
  witnessHash: string,
  overrides: Partial<Omit<HostObservation, "seal">> = {},
): HostObservation {
  const payload = {
    version: 1 as const,
    authorityId: syntheticConsentHost.authorityId,
    hostId: syntheticConsentHost.hostId,
    configurationHash: syntheticConsentHost.configurationHash,
    bootId: "aaaa1111-1111-4111-8111-111111111111",
    witnessHash,
    earliestMs: Date.now() - 1,
    latestMs: Date.now() + 1,
    acquiredMs: 1,
    referenceId: "TEST",
    referenceTimeMs: Date.now(),
    tracking: "synthetic tracking",
    versionOutput: "synthetic-version",
    ...overrides,
  };
  const seal = createHmac("sha256", syntheticConsentHost.auditKey)
    .update("bookly:consent-host-observation:v1\0")
    .update(digest(payload))
    .digest("hex");
  return { ...payload, seal };
}
