import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

/**
 * Bookly First-Class deployment authority tool — fixed contract (v1).
 *
 * Everything here is source-controlled and reviewable. There is deliberately no environment
 * variable, CLI flag or configuration override for any path or trust decision.
 */

/** Root-only tool configuration provisioned out of band (Owner approvals, operator settings). */
export const TOOL_CONFIG_DIRECTORY = "/etc/bookly-first-class-authority-tool";
/** Root-only durable state: signing key, sequence, registry history, revocations, evidence. */
export const TOOL_STATE_DIRECTORY = "/var/lib/bookly-first-class-authority";

export const TOOL_CONFIG_FILES = {
  /** Owner Ed25519 release-approval public key (independently provisioned trust anchor). */
  approvalPublicKey: "release-approval.pub",
  /** Owner-approved five-limit clock policy; must equal the signed release record's policy. */
  clockPolicy: "clock-policy.json",
  /** Owner-approved attestation validity bound. No default exists. */
  attestationPolicy: "attestation-policy.json",
  /** Operator deployment settings: deployed API root and the API service uid. */
  deployment: "deployment.json",
} as const;

export const STATE_FILES = {
  signingKey: "deployment-signing.key",
  sequence: "sequence.json",
  history: "registry-history.json",
  revocations: "revoked-approval-keys.json",
  adopted: "adopted-release.json",
  adoptedRecord: "adopted-release-record.json",
  adoptedSignature: "adopted-release-record.sig",
  stopped: "stopped.json",
  lock: "operation.lock",
} as const;
export const STATE_DIRECTORIES = {
  evidence: "evidence",
  archive: "archive",
  retiredKeys: "retired-keys",
} as const;

/** Linux measurement inputs (v1). Debian/Ubuntu chrony layout. */
export const LINUX_PATHS = {
  bootId: "/proc/sys/kernel/random/boot_id",
  machineId: "/etc/machine-id",
  kernelRelease: "/proc/sys/kernel/osrelease",
  chronyd: "/usr/sbin/chronyd",
  chronyConfiguration: "/etc/chrony/chrony.conf",
  chronyConfigurationDirectories: ["/etc/chrony/conf.d", "/etc/chrony/sources.d"],
  systemctl: "/usr/bin/systemctl",
  git: "/usr/bin/git",
} as const;

const text = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s);
const absolutePath = z
  .string()
  .max(4096)
  .regex(/^\/[A-Za-z0-9._/-]+$/)
  .refine((p) => p !== "/" && posix.normalize(p) === p);

/** Owner-approved bound on one attestation's lifetime. Renewal must happen before expiry. */
export const attestationPolicySchema = z
  .object({
    version: z.literal(1),
    approvalReference: text,
    maxValidityMs: z.number().int().safe().positive(),
  })
  .strict();
export type AttestationPolicy = z.infer<typeof attestationPolicySchema>;

/** Operator settings. Neither value grants authority; both are re-measured. */
export const deploymentConfigSchema = z
  .object({
    version: z.literal(1),
    /** Deployed API root containing dist/, package.json, pnpm-lock.yaml, node_modules/. */
    apiRoot: absolutePath,
    /** Effective uid of the API service (non-root); used for the self-verification. */
    apiUid: z.number().int().safe().positive(),
  })
  .strict();
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/**
 * `configurationHash` v1: the SHA-256 of this exact compact JSON object, fields in this order:
 *
 *   {"contract":"bookly:first-class-host-configuration:v1",
 *    "machineId":<32 hex, /etc/machine-id>,
 *    "kernelRelease":<trimmed /proc/sys/kernel/osrelease>,
 *    "chronyc":{"path","sha256","socketPath","versionOutput"},
 *    "chronyd":{"path":"/usr/sbin/chronyd","sha256"},
 *    "chronyConfiguration":[{"path","sha256"}, ...] sorted by path (byte order): chrony.conf
 *        plus every regular file in /etc/chrony/conf.d and /etc/chrony/sources.d,
 *    "referenceIds":[...approved order],
 *    "clockPolicySha256":<clockPolicyFingerprint of the approved policy>}
 *
 * `hostId` v1 is the 32-hex machine id. Both are measured by the tool on the host; the signed
 * release record must carry the measured values.
 */
export const HOST_CONFIGURATION_CONTRACT = "bookly:first-class-host-configuration:v1";

export type HostConfigurationV1 = Readonly<{
  contract: typeof HOST_CONFIGURATION_CONTRACT;
  machineId: string;
  kernelRelease: string;
  chronyc: Readonly<{ path: string; sha256: string; socketPath: string; versionOutput: string }>;
  chronyd: Readonly<{ path: string; sha256: string }>;
  chronyConfiguration: readonly Readonly<{ path: string; sha256: string }>[];
  referenceIds: readonly string[];
  clockPolicySha256: string;
}>;

/** Rebuilds the object in the contract's field order, so caller key order cannot matter. */
export function hostConfigurationHash(c: HostConfigurationV1): string {
  const canonical = {
    contract: c.contract,
    machineId: c.machineId,
    kernelRelease: c.kernelRelease,
    chronyc: {
      path: c.chronyc.path,
      sha256: c.chronyc.sha256,
      socketPath: c.chronyc.socketPath,
      versionOutput: c.chronyc.versionOutput,
    },
    chronyd: { path: c.chronyd.path, sha256: c.chronyd.sha256 },
    chronyConfiguration: [...c.chronyConfiguration]
      .map((f) => ({ path: f.path, sha256: f.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    referenceIds: [...c.referenceIds],
    clockPolicySha256: c.clockPolicySha256,
  };
  return sha256Hex(JSON.stringify(canonical));
}

/** Refusals carry a stable code for operators; they never include key bytes. */
export class AuthorityToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
export const refuse = (code: string, message: string): never => {
  throw new AuthorityToolError(code, message);
};
