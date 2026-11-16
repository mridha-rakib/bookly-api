import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  type ApprovedHostConfiguration,
  loadApprovedFirstClassComposition,
} from "./approved-release-loader.js";
import { releaseRegistryEntrySchema } from "./authenticated-release-record.js";

/** Raw protected authority inputs, exactly as provisioned by the root-controlled deployment
 * authority. Every value is public/nonsecret; no private key is ever read by the API. */
export type FirstClassAuthorityFiles = Readonly<{
  /** Ed25519 SPKI PEM of the deployment authority (root-only private key, off-process). */
  deploymentPublicKeyPem: Buffer;
  /** Ed25519 SPKI PEM of the Owner release-approval trust anchor. */
  approvalPublicKeyPem: Buffer;
  releaseRecord: Buffer;
  releaseSignature: Buffer;
  attestation: Buffer;
  attestationSignature: Buffer;
}>;

/** Facts the API observes for itself, independently of every signed document. */
export type IndependentObservation = Readonly<{
  /** `/proc/sys/kernel/random/boot_id` of the running kernel. */
  bootId: string;
  /** Digest of the artifact tree the process is executing (see protected-authority-files). */
  artifactSha256: string;
  /** Effective uid of the API process; root could rewrite its own authority inputs. */
  processUid: number;
}>;

export const DEPLOYMENT_ATTESTATION_DOMAIN = "bookly:first-class-deployment-attestation:v1\0";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalText = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s);
const time = z.number().int().safe().positive();

const attestationSchema = z
  .object({
    version: z.literal(1),
    attestationId: canonicalText,
    /** Strictly monotonic per deployment authority; never reused with different content. */
    sequence: z.number().int().safe().positive(),
    issuedAtMs: time,
    expiresAtMs: time,
    release: z
      .object({
        gitSha: z.string().regex(/^[a-f0-9]{40}$/),
        artifactSha256: sha256,
        recordSha256: sha256,
      })
      .strict(),
    host: z
      .object({
        authorityId: canonicalText,
        hostId: canonicalText,
        configurationHash: sha256,
        bootId: z.uuid(),
      })
      .strict(),
    trustedTime: z.object({ earliestMs: time, latestMs: time, evidenceSha256: sha256 }).strict(),
    clockPolicySha256: sha256,
    trustAnchor: z
      .object({
        approvalKeySha256: sha256,
        revokedApprovalKeySha256: z.array(sha256).max(256),
      })
      .strict(),
    registry: z.object({ previousEntries: z.array(releaseRegistryEntrySchema).max(512) }).strict(),
  })
  .strict();
export type DeploymentAttestation = z.infer<typeof attestationSchema>;

const hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** SHA-256 of the SPKI DER encoding; the operator computes it with
 * `openssl pkey -pubin -in key.pub -outform DER | sha256sum`. */
export const publicKeyFingerprint = (key: KeyObject) =>
  hex(key.export({ type: "spki", format: "der" }));

/** Policy digest over sorted keys of the flat approved clock policy, so key order in the
 * signed release record cannot change it. */
export const clockPolicyFingerprint = (policy: unknown) => {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy))
    throw Error("Invalid policy");
  const entries = Object.entries(policy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hex(JSON.stringify(Object.fromEntries(entries)));
};

const ed25519 = (pem: Buffer) => {
  if (!Buffer.isBuffer(pem) || pem.length > 4096) throw Error("Invalid key");
  const key = createPublicKey(pem);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw Error("Invalid key");
  return key;
};

const canonicalJson = (payload: Buffer): unknown => {
  const raw = payload.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(payload)) throw Error("Invalid encoding");
  const parsed: unknown = JSON.parse(raw);
  if (JSON.stringify(parsed) !== raw) throw Error("Noncanonical JSON");
  return parsed;
};

export type VerifiedFirstClassAuthority = Readonly<{
  attestation: Readonly<{
    sha256: string;
    sequence: number;
    earliestMs: number;
    expiresAtMs: number;
  }>;
  recordSha256: string;
  release: ReturnType<typeof loadApprovedFirstClassComposition>["release"];
  host: ApprovedHostConfiguration;
}>;

