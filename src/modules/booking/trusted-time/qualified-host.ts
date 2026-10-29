import { AppError } from "../../../common/errors/app-error.js";

export type QualifiedConsentHost = {
  /** Exact reviewed boot. A reboot requires renewed qualification, never auto-adoption. */
  approvedBootId: string;
  authorityId: string;
  hostId: string;
  configurationHash: string;
  chronycPath: string;
  chronycSocketPath: string;
  chronycVersionOutput: string;
  referenceIds: readonly string[];
  maxAcquireMs: number;
  maxSampleAgeMs: number;
  maxErrorMs: number;
  maxDriftPpm: number;
  minRemainingMs: number;
  /** From approved protected host composition, never the database, DTO or browser. */
  auditKey: Buffer;
};

/** Owner approved source trust model, NOT a qualified host or numerical policy. Replace this
 * registry only through audited deployment qualification and explicit final authority approval.
 * No environment flag, posted settings or generic grant factory can activate it. */
export function requireQualifiedConsentHost(): QualifiedConsentHost {
  throw new AppError("Consent host qualification and numerical policy are pending", 503, {
    details: [
      { code: "PACKAGE_CONSENT_HOST_UNQUALIFIED", message: "No production clock is approved" },
    ],
  });
}

/** Historical verification is a separate protected composition seam. Never fall back to
 * the current host or trust an evidence-supplied profile/key. No entries approved yet. */
export function requireConsentHostVerificationProfile(_identity: {
  authorityId: string;
  hostId: string;
  configurationHash: string;
  approvedBootId: string;
}): QualifiedConsentHost {
  throw new AppError("Consent host verification authority is unavailable", 503, {
    details: [
      {
        code: "PACKAGE_CONSENT_HOST_VERIFICATION_UNAVAILABLE",
        message: "No historical authority is approved",
      },
    ],
  });
}
