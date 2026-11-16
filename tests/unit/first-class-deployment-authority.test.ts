import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clockPolicyFingerprint,
  publicKeyFingerprint,
  verifyFirstClassDeploymentAuthority,
} from "../../src/modules/booking/trusted-time/deployment-attestation.js";
import {
  createFirstClassDeploymentAuthority,
  pinnedFirstClassHostConfiguration,
  readLiveFirstClassAuthority,
} from "../../src/modules/booking/trusted-time/first-class-deployment-authority.js";
import { createSyntheticFirstClassAuthority } from "../helpers/first-class-authority-fixture.js";

const a = createSyntheticFirstClassAuthority();
const verify = (files = a.files(), observed = a.observed) =>
  verifyFirstClassDeploymentAuthority(files, observed);
const recordSha = (record = a.record()) => a.sha(Buffer.from(JSON.stringify(record)));

describe("deployment attestation verifier", () => {
  it("accepts valid synthetic evidence and binds release, host and history", () => {
    const verified = verify();
    expect(verified.release).toEqual({
      version: 1,
      approvalReference: "synthetic-release",
      authorityId: a.profile.authorityId,
      hostId: a.profile.hostId,
      configurationHash: a.profile.configurationHash,
      approvedBootId: a.profile.approvedBootId,
      lifetimeMs: 1_800_000,
    });
    expect(verified.host.keyRoot).toBe("/var/lib/bookly/synthetic-test-keys");
    expect(verified.host.entries).toHaveLength(1);
    expect(verified.recordSha256).toBe(recordSha());
  });

  it("rejects tampered attestation, record and signatures", () => {
    const good = a.files();
    const flipped = Buffer.from(good.attestation);
    flipped.writeUInt8(flipped.readUInt8(flipped.length - 2) ^ 1, flipped.length - 2);
    expect(() => verify({ ...good, attestation: flipped })).toThrow();
    expect(() => verify({ ...good, attestationSignature: Buffer.alloc(64) })).toThrow();
    expect(() => verify({ ...good, releaseSignature: Buffer.alloc(64) })).toThrow();
    // A differently approved (validly signed) record is not the attested one.
    const other = a.files({ record: a.record({ approvalReference: "other-release" }) });
    expect(() => verify({ ...good, releaseRecord: other.releaseRecord })).toThrow();
    // Record signed by an unknown approval key.
    const rogue = generateKeyPairSync("ed25519");
    expect(() => verify(a.files({ approvalSigner: rogue.privateKey }))).toThrow();
    // Attestation signed by any key other than the deployment authority.
    expect(() => verify(a.files({ deploymentSigner: rogue.privateKey }))).toThrow();
    // Noncanonical JSON, even when validly signed.
    const spaced = Buffer.from(JSON.stringify(a.attestation(good.releaseRecord), null, 1));
    expect(() => verify(a.files({ rawAttestation: spaced }))).toThrow();
  });

  it("rejects a running artifact or release SHA mismatch", () => {
    expect(() => verify(a.files(), { ...a.observed, artifactSha256: "f".repeat(64) })).toThrow();
    expect(() =>
      verify(a.files({ attestation: { release: { ...a.attestation(Buffer.alloc(0)).release } } })),
    ).toThrow();
    const wrongGit = a.files({
      attestation: {
        release: {
          gitSha: "1".repeat(40),
          artifactSha256: "d".repeat(64),
          recordSha256: recordSha(),
        },
      },
    });
    expect(() => verify(wrongGit)).toThrow();
  });

  it("rejects host or boot mismatch and a root API process", () => {
    expect(() =>
      verify(a.files(), { ...a.observed, bootId: "bbbb2222-2222-4222-8222-222222222222" }),
    ).toThrow();
    const host = a.attestation(Buffer.alloc(0)).host;
    expect(() =>
      verify(a.files({ attestation: { host: { ...host, hostId: "other" } } })),
    ).toThrow();
    const otherBoot = { ...host, bootId: "bbbb2222-2222-4222-8222-222222222222" };
    expect(() =>
      verify(a.files({ attestation: { host: otherBoot } }), {
        ...a.observed,
        bootId: otherBoot.bootId,
      }),
    ).toThrow();
    expect(() => verify(a.files(), { ...a.observed, processUid: 0 })).toThrow();
  });

  it("rejects invalid, substituted or revoked trust anchors", () => {
    const anchor = a.attestation(Buffer.alloc(0)).trustAnchor;
    const rogue = generateKeyPairSync("ed25519");
    expect(() =>
      verify(a.files({ approvalSigner: rogue.privateKey, approvalPublicKey: rogue.publicKey })),
    ).toThrow();
    expect(() =>
      verify(
        a.files({
          attestation: {
            trustAnchor: { ...anchor, revokedApprovalKeySha256: [anchor.approvalKeySha256] },
          },
        }),
      ),
    ).toThrow();
    // The approval key may not double as the deployment authority.
    expect(() =>
      verify(
        a.files({
          deploymentSigner: a.approval.privateKey,
          deploymentPublicKey: a.approval.publicKey,
        }),
      ),
    ).toThrow();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() =>
      verify({
        ...a.files(),
        approvalPublicKeyPem: Buffer.from(ec.export({ type: "spki", format: "pem" })),
      }),
    ).toThrow();
    expect(publicKeyFingerprint(a.approval.publicKey)).toBe(anchor.approvalKeySha256);
  });

  it("rejects historical registry rollback and removal; retains a verify-only generation", () => {
    const revoked = { ...a.entry, disposition: "REVOKED" };
    expect(() =>
      verify(a.files({ attestation: { registry: { previousEntries: [revoked] } } })),
    ).toThrow();
    const older = {
      ...a.entry,
      profile: { ...a.entry.profile, authorityId: "older-generation" },
      keyVersion: "v0",
      disposition: "VERIFY_ONLY",
    };
    expect(() =>
      verify(a.files({ attestation: { registry: { previousEntries: [older] } } })),
    ).toThrow();
    const record = a.record({ entries: [older, a.entry] });
    const retained = a.files({
      record,
      attestation: {
        release: {
          gitSha: "c".repeat(40),
          artifactSha256: "d".repeat(64),
          recordSha256: recordSha(record),
        },
        registry: { previousEntries: [older] },
      },
    });
    expect(verify(retained).host.entries).toHaveLength(2);
  });

  it("rejects clock-policy and trusted-time mismatches", () => {
    expect(() =>
      verify(
        a.files({
          attestation: {
            clockPolicySha256: clockPolicyFingerprint({ ...a.policy, maxErrorMs: 999 }),
          },
        }),
      ),
    ).toThrow();
    // Key order does not change the policy digest.
    const reversed = Object.fromEntries(Object.entries(a.policy).reverse());
    expect(clockPolicyFingerprint(reversed)).toBe(clockPolicyFingerprint(a.policy));
    const t = a.nowMs;
    for (const trustedTime of [
      { earliestMs: t - 1001, latestMs: t + 1000, evidenceSha256: "e".repeat(64) },
      { earliestMs: t + 1, latestMs: t + 100, evidenceSha256: "e".repeat(64) },
      { earliestMs: t - 120_000, latestMs: t - 119_900, evidenceSha256: "e".repeat(64) },
    ])
      expect(() => verify(a.files({ attestation: { trustedTime } }))).toThrow();
    expect(() => verify(a.files({ attestation: { expiresAtMs: a.validUntilMs + 1 } }))).toThrow();
    expect(() => verify(a.files({ attestation: { expiresAtMs: t } }))).toThrow();
  });
});

