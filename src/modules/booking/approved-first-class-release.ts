import { readLiveFirstClassAuthority } from "./trusted-time/first-class-deployment-authority.js";

/** Release-owned decision, never sourced from environment or request data. It exists only
 * while the independent deployment authority's attestation verifies, is fresh and binds the
 * Owner-signed release record to the running artifact, host, boot, clock policy and history. */
export type ApprovedFirstClassRelease = Readonly<{
  version: 1;
  approvalReference: string;
  authorityId: string;
  hostId: string;
  configurationHash: string;
  approvedBootId: string;
  lifetimeMs: 1800000;
}>;

/** Re-evaluated on every call: an expired, rolled-back or missing attestation denies. */
export function readApprovedFirstClassRelease(): ApprovedFirstClassRelease | undefined {
  return readLiveFirstClassAuthority()?.release;
}
