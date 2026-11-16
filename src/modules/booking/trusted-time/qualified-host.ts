import { approvedConsentHostInput } from "./approved-consent-host-input.js";
import { composeQualifiedConsentHost } from "./qualified-host-composition.js";

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

/** Construct once from the release-owned input. Missing qualification remains fail-closed;
 * the registry resolves protected keys for every use, including historical verification. */
const approvedHost = composeQualifiedConsentHost(approvedConsentHostInput);

export function requireQualifiedConsentHost(): QualifiedConsentHost {
  return approvedHost.requireQualifiedConsentHost();
}

/** Historical verification is a separate protected composition seam. Never fall back to
 * the current host or trust an evidence-supplied profile/key. No entries approved yet. */
export function requireConsentHostVerificationProfile(identity: {
  authorityId: string;
  hostId: string;
  configurationHash: string;
  approvedBootId: string;
}): QualifiedConsentHost {
  return approvedHost.requireConsentHostVerificationProfile(identity);
}
