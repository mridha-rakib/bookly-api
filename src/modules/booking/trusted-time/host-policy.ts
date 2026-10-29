import { posix } from "node:path";
import { z } from "zod";
import type { QualifiedConsentHost } from "./qualified-host.js";

const identity = z.string().trim().min(1).max(256);
const absolutePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") &&
      value !== "/" &&
      posix.normalize(value) === value &&
      !/[\s,]/.test(value) &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }),
  );
const positive = z.number().int().safe().positive();

/** Structural validation only. Neither a parsed profile nor a key grants qualification. */
export const consentHostPolicySchema = z
  .object({
    approvedBootId: z.uuid(),
    authorityId: identity,
    hostId: identity,
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    chronycPath: absolutePath,
    chronycSocketPath: absolutePath,
    chronycVersionOutput: z.string().trim().min(1).max(1024),
    referenceIds: z
      .array(identity)
      .min(1)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length && !ids.includes("7F7F0101")),
    maxAcquireMs: positive.max(2_147_483_647),
    maxSampleAgeMs: positive,
    maxErrorMs: positive.max(Math.floor(Number.MAX_SAFE_INTEGER / 2)),
    maxDriftPpm: z.number().finite().nonnegative(),
    minRemainingMs: positive.max(1_800_000),
  })
  .strict();

/** Sanitized failure: never include raw profile, paths, key bytes or parser input. */
export function validateConsentHostPolicy(profile: QualifiedConsentHost): void {
  const { auditKey, ...configuration } = profile;
  if (
    !consentHostPolicySchema.safeParse(configuration).success ||
    !Buffer.isBuffer(auditKey) ||
    auditKey.length < 32
  ) {
    throw Error("Invalid qualified host policy");
  }
}

/** Candidate inventory for OFFLINE review, deliberately not a production grant format.
 * Secret values are forbidden; key references require a separately reviewed resolver.
 * Configuration hashes/evidence references must be independently checked by the reviewer.
 */
export const consentHostReadinessSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["UNQUALIFIED", "REVIEW_REQUIRED", "REVOKED"]),
    profile: consentHostPolicySchema,
    target: z
      .object({
        platform: z.literal("linux"),
        hostId: identity,
        bootId: z.uuid(),
        chronycSha256: z.string().regex(/^[a-f0-9]{64}$/),
        chronydSha256: z.string().regex(/^[a-f0-9]{64}$/),
        evidenceReference: identity,
      })
      .strict(),
    key: z
      .object({
        reference: identity,
        version: identity,
        custodyEvidenceReference: identity,
        historicalVerificationReference: identity,
      })
      .strict(),
    reviewReference: identity,
  })
  .strict()
  .refine(
    (value) =>
      value.target.hostId === value.profile.hostId &&
      value.target.bootId === value.profile.approvedBootId,
  );

export function validateConsentHostBoot(
  profile: QualifiedConsentHost,
  before: string,
  after: string,
): void {
  if (before !== profile.approvedBootId || after !== profile.approvedBootId) {
    throw Error("Consent host boot is not qualified");
  }
}

export function parseConsentHostReadiness(input: unknown) {
  const result = consentHostReadinessSchema.safeParse(input);
  if (!result.success) throw Error("Invalid consent host readiness record");
  return result.data;
}
