import { AppError } from "../../../common/errors/app-error.js";
import {
  assertProfileMatchesClockPolicy,
  parseApprovedConsentClockPolicy,
} from "./consent-clock-policy.js";
import {
  type ConsentHostAuthorityEntry,
  type ConsentHostIdentity,
  createConsentHostAuthorityRegistry,
} from "./host-authority-registry.js";
import type { QualifiedConsentHost } from "./qualified-host.js";

/** Identical to the shipped deny-only seams, so every existing caller (checkout readiness,
 * consent protocol, certification, purchase authority) keeps its AppError handling. */
export const consentHostUnqualifiedError = () =>
  new AppError("Consent host qualification and numerical policy are pending", 503, {
    details: [
      { code: "PACKAGE_CONSENT_HOST_UNQUALIFIED", message: "No production clock is approved" },
    ],
  });
export const consentHostVerificationUnavailableError = () =>
  new AppError("Consent host verification authority is unavailable", 503, {
    details: [
      {
        code: "PACKAGE_CONSENT_HOST_VERIFICATION_UNAVAILABLE",
        message: "No historical authority is approved",
      },
    ],
  });

export type QualifiedConsentHostComposition = Readonly<{
  requireQualifiedConsentHost(): QualifiedConsentHost;
  requireConsentHostVerificationProfile(identity: ConsentHostIdentity): QualifiedConsentHost;
}>;

const deniedComposition: QualifiedConsentHostComposition = Object.freeze({
  requireQualifiedConsentHost: () => {
    throw consentHostUnqualifiedError();
  },
  requireConsentHostVerificationProfile: () => {
    throw consentHostVerificationUnavailableError();
  },
});

/** P4I §3 step 3 building block, NOT a qualification, installer or activation API. The shipped
 * host seam delegates here using a release-owned input, which is currently unconfigured. A
 * coordinated release still needs an approved policy, qualified entries and protected resolver.
 *
 * Every input is required; there are no defaults and no environment, file, JSON or database
 * discovery. Construction never throws: missing/invalid policy, entries or resolver yields a
 * composition that denies with the shipped errors. Per call, the registry re-resolves the
 * protected key (no caching), and resolver/identity/revocation failures are mapped to the same
 * sanitized AppErrors, never a raw message, reference or key.
 *
 * The approved policy binds only the CURRENT issuer. VERIFY_ONLY history keeps the limits it
 * was originally qualified under, so a policy change never invalidates sealed evidence.
 */
export type QualifiedConsentHostCompositionInput = {
  policy: unknown;
  entries: readonly ConsentHostAuthorityEntry[];
  resolveProtectedKey: (reference: string, version: string, purpose: "SIGN" | "VERIFY") => Buffer;
};

export function composeQualifiedConsentHost(
  input: QualifiedConsentHostCompositionInput | undefined,
): QualifiedConsentHostComposition {
  let registry: ReturnType<typeof createConsentHostAuthorityRegistry>;
  let policy: ReturnType<typeof parseApprovedConsentClockPolicy>;
  try {
    if (!Array.isArray(input?.entries) || typeof input.resolveProtectedKey !== "function")
      return deniedComposition;
    policy = parseApprovedConsentClockPolicy(input.policy);
    for (const entry of input.entries)
      if (entry?.disposition === "CURRENT") assertProfileMatchesClockPolicy(entry.profile, policy);
    registry = createConsentHostAuthorityRegistry(input.entries, input.resolveProtectedKey);
  } catch {
    return deniedComposition;
  }
  return Object.freeze({
    requireQualifiedConsentHost(): QualifiedConsentHost {
      try {
        const host = registry.requireCurrent();
        assertProfileMatchesClockPolicy(host, policy);
        return host;
      } catch {
        throw consentHostUnqualifiedError();
      }
    },
    requireConsentHostVerificationProfile(identity: ConsentHostIdentity): QualifiedConsentHost {
      try {
        return registry.requireVerification(identity);
      } catch {
        throw consentHostVerificationUnavailableError();
      }
    },
  });
}
