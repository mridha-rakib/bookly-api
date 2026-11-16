import type { KeyObject } from "node:crypto";
import type { ApprovedFirstClassRelease } from "../approved-first-class-release.js";
import { verifyAuthenticatedReleaseRecord } from "./authenticated-release-record.js";
import type { ConsentHostAuthorityEntry, ConsentHostIdentity } from "./host-authority-registry.js";

/** Facts that only the independent deployment authority may supply (see
 * `deployment-attestation.ts`). Neither the record being verified nor an environment variable
 * may supply them. */
export type ProtectedReleaseEvidence = Readonly<{
  payload: Buffer;
  signature: Buffer;
  approvalPublicKey: KeyObject;
  verifiedRunningReleaseSha: string;
  verifiedHostIdentity: ConsentHostIdentity;
  trustedNow: { earliestMs: number; latestMs: number };
  previousEntries: readonly ConsentHostAuthorityEntry[];
}>;

/** Nonsecret host composition input. The protected key resolver is constructed by the host
 * seam (`approved-consent-host-input.ts`), never here. */
export type ApprovedHostConfiguration = Readonly<{
  policy: unknown;
  previousEntries: readonly ConsentHostAuthorityEntry[];
  entries: readonly ConsentHostAuthorityEntry[];
  keyRoot: string;
  readerGroupId: number;
}>;

/** Pure verification adapter. Throws on any invalid evidence and never installs authority. */
export function loadApprovedFirstClassComposition(evidence: ProtectedReleaseEvidence) {
  const { record, current } = verifyAuthenticatedReleaseRecord(evidence);
  // The verifier already pins the strict 30-minute deadline; restate it as the literal type.
  if (record.lifetimeMs !== 1_800_000) throw Error("Approved First-Class release unavailable");
  const release: ApprovedFirstClassRelease = Object.freeze({
    version: record.version,
    approvalReference: record.approvalReference,
    authorityId: current.profile.authorityId,
    hostId: current.profile.hostId,
    configurationHash: current.profile.configurationHash,
    approvedBootId: current.profile.approvedBootId,
    lifetimeMs: 1_800_000,
  });
  const host: ApprovedHostConfiguration = Object.freeze({
    policy: record.policy,
    previousEntries: evidence.previousEntries,
    entries: record.entries,
    keyRoot: record.keyRoot,
    readerGroupId: record.readerGroupId,
  });
  return { release, host, policy: record.policy, validUntilMs: record.validUntilMs };
}
