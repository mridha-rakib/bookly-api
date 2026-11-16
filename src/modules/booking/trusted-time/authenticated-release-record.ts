import { type KeyObject, verify } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { PACKAGE_CONSENT_STRICT_LIFETIME_MS } from "../package-consent-commit-deadline.js";
import {
  assertProfileMatchesClockPolicy,
  parseApprovedConsentClockPolicy,
} from "./consent-clock-policy.js";
import { assertConsentHostHistoryContinuity } from "./host-authority-history.js";
import type { ConsentHostAuthorityEntry } from "./host-authority-registry.js";
import { consentHostPolicySchema } from "./host-policy.js";

const canonicalText = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s);
export const releaseRegistryEntrySchema = z
  .object({
    version: z.literal(1),
    qualificationReference: canonicalText,
    chronycSha256: z.string().regex(/^[a-f0-9]{64}$/),
    chronydSha256: z.string().regex(/^[a-f0-9]{64}$/),
    profile: consentHostPolicySchema,
    keyReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    disposition: z.enum(["CURRENT", "VERIFY_ONLY", "REVOKED"]),
  })
  .strict();

const record = z
  .object({
    version: z.literal(1),
    approvalReference: canonicalText,
    releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
    validFromMs: z.number().int().safe().nonnegative(),
    validUntilMs: z.number().int().safe().positive(),
    lifetimeMs: z.literal(PACKAGE_CONSENT_STRICT_LIFETIME_MS),
    policy: z.unknown(),
    entries: z.array(releaseRegistryEntrySchema).min(1).max(512),
    keyRoot: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]+$/)
      .max(4096),
    readerGroupId: z.number().int().safe().positive(),
  })
  .strict();

/** Verification building block only. The caller must independently obtain the protected
 * trust anchor, actual running release SHA and host identity, trusted current-time interval
 * and prior registry.
 * A signed statement of its own SHA is not evidence of the running artifact's identity.
 * No request, environment variable, database record or self-reported SHA is a trust source. */
export function verifyAuthenticatedReleaseRecord(input: {
  payload: Buffer;
  signature: Buffer;
  approvalPublicKey: KeyObject;
  verifiedRunningReleaseSha: string;
  verifiedHostIdentity: {
    authorityId: string;
    hostId: string;
    configurationHash: string;
    approvedBootId: string;
  };
  trustedNow: { earliestMs: number; latestMs: number };
  previousEntries: readonly ConsentHostAuthorityEntry[];
}) {
  const denied = (): never => {
    throw new Error("Approved First-Class release unavailable");
  };
  try {
    if (
      !Buffer.isBuffer(input.payload) ||
      input.payload.length > 131072 ||
      !Buffer.isBuffer(input.signature) ||
      input.signature.length !== 64 ||
      input.approvalPublicKey.asymmetricKeyType !== "ed25519" ||
      !/^[a-f0-9]{40}$/.test(input.verifiedRunningReleaseSha)
    )
      return denied();
    const signed = Buffer.concat([Buffer.from("bookly:first-class-release:v1\0"), input.payload]);
    if (!verify(null, signed, input.approvalPublicKey, input.signature)) return denied();
    const raw = input.payload.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(input.payload)) return denied();
    const parsed: unknown = JSON.parse(raw);
    // Canonical JSON rules out duplicate keys and alternate encodings of the signed record.
    if (JSON.stringify(parsed) !== raw) return denied();
    const value = record.parse(parsed);
    // Schema parsing trims identities; a signed record must already be in canonical form.
    if (!isDeepStrictEqual(value, parsed)) return denied();
    if (
      value.releaseSha !== input.verifiedRunningReleaseSha ||
      !Number.isSafeInteger(input.trustedNow.earliestMs) ||
      !Number.isSafeInteger(input.trustedNow.latestMs) ||
      input.trustedNow.earliestMs < value.validFromMs ||
      input.trustedNow.latestMs >= value.validUntilMs ||
      input.trustedNow.latestMs < input.trustedNow.earliestMs ||
      value.validUntilMs <= value.validFromMs ||
      value.keyRoot === "/" ||
      posix.normalize(value.keyRoot) !== value.keyRoot
    )
      return denied();
    const policy = parseApprovedConsentClockPolicy(value.policy);
    assertConsentHostHistoryContinuity(input.previousEntries, value.entries);
    const current = value.entries.filter((e) => e.disposition === "CURRENT");
    if (current.length !== 1 || !current[0]) return denied();
    for (const field of ["authorityId", "hostId", "configurationHash", "approvedBootId"] as const)
      if (current[0].profile[field] !== input.verifiedHostIdentity[field]) return denied();
    assertProfileMatchesClockPolicy(current[0].profile, policy);
    return { record: value, policy, current: current[0] };
  } catch {
    return denied();
  }
}