/**
 * Verifies the authenticated handoff from the root-controlled deployment authority to the API.
 *
 * The deployment authority (a root-run process outside the application) independently
 * establishes the running Git release and artifact digest, the Linux host and boot, a trusted
 * time interval from the qualified clock, the approved clock-policy digest, the approval trust
 * anchor and its revocations, and the previous registry snapshot. It signs those facts with a
 * key the API cannot read. The API then:
 *  - re-observes boot id, artifact digest and its own uid and requires exact equality;
 *  - binds the attestation to the exact signed release record by digest (no substitution);
 *  - verifies the release record with the attested trust anchor only;
 *  - takes release SHA, host identity, trusted time and prior registry from the attestation,
 *    never from the release record itself.
 * Freshness and replay are enforced by `first-class-deployment-authority.ts`.
 * Any failure throws a sanitized error. Nothing here grants authority by itself.
 */
export function verifyFirstClassDeploymentAuthority(
  files: FirstClassAuthorityFiles,
  observed: IndependentObservation,
): VerifiedFirstClassAuthority {
  const denied = (): never => {
    throw Error("First-Class deployment authority unavailable");
  };
  try {
    if (!Number.isSafeInteger(observed.processUid) || observed.processUid <= 0) return denied();
    if (!/^[a-f0-9]{64}$/.test(observed.artifactSha256)) return denied();
    const deploymentKey = ed25519(files.deploymentPublicKeyPem);
    const approvalKey = ed25519(files.approvalPublicKeyPem);
    const deploymentFingerprint = publicKeyFingerprint(deploymentKey);
    const approvalFingerprint = publicKeyFingerprint(approvalKey);
    // Separation of duties: the key approving releases must not also attest deployments.
    if (deploymentFingerprint === approvalFingerprint) return denied();
    if (
      !Buffer.isBuffer(files.attestation) ||
      files.attestation.length > 262144 ||
      !Buffer.isBuffer(files.attestationSignature) ||
      files.attestationSignature.length !== 64
    )
      return denied();
    const signed = Buffer.concat([Buffer.from(DEPLOYMENT_ATTESTATION_DOMAIN), files.attestation]);
    if (!verify(null, signed, deploymentKey, files.attestationSignature)) return denied();
    const raw = canonicalJson(files.attestation);
    const attestation = attestationSchema.parse(raw);
    // Schema parsing trims identities; a signed document must already be in canonical form.
    if (!isDeepStrictEqual(attestation, raw)) return denied();
    const { trustedTime, trustAnchor } = attestation;
    if (
      attestation.host.bootId !== observed.bootId ||
      attestation.release.artifactSha256 !== observed.artifactSha256 ||
      attestation.release.recordSha256 !== hex(files.releaseRecord) ||
      trustAnchor.approvalKeySha256 !== approvalFingerprint ||
      trustAnchor.revokedApprovalKeySha256.includes(approvalFingerprint) ||
      trustedTime.earliestMs > trustedTime.latestMs ||
      attestation.issuedAtMs < trustedTime.earliestMs ||
      attestation.issuedAtMs > trustedTime.latestMs ||
      attestation.expiresAtMs <= attestation.issuedAtMs
    )
      return denied();
    const composition = loadApprovedFirstClassComposition({
      payload: files.releaseRecord,
      signature: files.releaseSignature,
      approvalPublicKey: approvalKey,
      verifiedRunningReleaseSha: attestation.release.gitSha,
      verifiedHostIdentity: {
        authorityId: attestation.host.authorityId,
        hostId: attestation.host.hostId,
        configurationHash: attestation.host.configurationHash,
        approvedBootId: attestation.host.bootId,
      },
      trustedNow: { earliestMs: trustedTime.earliestMs, latestMs: trustedTime.latestMs },
      previousEntries: attestation.registry.previousEntries,
    });
    const policy = composition.policy as { maxErrorMs: number };
    if (
      attestation.clockPolicySha256 !== clockPolicyFingerprint(composition.policy) ||
      // The trusted-time evidence must satisfy the approved policy's own error bound.
      trustedTime.latestMs - trustedTime.earliestMs > 2 * policy.maxErrorMs ||
      // An attestation never outlives the release approval it vouches for.
      attestation.expiresAtMs > composition.validUntilMs
    )
      return denied();
    return Object.freeze({
      attestation: Object.freeze({
        sha256: hex(files.attestation),
        sequence: attestation.sequence,
        earliestMs: trustedTime.earliestMs,
        expiresAtMs: attestation.expiresAtMs,
      }),
      recordSha256: attestation.release.recordSha256,
      release: composition.release,
      host: composition.host,
    });
  } catch {
    return denied();
  }
}
