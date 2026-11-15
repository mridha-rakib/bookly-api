/**
 * Phase 4.1 — approved clock-policy input and qualified-host composition (P4I §3 step 3).
 * Every policy, profile and key here is SYNTHETIC and isolated to this file. Nothing below is a
 * recommended limit or a qualification. `qualified-host.js` is mocked only so that real callers
 * (checkout readiness, observation verification) can be exercised through a composition.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/common/errors/app-error.js";
import { readPackageCheckoutReadiness } from "../../src/modules/booking/package-checkout-availability.js";
import {
  type ApprovedConsentClockPolicy,
  assertProfileMatchesClockPolicy,
  CONSENT_CLOCK_LIMITS,
  parseApprovedConsentClockPolicy,
} from "../../src/modules/booking/trusted-time/consent-clock-policy.js";
import type { ConsentHostAuthorityEntry } from "../../src/modules/booking/trusted-time/host-authority-registry.js";
import { verifyConsentHostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import {
  composeQualifiedConsentHost,
  type QualifiedConsentHostComposition,
} from "../../src/modules/booking/trusted-time/qualified-host-composition.js";
import { syntheticConsentHost, syntheticHostObservation } from "../helpers/consent-host-fixture.js";

const holder = vi.hoisted(() => ({
  composition: undefined as undefined | QualifiedConsentHostComposition,
}));
vi.mock("../../src/modules/booking/trusted-time/qualified-host.js", async (original) => {
  const shipped =
    await original<typeof import("../../src/modules/booking/trusted-time/qualified-host.js")>();
  return {
    requireQualifiedConsentHost: () =>
      holder.composition
        ? holder.composition.requireQualifiedConsentHost()
        : shipped.requireQualifiedConsentHost(),
    requireConsentHostVerificationProfile: (
      identity: Parameters<typeof shipped.requireConsentHostVerificationProfile>[0],
    ) =>
      holder.composition
        ? holder.composition.requireConsentHostVerificationProfile(identity)
        : shipped.requireConsentHostVerificationProfile(identity),
  };
});
afterEach(() => {
  holder.composition = undefined;
  vi.restoreAllMocks();
});

const { auditKey: _key, ...syntheticProfile } = syntheticConsentHost;
const policy = (): ApprovedConsentClockPolicy => ({
  version: 1,
  approvalReference: "test-only-synthetic-policy",
  maxAcquireMs: syntheticConsentHost.maxAcquireMs,
  maxSampleAgeMs: syntheticConsentHost.maxSampleAgeMs,
  maxErrorMs: syntheticConsentHost.maxErrorMs,
  maxDriftPpm: syntheticConsentHost.maxDriftPpm,
  minRemainingMs: syntheticConsentHost.minRemainingMs,
});
const entry = (
  disposition: ConsentHostAuthorityEntry["disposition"] = "CURRENT",
  patch: Partial<ConsentHostAuthorityEntry["profile"]> = {},
): ConsentHostAuthorityEntry => ({
  version: 1,
  qualificationReference: "test-only-review",
  chronycSha256: "a".repeat(64),
  chronydSha256: "b".repeat(64),
  profile: { ...syntheticProfile, referenceIds: [...syntheticProfile.referenceIds], ...patch },
  disposition,
  keyReference: "test-protected-key",
  keyVersion: "test-v1",
});
const identity = () => ({
  authorityId: syntheticConsentHost.authorityId,
  hostId: syntheticConsentHost.hostId,
  configurationHash: syntheticConsentHost.configurationHash,
  approvedBootId: syntheticConsentHost.approvedBootId,
});
const resolver = () =>
  vi.fn((_reference: string, _version: string, _purpose: "SIGN" | "VERIFY") =>
    Buffer.from(syntheticConsentHost.auditKey),
  );

/** Exactly the shape the shipped deny-only seams throw. */
const unqualified = expect.objectContaining({
  statusCode: 503,
  message: "Consent host qualification and numerical policy are pending",
  details: [expect.objectContaining({ code: "PACKAGE_CONSENT_HOST_UNQUALIFIED" })],
});
const verificationUnavailable = expect.objectContaining({
  statusCode: 503,
  message: "Consent host verification authority is unavailable",
  details: [expect.objectContaining({ code: "PACKAGE_CONSENT_HOST_VERIFICATION_UNAVAILABLE" })],
});
const expectDenied = (composition: QualifiedConsentHostComposition) => {
  expect(() => composition.requireQualifiedConsentHost()).toThrow(unqualified);
  expect(() => composition.requireConsentHostVerificationProfile(identity())).toThrow(
    verificationUnavailable,
  );
};