describe("process-local deployment authority", () => {
  const io = (state: {
    files: ReturnType<typeof a.files>;
    now: number;
    missing?: boolean;
    observed?: typeof a.observed;
  }) => ({
    readFiles: () => {
      if (state.missing) throw new Error("missing");
      return state.files;
    },
    readLiveFiles: () => {
      if (state.missing) throw new Error("missing");
      const { deploymentPublicKeyPem, attestation, attestationSignature } = state.files;
      return { deploymentPublicKeyPem, attestation, attestationSignature };
    },
    observe: () => state.observed ?? a.observed,
    now: () => state.now,
  });

  it("the shipped instance on a host without provisioned authority denies", () => {
    expect(pinnedFirstClassHostConfiguration).toBeUndefined();
    expect(readLiveFirstClassAuthority()).toBeUndefined();
  });

  it("pins valid startup evidence and denies after expiry", () => {
    const state = { files: a.files(), now: a.nowMs };
    const authority = createFirstClassDeploymentAuthority(io(state));
    expect(authority.hostConfiguration?.keyRoot).toBe("/var/lib/bookly/synthetic-test-keys");
    expect(authority.readLive()?.release.authorityId).toBe(a.profile.authorityId);
    state.now = a.validUntilMs - 1;
    expect(authority.readLive()).toBeUndefined();
    state.now = a.nowMs - 101;
    expect(authority.readLive()).toBeUndefined();
  });

  it("fails closed on missing, stale or invalid startup evidence (restart semantics)", () => {
    expect(
      createFirstClassDeploymentAuthority(io({ files: a.files(), now: a.nowMs, missing: true }))
        .hostConfiguration,
    ).toBeUndefined();
    const stale = createFirstClassDeploymentAuthority(
      io({ files: a.files(), now: a.validUntilMs }),
    );
    expect(stale.hostConfiguration).toBeUndefined();
    expect(stale.readLive()).toBeUndefined();
    const wrongBoot = createFirstClassDeploymentAuthority(
      io({
        files: a.files(),
        now: a.nowMs,
        observed: { ...a.observed, bootId: "bbbb2222-2222-4222-8222-222222222222" },
      }),
    );
    expect(wrongBoot.readLive()).toBeUndefined();
  });

  it("denies a missing or tampered live attestation and recovers on a valid one", () => {
    const state = { files: a.files(), now: a.nowMs, missing: false };
    const authority = createFirstClassDeploymentAuthority(io(state));
    state.missing = true;
    expect(authority.readLive()).toBeUndefined();
    state.missing = false;
    const good = state.files;
    state.files = { ...good, attestationSignature: Buffer.alloc(64) };
    expect(authority.readLive()).toBeUndefined();
    state.files = good;
    expect(authority.readLive()).toBeDefined();
  });

  it("accepts renewal, refuses replay, equivocation and release substitution", () => {
    const state = { files: a.files({ attestation: { sequence: 5 } }), now: a.nowMs };
    const authority = createFirstClassDeploymentAuthority(io(state));
    const startup = state.files;
    state.files = a.files({ attestation: { sequence: 6, attestationId: "renewed" } });
    expect(authority.readLive()?.attestation.sequence).toBe(6);
    state.files = startup;
    expect(authority.readLive()).toBeUndefined();
    state.files = a.files({ attestation: { sequence: 6, attestationId: "equivocating" } });
    expect(authority.readLive()).toBeUndefined();
    const record = a.record({ approvalReference: "substituted-release" });
    state.files = a.files({
      record,
      attestation: {
        sequence: 7,
        release: {
          gitSha: "c".repeat(40),
          artifactSha256: "d".repeat(64),
          recordSha256: recordSha(record),
        },
      },
    });
    expect(authority.readLive()).toBeUndefined();
    // A replaced deployment authority key is only accepted with its own valid signature.
    const rotated = generateKeyPairSync("ed25519");
    state.files = a.files({
      attestation: { sequence: 8, attestationId: "rotated" },
      deploymentSigner: rotated.privateKey,
      deploymentPublicKey: rotated.publicKey,
    });
    expect(authority.readLive()?.attestation.sequence).toBe(8);
  });
});

it("rejects signed documents whose identities only parse after trimming", () => {
  const host = a.attestation(Buffer.alloc(0)).host;
  expect(() =>
    verify(a.files({ attestation: { host: { ...host, hostId: ` ${host.hostId}` } } })),
  ).toThrow();
  const padded = { ...a.entry, profile: { ...a.entry.profile, hostId: `${a.profile.hostId} ` } };
  const record = a.record({ entries: [padded] });
  expect(() =>
    verify(
      a.files({
        record,
        attestation: {
          release: {
            gitSha: "c".repeat(40),
            artifactSha256: "d".repeat(64),
            recordSha256: recordSha(record),
          },
        },
      }),
    ),
  ).toThrow();
});
