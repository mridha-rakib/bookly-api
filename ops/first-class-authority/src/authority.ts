import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import {
  releaseRegistryEntrySchema,
  verifyAuthenticatedReleaseRecord,
} from "../../../src/modules/booking/trusted-time/authenticated-release-record.js";
import { parseApprovedConsentClockPolicy } from "../../../src/modules/booking/trusted-time/consent-clock-policy.js";
import {
  clockPolicyFingerprint,
  DEPLOYMENT_ATTESTATION_DOMAIN,
  type FirstClassAuthorityFiles,
  publicKeyFingerprint,
  verifyFirstClassDeploymentAuthority,
} from "../../../src/modules/booking/trusted-time/deployment-attestation.js";
import type { ConsentHostAuthorityEntry } from "../../../src/modules/booking/trusted-time/host-authority-registry.js";
import { consentHostPolicySchema } from "../../../src/modules/booking/trusted-time/host-policy.js";
import { FIRST_CLASS_AUTHORITY_FILE_NAMES as PUBLISHED } from "../../../src/modules/booking/trusted-time/protected-authority-files.js";
import { type ArtifactMeasurement, measureArtifact, verifySourceCheckout } from "./artifact.js";
import {
  type AttestationPolicy,
  attestationPolicySchema,
  type DeploymentConfig,
  deploymentConfigSchema,
  refuse,
  STATE_DIRECTORIES,
  STATE_FILES,
  sha256Hex,
  TOOL_CONFIG_FILES,
} from "./contract.js";
import {
  assertHostMatchesEntry,
  type ClockEvidence,
  collectClockEvidence,
  type HostIo,
  type HostMeasurement,
  measureHost,
} from "./host.js";
import {
  type AdoptedRelease,
  appendHistory,
  appendRevocation,
  ensureDirectory,
  readAdopted,
  readHighestSequence,
  readHistory,
  readRevocations,
  readStopped,
  recordSequenceAtLeast,
  removeFileDurably,
  removeStaleTemporaryFiles,
  reserveSequence,
  withLock,
  writeAdopted,
  writeFileAtomic,
  writeStopped,
} from "./state.js";

const RELEASE_DOMAIN = "bookly:first-class-release:v1\0";
const PUBLISHED_MODE = 0o644;
const PRIVATE_MODE = 0o600;

export type ToolEnv = Readonly<{
  configDirectory: string;
  stateDirectory: string;
  authorityDirectory: string;
  host: HostIo;
  /** Reads one root-provisioned tool configuration file (shipped: protected root-owned read). */
  readConfig(name: string): Buffer;
  /** Throws unless the state directory is private to root (shipped: uid 0, no group/other). */
  assertPrivateState(): void;
  /** Shipped: true. The deployed artifact and dependencies must be root-owned and read-only. */
  requireRootOwnedArtifact: boolean;
  /** Shipped: identity. Maps a configured Linux path to where it is read locally (tests). */
  localPath(path: string): string;
}>;

type Config = Readonly<{
  approvalPem: Buffer;
  approvalKey: KeyObject;
  approvalKeySha256: string;
  clockPolicy: unknown;
  attestationPolicy: AttestationPolicy;
  deployment: DeploymentConfig;
}>;

const readConfigFile = (env: ToolEnv, name: string) => {
  try {
    return env.readConfig(name);
  } catch {
    return refuse("AUTHORIZATION_MISSING", `${name} is not provisioned`);
  }
};
const readConfigJson = (env: ToolEnv, name: string): unknown => {
  const data = readConfigFile(env, name);
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return refuse("CONFIGURATION_INVALID", `${name} is not valid JSON`);
  }
};
const readClockPolicy = (env: ToolEnv): unknown => {
  const clockPolicy = readConfigJson(env, TOOL_CONFIG_FILES.clockPolicy);
  try {
    parseApprovedConsentClockPolicy(clockPolicy);
  } catch {
    refuse("CONFIGURATION_INVALID", "clock-policy.json is not a complete approved policy");
  }
  return clockPolicy;
};
const readDeployment = (env: ToolEnv): DeploymentConfig => {
  const deployment = deploymentConfigSchema.safeParse(
    readConfigJson(env, TOOL_CONFIG_FILES.deployment),
  );
  if (!deployment.success) return refuse("CONFIGURATION_INVALID", "deployment.json is invalid");
  return deployment.data as DeploymentConfig;
};

