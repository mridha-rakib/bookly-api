import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  clockPolicyFingerprint,
  DEPLOYMENT_ATTESTATION_DOMAIN,
  type FirstClassAuthorityFiles,
  type IndependentObservation,
  publicKeyFingerprint,
} from "../../src/modules/booking/trusted-time/deployment-attestation.js";
import { syntheticConsentHost } from "./consent-host-fixture.js";

/** SYNTHETIC deployment-authority handoff for isolated tests only. Keys are generated in
 * memory per test process; nothing here is a deployment recommendation or approval. */
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const pem = (key: KeyObject) => Buffer.from(key.export({ type: "spki", format: "pem" }));

export const SYNTHETIC_RELEASE_SHA = "c".repeat(40);
export const SYNTHETIC_ARTIFACT_SHA256 = "d".repeat(64);
export const SYNTHETIC_KEY_ROOT = "/var/lib/bookly/synthetic-test-keys";

export function createSyntheticFirstClassAuthority(nowMs = Date.now()) {
  const approval = generateKeyPairSync("ed25519");
  const deployment = generateKeyPairSync("ed25519");
  const { auditKey: _secret, ...base } = syntheticConsentHost;
  const profile = { ...base, referenceIds: [...base.referenceIds] };
  const entry = {
    version: 1 as const,
    qualificationReference: "synthetic-only",
    chronycSha256: "a".repeat(64),
    chronydSha256: "b".repeat(64),
    profile,
    keyReference: "synthetic",
    keyVersion: "v1",
    disposition: "CURRENT" as const,
  };
  const policy = {
    version: 1,
    approvalReference: "synthetic-policy",
    maxAcquireMs: profile.maxAcquireMs,
    maxSampleAgeMs: profile.maxSampleAgeMs,
    maxErrorMs: profile.maxErrorMs,
    maxDriftPpm: profile.maxDriftPpm,
    minRemainingMs: profile.minRemainingMs,
  };
  const validUntilMs = Date.parse("2031-01-01T00:00:00Z");
  const record = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    approvalReference: "synthetic-release",
    releaseSha: SYNTHETIC_RELEASE_SHA,
    validFromMs: nowMs - 60_000,
    validUntilMs,
    lifetimeMs: 1_800_000,
    policy,
    entries: [entry],
    keyRoot: SYNTHETIC_KEY_ROOT,
    readerGroupId: 4242,
    ...overrides,
  });
  const attestation = (recordPayload: Buffer, overrides: Record<string, unknown> = {}) => ({
    version: 1,
    attestationId: "synthetic-attestation",
    sequence: 1,
    issuedAtMs: nowMs,
    expiresAtMs: validUntilMs - 1,
    release: {
      gitSha: SYNTHETIC_RELEASE_SHA,
      artifactSha256: SYNTHETIC_ARTIFACT_SHA256,
      recordSha256: sha(recordPayload),
    },
    host: {
      authorityId: profile.authorityId,
      hostId: profile.hostId,
      configurationHash: profile.configurationHash,
      bootId: profile.approvedBootId,
    },
    trustedTime: { earliestMs: nowMs - 100, latestMs: nowMs + 100, evidenceSha256: "e".repeat(64) },
    clockPolicySha256: clockPolicyFingerprint(policy),
    trustAnchor: {
      approvalKeySha256: publicKeyFingerprint(approval.publicKey),
      revokedApprovalKeySha256: [] as string[],
    },
    registry: { previousEntries: [] as unknown[] },
    ...overrides,
  });
  const signAs = (domain: string, payload: Buffer, key: KeyObject) =>
    sign(null, Buffer.concat([Buffer.from(domain), payload]), key);

  /** Builds one complete handoff. Every part can be replaced to model tampering. */
  const files = (
    options: {
      record?: Record<string, unknown>;
      attestation?: Record<string, unknown>;
      rawAttestation?: Buffer;
      approvalSigner?: KeyObject;
      deploymentSigner?: KeyObject;
      approvalPublicKey?: KeyObject;
      deploymentPublicKey?: KeyObject;
    } = {},
  ): FirstClassAuthorityFiles => {
    const releaseRecord = Buffer.from(JSON.stringify(options.record ?? record()));
    const statement =
      options.rawAttestation ??
      Buffer.from(JSON.stringify(attestation(releaseRecord, options.attestation)));
    return {
      deploymentPublicKeyPem: pem(options.deploymentPublicKey ?? deployment.publicKey),
      approvalPublicKeyPem: pem(options.approvalPublicKey ?? approval.publicKey),
      releaseRecord,
      releaseSignature: signAs(
        "bookly:first-class-release:v1\0",
        releaseRecord,
        options.approvalSigner ?? approval.privateKey,
      ),
      attestation: statement,
      attestationSignature: signAs(
        DEPLOYMENT_ATTESTATION_DOMAIN,
        statement,
        options.deploymentSigner ?? deployment.privateKey,
      ),
    };
  };
  const observed: IndependentObservation = {
    bootId: profile.approvedBootId,
    artifactSha256: SYNTHETIC_ARTIFACT_SHA256,
    processUid: 1000,
  };
  return {
    approval,
    deployment,
    profile,
    entry,
    policy,
    nowMs,
    validUntilMs,
    record,
    attestation,
    files,
    observed,
    sha,
  };
}

/** One shared synthetic handoff per test process (startup sequence 1, renewal sequence 2). */
export const syntheticAuthority = (() => {
  const authority = createSyntheticFirstClassAuthority();
  const renewed = authority.files({ attestation: { sequence: 2, attestationId: "renewed" } });
  return {
    files: authority.files(),
    observed: authority.observed,
    expiresAtMs: authority.validUntilMs - 1,
    renewed: {
      deploymentPublicKeyPem: renewed.deploymentPublicKeyPem,
      attestation: renewed.attestation,
      attestationSignature: renewed.attestationSignature,
    },
  };
})();
