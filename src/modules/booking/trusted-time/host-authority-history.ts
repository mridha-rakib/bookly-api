import { isDeepStrictEqual } from "node:util";
import {
  type ConsentHostAuthorityEntry,
  createConsentHostAuthorityRegistry,
} from "./host-authority-registry.js";

const denied = (): never => {
  throw Error("Consent host authority history is not continuous");
};

/** Disposition moves that a reviewed release may make. Revocation is terminal, and an
 * earlier generation is never promoted back to issuer: a requalified boot, key version or
 * policy always gets a NEW authority id (P4I §3 step 1, §4). */
const ALLOWED: Readonly<Record<ConsentHostAuthorityEntry["disposition"], readonly string[]>> = {
  CURRENT: ["CURRENT", "VERIFY_ONLY", "REVOKED"],
  VERIFY_ONLY: ["VERIFY_ONLY", "REVOKED"],
  REVOKED: ["REVOKED"],
};

const withoutDisposition = ({ disposition: _d, ...rest }: ConsentHostAuthorityEntry) => rest;

/** Release-review check between the previously released registry snapshot and the next one.
 * Pure and offline: it resolves no key and grants nothing.
 *
 * - Both snapshots must be structurally valid registries (canonical identities, one issuer).
 * - Every previous entry is retained unchanged except for an allowed disposition move.
 *   Removal is refused: retention/retirement of historical evidence is an unapproved Owner
 *   policy, and removing an entry makes its sealed evidence unverifiable.
 * - A new entry may not reuse a REVOKED generation's protected key reference/version, and may
 *   not re-add a REVOKED profile under a fresh id. Either would bypass revocation.
 */
export function assertConsentHostHistoryContinuity(
  previous: readonly ConsentHostAuthorityEntry[],
  next: readonly ConsentHostAuthorityEntry[],
): void {
  const neverResolve = (): Buffer => denied();
  try {
    createConsentHostAuthorityRegistry(previous, neverResolve);
    createConsentHostAuthorityRegistry(next, neverResolve);
  } catch {
    denied();
  }
  const following = new Map(next.map((entry) => [entry.profile.authorityId, entry]));
  const prior = new Set(previous.map((entry) => entry.profile.authorityId));
  for (const before of previous) {
    const after = following.get(before.profile.authorityId);
    if (
      !after ||
      !isDeepStrictEqual(withoutDisposition(before), withoutDisposition(after)) ||
      !ALLOWED[before.disposition].includes(after.disposition)
    )
      denied();
  }
  const revoked = [...previous, ...next].filter((entry) => entry.disposition === "REVOKED");
  for (const added of next) {
    if (prior.has(added.profile.authorityId)) continue;
    for (const old of revoked) {
      if (old === added) continue;
      const { authorityId: _a, ...addedProfile } = added.profile;
      const { authorityId: _b, ...oldProfile } = old.profile;
      if (
        (added.keyReference === old.keyReference && added.keyVersion === old.keyVersion) ||
        isDeepStrictEqual(addedProfile, oldProfile)
      )
        denied();
    }
  }
}