function loadConfig(env: ToolEnv): Config {
  const approvalPem = readConfigFile(env, TOOL_CONFIG_FILES.approvalPublicKey);
  let approvalKey: KeyObject;
  try {
    approvalKey = createPublicKey(approvalPem);
    if (approvalKey.asymmetricKeyType !== "ed25519") throw Error();
  } catch {
    return refuse("CONFIGURATION_INVALID", "release-approval.pub is not an Ed25519 public key");
  }
  const clockPolicy = readClockPolicy(env);
  const attestationPolicy = attestationPolicySchema.safeParse(
    readConfigJson(env, TOOL_CONFIG_FILES.attestationPolicy),
  );
  if (!attestationPolicy.success)
    return refuse("CONFIGURATION_INVALID", "attestation-policy.json is invalid");
  const deployment = readDeployment(env);
  return Object.freeze({
    approvalPem,
    approvalKey,
    approvalKeySha256: publicKeyFingerprint(approvalKey),
    clockPolicy,
    attestationPolicy: attestationPolicy.data as AttestationPolicy,
    deployment,
  });
}

type SignedRecordView = Readonly<{
  recordSha256: string;
  releaseSha: string;
  approvalReference: string;
  validUntilMs: number;
  policy: unknown;
  current: ConsentHostAuthorityEntry;
}>;

/** Signature + canonical form + the CURRENT entry, so the host can be measured against the
 * signed profile. Full verification (validity, identity, continuity) happens afterwards with
 * the API's own verifier and the tool's measurements. */
function readSignedRecord(payload: Buffer, signature: Buffer, key: KeyObject): SignedRecordView {
  try {
    if (payload.length > 131072 || signature.length !== 64) throw Error();
    if (!verify(null, Buffer.concat([Buffer.from(RELEASE_DOMAIN), payload]), key, signature))
      throw Error();
    const raw = payload.toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (JSON.stringify(parsed) !== raw || !Array.isArray(parsed["entries"])) throw Error();
    const current = parsed["entries"]
      .map((e) => releaseRegistryEntrySchema.parse(e))
      .filter((e) => e.disposition === "CURRENT");
    if (current.length !== 1 || !current[0]) throw Error();
    const releaseSha = parsed["releaseSha"];
    const validUntilMs = parsed["validUntilMs"];
    const approvalReference = parsed["approvalReference"];
    if (
      typeof releaseSha !== "string" ||
      typeof validUntilMs !== "number" ||
      typeof approvalReference !== "string"
    )
      throw Error();
    return Object.freeze({
      recordSha256: sha256Hex(payload),
      releaseSha,
      approvalReference,
      validUntilMs,
      policy: parsed["policy"],
      current: current[0] as ConsentHostAuthorityEntry,
    });
  } catch {
    return refuse("RELEASE_RECORD_INVALID", "not a canonical record signed by the trust anchor");
  }
}

const loadSigningKey = (env: ToolEnv) => {
  const path = `${env.stateDirectory}/${STATE_FILES.signingKey}`;
  if (!existsSync(path)) return refuse("SIGNING_KEY_MISSING", "run init-signing-key first");
  try {
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") throw Error();
    return { privateKey: key, publicKey: createPublicKey(key) };
  } catch {
    return refuse("SIGNING_KEY_INVALID", "deployment signing key unreadable");
  }
};

const publishedPath = (env: ToolEnv, name: string) => `${env.authorityDirectory}/${name}`;
/** Windows (tests only) has no POSIX permission bits to compare. */
const hasPublishedMode = (path: string) =>
  process.platform === "win32" || (lstatSync(path).mode & 0o7777) === PUBLISHED_MODE;
const readPublished = (env: ToolEnv, name: string) =>
  existsSync(publishedPath(env, name)) ? readFileSync(publishedPath(env, name)) : undefined;

/** Highest sequence visible in the published attestation (only ever used to go higher). */
const publishedSequence = (env: ToolEnv) => {
  try {
    const raw = readPublished(env, PUBLISHED.attestation);
    const sequence = raw
      ? (JSON.parse(raw.toString("utf8")) as { sequence?: unknown }).sequence
      : 0;
    return Number.isSafeInteger(sequence) && (sequence as number) > 0 ? (sequence as number) : 0;
  } catch {
    return 0;
  }
};