describe("approved consent clock policy is a required explicit input", () => {
  it("accepts only a complete, canonical record and returns a frozen copy", () => {
    const input = policy();
    const parsed = parseApprovedConsentClockPolicy(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect([...CONSENT_CLOCK_LIMITS].sort()).toEqual(
      ["maxAcquireMs", "maxDriftPpm", "maxErrorMs", "maxSampleAgeMs", "minRemainingMs"].sort(),
    );
  });

  it("has no defaults: absent, partial, extra, padded or out-of-range input is refused", () => {
    const bad: unknown[] = [undefined, null, {}, "policy", { ...policy(), version: 2 }];
    for (const limit of CONSENT_CLOCK_LIMITS) {
      const { [limit]: _omitted, ...partial } = policy();
      bad.push(partial, { ...policy(), [limit]: Number.NaN }, { ...policy(), [limit]: "1" });
    }
    bad.push(
      { ...policy(), approvalReference: "" },
      { ...policy(), approvalReference: " padded" },
      { ...policy(), extra: true },
      { ...policy(), maxAcquireMs: 0 },
      { ...policy(), maxAcquireMs: 1.5 },
      { ...policy(), maxDriftPpm: -1 },
      { ...policy(), maxDriftPpm: Number.POSITIVE_INFINITY },
      // The immutable 30-minute lifetime caps the usable-window margin.
      { ...policy(), minRemainingMs: 1_800_001 },
    );
    for (const input of bad)
      expect(() => parseApprovedConsentClockPolicy(input), JSON.stringify(input)).toThrow(
        /^Consent clock policy unavailable$/,
      );
  });

  it("an issuing profile must equal every approved limit, in both directions", () => {
    const approved = parseApprovedConsentClockPolicy(policy());
    expect(() => assertProfileMatchesClockPolicy(syntheticConsentHost, approved)).not.toThrow();
    for (const limit of CONSENT_CLOCK_LIMITS)
      for (const delta of [-0.5, 1]) {
        const profile = { ...syntheticConsentHost, [limit]: syntheticConsentHost[limit] + delta };
        expect(() => assertProfileMatchesClockPolicy(profile, approved), limit).toThrow();
      }
  });
});

describe("qualified-host composition fails closed with the shipped errors", () => {
  it("missing or invalid policy, entries or resolver deny both seams without resolving keys", () => {
    const resolve = resolver();
    for (const input of [
      { policy: undefined, entries: [entry()], resolveProtectedKey: resolve },
      { policy: null, entries: [entry()], resolveProtectedKey: resolve },
      {
        policy: { ...policy(), maxErrorMs: undefined },
        entries: [entry()],
        resolveProtectedKey: resolve,
      },
      { policy: policy(), entries: undefined, resolveProtectedKey: resolve },
      { policy: policy(), entries: [entry(), entry()], resolveProtectedKey: resolve },
      { policy: policy(), entries: [entry()], resolveProtectedKey: undefined },
      undefined,
    ])
      expectDenied(composeQualifiedConsentHost(input as never));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a CURRENT profile that differs from the approved policy cannot compose at all", () => {
    const resolve = resolver();
    for (const limit of CONSENT_CLOCK_LIMITS)
      expectDenied(
        composeQualifiedConsentHost({
          policy: policy(),
          entries: [entry("CURRENT", { [limit]: syntheticConsentHost[limit] + 1 })],
          resolveProtectedKey: resolve,
        }),
      );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("no CURRENT issuer: issuance denied, approved history still verifies under its own limits", () => {
    const history = entry("VERIFY_ONLY", { maxErrorMs: syntheticConsentHost.maxErrorMs + 500 });
    const composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [history],
      resolveProtectedKey: resolver(),
    });
    expect(() => composition.requireQualifiedConsentHost()).toThrow(unqualified);
    expect(composition.requireConsentHostVerificationProfile(identity()).maxErrorMs).toBe(
      syntheticConsentHost.maxErrorMs + 500,
    );
  });

  it("revoked, unknown or substituted identities and resolver outages map to sanitized AppErrors", () => {
    const revoked = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry("REVOKED")],
      resolveProtectedKey: resolver(),
    });
    expectDenied(revoked);
    const outage = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry()],
      resolveProtectedKey: () => {
        throw Error("DO-NOT-EXPOSE test-protected-key");
      },
    });
    for (const call of [
      () => outage.requireQualifiedConsentHost(),
      () => outage.requireConsentHostVerificationProfile(identity()),
      () => outage.requireConsentHostVerificationProfile(null as never),
    ]) {
      let thrown: unknown;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect(JSON.stringify(thrown) + String(thrown)).not.toMatch(/DO-NOT-EXPOSE|test-protected/);
    }
    const shortKey = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry()],
      resolveProtectedKey: () => Buffer.alloc(8),
    });
    expectDenied(shortKey);
  });

  it("an approved composition issues and verifies, re-resolving the key on every use", () => {
    const resolve = resolver();
    const composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry()],
      resolveProtectedKey: resolve,
    });
    expect(composition.requireQualifiedConsentHost().authorityId).toBe(
      syntheticConsentHost.authorityId,
    );
    expect(composition.requireConsentHostVerificationProfile(identity()).hostId).toBe(
      syntheticConsentHost.hostId,
    );
    composition.requireQualifiedConsentHost();
    expect(resolve.mock.calls.map((call) => call[2])).toEqual(["SIGN", "VERIFY", "SIGN"]);
    expect(Object.isFrozen(composition)).toBe(true);
  });
});

