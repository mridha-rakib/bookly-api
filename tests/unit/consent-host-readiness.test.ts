import { expect, it } from "vitest";
import {
  parseConsentHostReadiness,
  validateConsentHostBoot,
  validateConsentHostPolicy,
} from "../../src/modules/booking/trusted-time/host-policy.js";
import { requireQualifiedConsentHost } from "../../src/modules/booking/trusted-time/qualified-host.js";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

const candidate = () => {
  const { auditKey: _key, ...profile } = syntheticConsentHost;
  return {
    version: 1,
    state: "REVIEW_REQUIRED",
    profile,
    target: {
      platform: "linux",
      hostId: profile.hostId,
      bootId: "aaaa1111-1111-4111-8111-111111111111",
      chronycSha256: "a".repeat(64),
      chronydSha256: "b".repeat(64),
      evidenceReference: "synthetic-evidence",
    },
    key: {
      reference: "test-only-reference",
      version: "test-version",
      custodyEvidenceReference: "test-custody",
      historicalVerificationReference: "test-history",
    },
    reviewReference: "test-review",
  };
};

it("valid review records and keys never authorize a production host", () => {
  validateConsentHostPolicy(syntheticConsentHost);
  expect(parseConsentHostReadiness(candidate()).state).toBe("REVIEW_REQUIRED");
  expect(() => requireQualifiedConsentHost()).toThrow("qualification");
  expect(() => parseConsentHostReadiness({ ...candidate(), state: "QUALIFIED" })).toThrow();
});

it("rejects missing policy, unsafe limits, source fallback and invalid identities", () => {
  for (const patch of [
    { hostId: "" },
    { configurationHash: "not-a-hash" },
    { chronycSocketPath: "/run/chrony.sock,127.0.0.1" },
    { chronycPath: "/a/../chronyc" },
    { referenceIds: ["TEST", "TEST"] },
    { referenceIds: ["7F7F0101"] },
    { maxAcquireMs: 2_147_483_648 },
    { maxErrorMs: Number.MAX_SAFE_INTEGER },
    { maxSampleAgeMs: 0 },
    { maxDriftPpm: Infinity },
    { minRemainingMs: 1_800_001 },
    { auditKey: Buffer.alloc(31) },
  ]) {
    expect(() => validateConsentHostPolicy({ ...syntheticConsentHost, ...patch })).toThrow(
      "Invalid qualified host policy",
    );
  }
});

it("rejects controls, commas and JavaScript whitespace in both host paths", () => {
  // Includes NUL, tab, LF, CR, US and DEL, plus every JavaScript whitespace code point.
  const codes = [
    ...Array.from({ length: 32 }, (_, code) => code),
    0x7f,
    0x2c,
    0x20,
    0xa0,
    0x1680,
    ...Array.from({ length: 11 }, (_, offset) => 0x2000 + offset),
    0x2028,
    0x2029,
    0x202f,
    0x205f,
    0x3000,
    0xfeff,
  ];
  for (const field of ["chronycPath", "chronycSocketPath"] as const) {
    for (const code of codes) {
      const path = `/run/chrony${String.fromCharCode(code)}socket`;
      expect(() => validateConsentHostPolicy({ ...syntheticConsentHost, [field]: path })).toThrow(
        "Invalid qualified host policy",
      );
    }
  }
});

it("retains absolute-path and normalization restrictions for both host paths", () => {
  for (const field of ["chronycPath", "chronycSocketPath"] as const) {
    for (const path of [
      "usr/bin/chronyc",
      "./chronyc",
      "../chronyc",
      "/",
      "/a/../chronyc",
      "/a/./chronyc",
      "/a//chronyc",
    ]) {
      expect(() => validateConsentHostPolicy({ ...syntheticConsentHost, [field]: path })).toThrow(
        "Invalid qualified host policy",
      );
    }
    for (const path of [
      "/usr/bin/chronyc",
      "/run/chrony/chronyd.sock",
      "/run/chrony-._socket",
      "/run/chrony\u0080socket",
    ]) {
      expect(() =>
        validateConsentHostPolicy({ ...syntheticConsentHost, [field]: path }),
      ).not.toThrow();
    }
  }
});

it("requires exact boot, key custody and historical-verification metadata without accepting secrets", () => {
  const input = candidate();
  for (const changed of [
    { ...input, target: { ...input.target, bootId: "unknown" } },
    { ...input, target: { ...input.target, hostId: "another-host" } },
    { ...input, key: { ...input.key, historicalVerificationReference: "" } },
    { ...input, key: { ...input.key, secret: "DO-NOT-ECHO" } },
    { ...input, profile: { ...input.profile, auditKey: "DO-NOT-ECHO" } },
  ]) {
    expect(() => parseConsentHostReadiness(changed)).toThrow(
      /^Invalid consent host readiness record$/,
    );
  }
});

it("preserves revoked and unqualified review state without granting authority", () => {
  for (const state of ["UNQUALIFIED", "REVOKED"]) {
    expect(parseConsentHostReadiness({ ...candidate(), state }).state).toBe(state);
    expect(() => requireQualifiedConsentHost()).toThrow();
  }
});

it("refuses both a stable unapproved boot and a reboot during acquisition", () => {
  const approved = syntheticConsentHost.approvedBootId;
  const other = "bbbb1111-1111-4111-8111-111111111111";
  validateConsentHostBoot(syntheticConsentHost, approved, approved);
  expect(() => validateConsentHostBoot(syntheticConsentHost, other, other)).toThrow(
    "not qualified",
  );
  expect(() => validateConsentHostBoot(syntheticConsentHost, approved, other)).toThrow(
    "not qualified",
  );
});