function archivePublishedAttestation(env: ToolEnv, tag: string) {
  const archive = `${env.stateDirectory}/${STATE_DIRECTORIES.archive}`;
  ensureDirectory(archive, 0o700);
  for (const name of [PUBLISHED.attestation, PUBLISHED.attestationSignature]) {
    const data = readPublished(env, name);
    if (data)
      writeFileAtomic(archive, `${tag}-${sha256Hex(data).slice(0, 16)}-${name}`, data, 0o600);
  }
}

const releaseVerification = (
  config: Config,
  payload: Buffer,
  signature: Buffer,
  view: SignedRecordView,
  host: HostMeasurement,
  clock: ClockEvidence,
  previousEntries: readonly ConsentHostAuthorityEntry[],
) => {
  try {
    return verifyAuthenticatedReleaseRecord({
      payload,
      signature,
      approvalPublicKey: config.approvalKey,
      verifiedRunningReleaseSha: view.releaseSha,
      verifiedHostIdentity: {
        authorityId: view.current.profile.authorityId,
        hostId: host.hostId,
        configurationHash: host.configurationHash,
        approvedBootId: host.bootId,
      },
      trustedNow: { earliestMs: clock.earliestMs, latestMs: clock.latestMs },
      previousEntries,
    });
  } catch {
    return refuse(
      "RELEASE_NOT_APPROVED_FOR_HOST",
      "record expired, not yet valid, discontinuous with the registry history or not for this host",
    );
  }
};

type Measured = Readonly<{
  config: Config;
  view: SignedRecordView;
  host: HostMeasurement;
  clock: ClockEvidence;
  artifact: ArtifactMeasurement;
}>;

async function measureForRecord(
  env: ToolEnv,
  config: Config,
  payload: Buffer,
  signature: Buffer,
): Promise<Measured> {
  if (
    readRevocations(env.stateDirectory).revoked.some(
      (r) => r.approvalKeySha256 === config.approvalKeySha256,
    )
  )
    refuse("APPROVAL_KEY_REVOKED", "the provisioned approval key is revoked");
  const view = readSignedRecord(payload, signature, config.approvalKey);
  if (clockPolicyFingerprint(config.clockPolicy) !== clockPolicyFingerprint(view.policy))
    refuse("CLOCK_POLICY_MISMATCH", "record policy differs from the provisioned approved policy");
  const artifact = measureArtifact(
    env.localPath(config.deployment.apiRoot),
    env.requireRootOwnedArtifact,
  );
  const host = await measureHost(env.host, view.current.profile, view.policy);
  assertHostMatchesEntry(host, view.current);
  const clock = await collectClockEvidence(env.host, view.current.profile);
  return { config, view, host, clock, artifact };
}

/** Builds, signs, self-verifies with the API verifier and atomically publishes one
 * attestation. The sequence is durably reserved before signing. */