describe("existing callers through a composition (isolated, synthetic)", () => {
  it("checkout readiness reports CONSENT_HOST_UNQUALIFIED instead of throwing on resolver outage", async () => {
    holder.composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry()],
      resolveProtectedKey: () => {
        throw Error("resolver outage");
      },
    });
    await expect(readPackageCheckoutReadiness({ enabled: true })).resolves.toEqual({
      available: false,
      reason: "CONSENT_HOST_UNQUALIFIED",
    });
  });

  it("a qualified composition still leaves checkout closed at the shipped batch authority", async () => {
    holder.composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry()],
      resolveProtectedKey: resolver(),
    });
    await expect(readPackageCheckoutReadiness({ enabled: true })).resolves.toEqual({
      available: false,
      reason: "BATCH_AUTHORITY_UNAVAILABLE",
    });
    await expect(readPackageCheckoutReadiness()).resolves.toEqual({
      available: false,
      reason: "CONSENT_HTTP_DISABLED",
    });
  });

  it("sealed evidence verifies through composed history and fails after revocation", () => {
    const witness = "c".repeat(64);
    const sample = syntheticHostObservation(witness);
    holder.composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry("VERIFY_ONLY")],
      resolveProtectedKey: resolver(),
    });
    expect(verifyConsentHostObservation(sample, witness)).toEqual(sample);
    expect(() =>
      verifyConsentHostObservation({ ...sample, latestMs: sample.latestMs + 1 }, witness),
    ).toThrow();
    holder.composition = composeQualifiedConsentHost({
      policy: policy(),
      entries: [entry("REVOKED")],
      resolveProtectedKey: resolver(),
    });
    expect(() => verifyConsentHostObservation(sample, witness)).toThrow(verificationUnavailable);
  });
});
