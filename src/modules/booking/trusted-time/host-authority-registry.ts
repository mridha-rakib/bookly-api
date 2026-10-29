import { consentHostPolicySchema, validateConsentHostPolicy } from "./host-policy.js";
import type { QualifiedConsentHost } from "./qualified-host.js";

export type ConsentHostIdentity = Pick<
  QualifiedConsentHost,
  "authorityId" | "hostId" | "configurationHash" | "approvedBootId"
>;
export type ConsentHostAuthorityEntry = {
  version: 1;
  qualificationReference: string;
  chronycSha256: string;
  chronydSha256: string;
  /** New immutable authority id for every boot, key version or policy change. */
  profile: Omit<QualifiedConsentHost, "auditKey">;
  keyReference: string;
  keyVersion: string;
  disposition: "CURRENT" | "VERIFY_ONLY" | "REVOKED";
};

const denied = (): never => {
  throw Error("Consent host authority unavailable");
};
const text = (value: string) =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;

/** Inert composition building block, NOT a qualification grant or an installation API.
 * The production registry never calls this until an independently approved release supplies
 * its reviewed entries and protected resolver. No env/JSON/DB discovery or fallback.
 * Resolve on every use so a resolver outage/revocation fails closed; never cache key bytes.
 * HMAC verification still trusts the key-holding service; it is not public-key verification.
 */
export function createConsentHostAuthorityRegistry(
  entries: readonly ConsentHostAuthorityEntry[],
  resolveProtectedKey: (reference: string, version: string, purpose: "SIGN" | "VERIFY") => Buffer,
) {
  const records = new Map<string, ConsentHostAuthorityEntry>();
  for (const input of entries) {
    const parsed = consentHostPolicySchema.safeParse(input.profile);
    if (
      !parsed.success ||
      input.version !== 1 ||
      !text(input.qualificationReference) ||
      !/^[a-f0-9]{64}$/.test(input.chronycSha256) ||
      !/^[a-f0-9]{64}$/.test(input.chronydSha256) ||
      !text(input.keyReference) ||
      !text(input.keyVersion) ||
      !["CURRENT", "VERIFY_ONLY", "REVOKED"].includes(input.disposition) ||
      records.has(input.profile.authorityId)
    )
      denied();
    const profile = parsed.data;
    records.set(profile.authorityId, {
      ...input,
      profile: { ...profile, referenceIds: [...profile.referenceIds] },
    });
  }
  const current = [...records.values()].filter((entry) => entry.disposition === "CURRENT");
  if (current.length > 1) denied();
  const materialize = (
    entry: ConsentHostAuthorityEntry,
    purpose: "SIGN" | "VERIFY",
  ): QualifiedConsentHost => {
    try {
      const key = resolveProtectedKey(entry.keyReference, entry.keyVersion, purpose);
      if (!Buffer.isBuffer(key)) return denied();
      const result = {
        ...entry.profile,
        referenceIds: [...entry.profile.referenceIds],
        auditKey: Buffer.from(key),
      };
      validateConsentHostPolicy(result);
      return result;
    } catch {
      return denied();
    }
  };
  return Object.freeze({
    requireCurrent(): QualifiedConsentHost {
      const entry = current[0];
      if (!entry) return denied();
      return materialize(entry, "SIGN");
    },
    requireVerification(identity: ConsentHostIdentity): QualifiedConsentHost {
      const entry = records.get(identity.authorityId);
      if (
        !entry ||
        entry.disposition === "REVOKED" ||
        identity.hostId !== entry.profile.hostId ||
        identity.configurationHash !== entry.profile.configurationHash ||
        identity.approvedBootId !== entry.profile.approvedBootId
      )
        return denied();
      return materialize(entry, "VERIFY");
    },
  });
}