function issueAttestation(
  env: ToolEnv,
  m: Measured,
  payload: Buffer,
  signature: Buffer,
  adopted: AdoptedRelease,
  previousEntries: readonly ConsentHostAuthorityEntry[],
  signing: ReturnType<typeof loadSigningKey>,
) {
  const { config, view, host, clock } = m;
  const deploymentPem = Buffer.from(
    signing.publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  if (publicKeyFingerprint(signing.publicKey) === config.approvalKeySha256)
    refuse("KEY_SEPARATION", "deployment and approval keys must differ");
  const expiresAtMs = Math.min(
    clock.earliestMs + config.attestationPolicy.maxValidityMs,
    view.validUntilMs,
  );
  if (expiresAtMs <= clock.wallAfterMs)
    refuse("ATTESTATION_WINDOW_EMPTY", "approved validity ends before issuance");
  const sequence = reserveSequence(env.stateDirectory, publishedSequence(env));
  const evidence = Buffer.from(
    `${JSON.stringify({
      version: 1,
      kind: "bookly-first-class-attestation-evidence",
      sequence,
      recordSha256: view.recordSha256,
      clock,
      host,
      artifact: {
        gitSha: adopted.gitSha,
        artifactSha256: adopted.artifactSha256,
        dependencySha256: adopted.dependencySha256,
      },
      attestationPolicy: config.attestationPolicy,
    })}\n`,
  );
  const evidenceSha256 = sha256Hex(evidence);
  const evidenceDirectory = `${env.stateDirectory}/${STATE_DIRECTORIES.evidence}`;
  ensureDirectory(evidenceDirectory, 0o700);
  // Retained indefinitely: no retention period is approved, so the tool never deletes evidence.
  writeFileAtomic(evidenceDirectory, `${evidenceSha256}.json`, evidence, PRIVATE_MODE);
  const attestation = Buffer.from(
    JSON.stringify({
      version: 1,
      attestationId: `${host.hostId}-${sequence}`,
      sequence,
      issuedAtMs: clock.wallAfterMs,
      expiresAtMs,
      release: {
        gitSha: adopted.gitSha,
        artifactSha256: adopted.artifactSha256,
        recordSha256: view.recordSha256,
      },
      host: {
        authorityId: view.current.profile.authorityId,
        hostId: host.hostId,
        configurationHash: host.configurationHash,
        bootId: host.bootId,
      },
      trustedTime: { earliestMs: clock.earliestMs, latestMs: clock.latestMs, evidenceSha256 },
      clockPolicySha256: clockPolicyFingerprint(view.policy),
      trustAnchor: {
        approvalKeySha256: config.approvalKeySha256,
        revokedApprovalKeySha256: readRevocations(env.stateDirectory)
          .revoked.map((r) => r.approvalKeySha256)
          .sort(),
      },
      registry: { previousEntries },
    }),
  );
  const attestationSignature = sign(
    null,
    Buffer.concat([Buffer.from(DEPLOYMENT_ATTESTATION_DOMAIN), attestation]),
    signing.privateKey,
  );
  const files: FirstClassAuthorityFiles = {
    deploymentPublicKeyPem: deploymentPem,
    approvalPublicKeyPem: config.approvalPem,
    releaseRecord: payload,
    releaseSignature: signature,
    attestation,
    attestationSignature,
  };
  // Compatibility gate: exactly what the API will verify, with the API's own verifier.
  try {
    const verified = verifyFirstClassDeploymentAuthority(files, {
      bootId: host.bootId,
      artifactSha256: adopted.artifactSha256,
      processUid: config.deployment.apiUid,
    });
    const now = env.host.wallMs();
    if (now < verified.attestation.earliestMs || now >= verified.attestation.expiresAtMs)
      throw Error();
  } catch {
    refuse("SELF_VERIFICATION_FAILED", "the API verifier rejects the attestation; not published");
  }
  if (readStopped(env.stateDirectory)) refuse("CHECKOUT_STOPPED", "stopped during renewal");
  archivePublishedAttestation(env, `superseded-${sequence}`);
  const write = (name: string, data: Buffer) => {
    const existing = readPublished(env, name);
    // Also republish unchanged bytes whose mode is wrong (e.g. 0600 left by a umask-filtered
    // earlier write), so renewal restores API readability without manual repair.
    if (!existing?.equals(data) || !hasPublishedMode(publishedPath(env, name)))
      writeFileAtomic(env.authorityDirectory, name, data, PUBLISHED_MODE);
  };
  write(PUBLISHED.deploymentPublicKeyPem, deploymentPem);
  // Signature first, statement last: an interrupted publish leaves a pair that fails
  // verification (gates closed), never a stale-but-valid mix.
  write(PUBLISHED.attestationSignature, attestationSignature);
  write(PUBLISHED.attestation, attestation);
  if (readStopped(env.stateDirectory)) {
    removeFileDurably(env.authorityDirectory, PUBLISHED.attestation);
    refuse("CHECKOUT_STOPPED", "stopped during renewal; attestation withdrawn");
  }
  return { sequence, expiresAtMs, attestationSha256: sha256Hex(attestation), evidenceSha256 };
}

const prepare = (env: ToolEnv) => {
  env.assertPrivateState();
  removeStaleTemporaryFiles(env.stateDirectory);
  removeStaleTemporaryFiles(env.authorityDirectory);
  if (readStopped(env.stateDirectory))
    refuse("CHECKOUT_STOPPED", "First-Class checkout is stopped; run resume after review");
};

/**
 * Adopts a new Owner-signed release record: verifies it with the independently provisioned
 * trust anchor, establishes the Git release from a clean root-owned checkout and the deployed
 * artifact, measures host, boot and clock, checks registry continuity against the stored
 * history, then publishes the release files and a first attestation. The API must be restarted
 * afterwards (it pins the release at startup).
 */
export function adoptRelease(
  env: ToolEnv,
  input: Readonly<{ record: Buffer; signature: Buffer; sourceCheckout: string; genesis: boolean }>,
) {
  return withLock(env.stateDirectory, async () => {
    prepare(env);
    const config = loadConfig(env);
    // Every refusal happens before anything is written or published.
    const signing = loadSigningKey(env);
    const m = await measureForRecord(env, config, input.record, input.signature);
    const history = readHistory(env.stateDirectory);
    const last = history.releases.at(-1);
    const resuming = last?.recordSha256 === m.view.recordSha256;
    if (!resuming && history.releases.some((r) => r.recordSha256 === m.view.recordSha256))
      refuse("RELEASE_REPLAYED", "this record was adopted before; a new signed record is required");
    if (!last && !input.genesis)
      refuse("GENESIS_REQUIRED", "no registry history: pass --genesis for the first release only");
    if (last && input.genesis) refuse("GENESIS_REFUSED", "registry history already exists");
    const previousEntries = resuming ? last.previousEntries : (last?.entries ?? []);
    await verifySourceCheckout(
      env.host,
      input.sourceCheckout,
      env.localPath(input.sourceCheckout),
      m.view.releaseSha,
      m.artifact,
      env.requireRootOwnedArtifact,
    );
    const verified = releaseVerification(
      config,
      input.record,
      input.signature,
      m.view,
      m.host,
      m.clock,
      previousEntries,
    );
    const adopted: AdoptedRelease = {
      version: 1,
      recordSha256: m.view.recordSha256,
      gitSha: m.view.releaseSha,
      artifactSha256: m.artifact.artifactSha256,
      dependencySha256: m.artifact.dependencySha256,
      approvalKeySha256: config.approvalKeySha256,
      adoptedAtMs: m.clock.wallAfterMs,
    };
    writeFileAtomic(env.stateDirectory, STATE_FILES.adoptedRecord, input.record, PRIVATE_MODE);
    writeFileAtomic(
      env.stateDirectory,
      STATE_FILES.adoptedSignature,
      input.signature,
      PRIVATE_MODE,
    );
    if (!resuming)
      appendHistory(env.stateDirectory, {
        recordSha256: m.view.recordSha256,
        approvalReference: m.view.approvalReference,
        releaseSha: m.view.releaseSha,
        previousEntries: [...previousEntries],
        entries: [...verified.record.entries],
        adoptedAtMs: m.clock.wallAfterMs,
      });
    writeAdopted(env.stateDirectory, adopted);
    // Close the gate before replacing startup-pinned files, then publish the new release.
    archivePublishedAttestation(env, "adoption");
    removeFileDurably(env.authorityDirectory, PUBLISHED.attestation);
    writeFileAtomic(
      env.authorityDirectory,
      PUBLISHED.approvalPublicKeyPem,
      config.approvalPem,
      PUBLISHED_MODE,
    );
    writeFileAtomic(env.authorityDirectory, PUBLISHED.releaseRecord, input.record, PUBLISHED_MODE);
    writeFileAtomic(
      env.authorityDirectory,
      PUBLISHED.releaseSignature,
      input.signature,
      PUBLISHED_MODE,
    );
    const issued = issueAttestation(
      env,
      m,
      input.record,
      input.signature,
      adopted,
      previousEntries,
      signing,
    );
    return { ...issued, recordSha256: m.view.recordSha256, restartApiRequired: true };
  });
}

/** Re-measures release, host, boot and clock and atomically publishes a higher-sequence
 * attestation for the already-adopted release. No API restart is needed. */
export function renewAttestation(env: ToolEnv) {
  return withLock(env.stateDirectory, async () => {
    prepare(env);
    const config = loadConfig(env);
    const signing = loadSigningKey(env);
    const adopted = readAdopted(env.stateDirectory);
    if (!adopted) return refuse("RELEASE_NOT_ADOPTED", "run adopt-release first");
    const payload = readFileSync(`${env.stateDirectory}/${STATE_FILES.adoptedRecord}`);
    const signature = readFileSync(`${env.stateDirectory}/${STATE_FILES.adoptedSignature}`);
    if (
      sha256Hex(payload) !== adopted.recordSha256 ||
      adopted.approvalKeySha256 !== config.approvalKeySha256
    )
      refuse("STATE_CORRUPT", "adopted record or trust anchor changed; re-adopt a signed release");
    for (const [name, expected] of [
      [PUBLISHED.releaseRecord, payload],
      [PUBLISHED.releaseSignature, signature],
      [PUBLISHED.approvalPublicKeyPem, config.approvalPem],
    ] as const)
      if (!readPublished(env, name)?.equals(expected))
        refuse("RELEASE_FILES_ALTERED", `${name} differs from the adopted release`);
    const m = await measureForRecord(env, config, payload, signature);
    if (
      m.artifact.artifactSha256 !== adopted.artifactSha256 ||
      m.artifact.dependencySha256 !== adopted.dependencySha256
    )
      refuse("ARTIFACT_CHANGED", "deployed artifact or node_modules changed since adoption");
    const entry = readHistory(env.stateDirectory).releases.find(
      (r) => r.recordSha256 === adopted.recordSha256,
    );
    if (!entry) return refuse("STATE_CORRUPT", "adopted release missing from registry history");
    releaseVerification(config, payload, signature, m.view, m.host, m.clock, entry.previousEntries);
    return issueAttestation(env, m, payload, signature, adopted, entry.previousEntries, signing);
  });
}

/** Immediate fail-closed stop. Never blocked by a lock; durable before the files go away. */
export function stopCheckout(env: ToolEnv, reason: string, nowMs: number) {
  env.assertPrivateState();
  writeStopped(env.stateDirectory, nowMs, reason || "operator stop");
  recordSequenceAtLeast(env.stateDirectory, publishedSequence(env));
  archivePublishedAttestation(env, "stopped");
  removeFileDurably(env.authorityDirectory, PUBLISHED.attestation);
  removeFileDurably(env.authorityDirectory, PUBLISHED.attestationSignature);
  return { stopped: true };
}

/** Clears the stop marker only. Checkout stays closed until the next successful renewal. */
export function resumeCheckout(env: ToolEnv) {
  env.assertPrivateState();
  removeFileDurably(env.stateDirectory, STATE_FILES.stopped);
  return { stopped: false, nextStep: "renew" };
}

/** Append-only approval-key revocation. Revoking the active anchor stops checkout at once. */
export function revokeApprovalKey(
  env: ToolEnv,
  approvalKeySha256: string,
  reference: string,
  nowMs: number,
) {
  env.assertPrivateState();
  if (!/^[a-f0-9]{64}$/.test(approvalKeySha256) || !reference.trim())
    refuse("USAGE", "revoke-approval-key <sha256 of SPKI DER> --reference <decision reference>");
  appendRevocation(env.stateDirectory, approvalKeySha256, reference.trim(), nowMs);
  const adopted = readAdopted(env.stateDirectory);
  if (adopted?.approvalKeySha256 === approvalKeySha256) {
    stopCheckout(env, "active approval key revoked", nowMs);
    return { revoked: approvalKeySha256, stopped: true };
  }
  return { revoked: approvalKeySha256, stopped: false, nextStep: "renew to publish the list" };
}

/** Generates the deployment signing key on the host, in root-only state. `rotate` retires the
 * previous key (kept for audit); the next renewal publishes the new public key. */
export function initSigningKey(env: ToolEnv, rotate: boolean) {
  env.assertPrivateState();
  const path = `${env.stateDirectory}/${STATE_FILES.signingKey}`;
  if (existsSync(path)) {
    if (!rotate) refuse("SIGNING_KEY_EXISTS", "a signing key exists; use --rotate to replace it");
    const old = loadSigningKey(env);
    const retired = `${env.stateDirectory}/${STATE_DIRECTORIES.retiredKeys}`;
    ensureDirectory(retired, 0o700);
    renameSync(path, `${retired}/${publicKeyFingerprint(old.publicKey)}.key`);
  } else if (rotate) refuse("SIGNING_KEY_MISSING", "nothing to rotate");
  const pair = generateKeyPairSync("ed25519");
  writeFileAtomic(
    env.stateDirectory,
    STATE_FILES.signingKey,
    Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string),
    PRIVATE_MODE,
  );
  return {
    deploymentKeySha256: publicKeyFingerprint(pair.publicKey),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

/** Read-only diagnostics, including the API verifier's view of the published files. */
export function readStatus(env: ToolEnv, observed?: { bootId: string; artifactSha256: string }) {
  const adopted = readAdopted(env.stateDirectory);
  const stopped = readStopped(env.stateDirectory);
  const names = Object.values(PUBLISHED);
  const present = Object.fromEntries(names.map((n) => [n, existsSync(publishedPath(env, n))]));
  let verification: Record<string, unknown> = { valid: false };
  if (names.every((n) => present[n]) && observed) {
    let config: Config | undefined;
    try {
      config = loadConfig(env);
    } catch {
      config = undefined;
    }
    try {
      const read = (key: keyof typeof PUBLISHED) => readPublished(env, PUBLISHED[key]) as Buffer;
      const v = verifyFirstClassDeploymentAuthority(
        {
          deploymentPublicKeyPem: read("deploymentPublicKeyPem"),
          approvalPublicKeyPem: read("approvalPublicKeyPem"),
          releaseRecord: read("releaseRecord"),
          releaseSignature: read("releaseSignature"),
          attestation: read("attestation"),
          attestationSignature: read("attestationSignature"),
        },
        { ...observed, processUid: config?.deployment.apiUid ?? 1 },
      );
      const now = env.host.wallMs();
      verification = {
        valid: now >= v.attestation.earliestMs && now < v.attestation.expiresAtMs,
        sequence: v.attestation.sequence,
        expiresAtMs: v.attestation.expiresAtMs,
        remainingMs: v.attestation.expiresAtMs - now,
        recordMatchesAdopted: v.recordSha256 === adopted?.recordSha256,
      };
    } catch {
      verification = { valid: false, reason: "API verifier rejects the published files" };
    }
  }
  return {
    stopped: stopped ?? false,
    adopted: adopted ?? null,
    highestSequence: readHighestSequence(env.stateDirectory),
    registryReleases: readHistory(env.stateDirectory).releases.length,
    revokedApprovalKeys: readRevocations(env.stateDirectory).revoked.map(
      (r) => r.approvalKeySha256,
    ),
    signingKeyPresent: existsSync(`${env.stateDirectory}/${STATE_FILES.signingKey}`),
    published: present,
    verification,
  };
}

const qualificationProfileSchema = consentHostPolicySchema
  .pick({ chronycPath: true, chronycSocketPath: true, referenceIds: true, maxAcquireMs: true })
  .strict();

/** Read-only qualification measurement: the values the Owner-signed record must carry for
 * this host and boot (hostId, configurationHash, chrony hashes and version output). */
export async function measureHostForQualification(env: ToolEnv, draftProfile: unknown) {
  const profile = qualificationProfileSchema.safeParse(draftProfile);
  if (!profile.success)
    return refuse(
      "USAGE",
      "profile must hold chronycPath, chronycSocketPath, referenceIds, maxAcquireMs",
    );
  return measureHost(env.host, profile.data, readClockPolicy(env));
}

/** Read-only release measurement: artifact digest v1, dependency digest and Git binding. */
export async function measureRelease(env: ToolEnv, sourceCheckout: string, gitSha: string) {
  if (!/^[a-f0-9]{40}$/.test(gitSha)) refuse("USAGE", "--release-sha must be a 40-hex commit");
  const { apiRoot } = readDeployment(env);
  const artifact = measureArtifact(env.localPath(apiRoot), env.requireRootOwnedArtifact);
  await verifySourceCheckout(
    env.host,
    sourceCheckout,
    env.localPath(sourceCheckout),
    gitSha,
    artifact,
    env.requireRootOwnedArtifact,
  );
  return { gitSha, ...artifact };
}

/** Read-only clock check against the adopted CURRENT profile; retains nothing. */
export async function checkClock(env: ToolEnv) {
  env.assertPrivateState();
  const config = loadConfig(env);
  if (!readAdopted(env.stateDirectory)) return refuse("RELEASE_NOT_ADOPTED", "nothing adopted");
  const view = readSignedRecord(
    readFileSync(`${env.stateDirectory}/${STATE_FILES.adoptedRecord}`),
    readFileSync(`${env.stateDirectory}/${STATE_FILES.adoptedSignature}`),
    config.approvalKey,
  );
  return collectClockEvidence(env.host, view.current.profile);
}
