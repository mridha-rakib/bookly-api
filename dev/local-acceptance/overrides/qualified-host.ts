/** LOCAL ACCEPTANCE override (NON-PRODUCTION). Current issuer = the local authority. Historical
 * verification accepts ONLY the exact local identity; anything else gets the shipped denial. */
import * as shipped from "../../../src/modules/booking/trusted-time/qualified-host.js";
import { assertLocalAcceptanceComposed } from "../authority.js";

export type { QualifiedConsentHost } from "../../../src/modules/booking/trusted-time/qualified-host.js";

export function requireQualifiedConsentHost(): shipped.QualifiedConsentHost {
  return assertLocalAcceptanceComposed();
}

export function requireConsentHostVerificationProfile(identity: {
  authorityId: string;
  hostId: string;
  configurationHash: string;
  approvedBootId: string;
}): shipped.QualifiedConsentHost {
  const host = assertLocalAcceptanceComposed();
  if (
    identity.authorityId === host.authorityId &&
    identity.hostId === host.hostId &&
    identity.configurationHash === host.configurationHash &&
    identity.approvedBootId === host.approvedBootId
  )
    return host;
  return shipped.requireConsentHostVerificationProfile(identity);
}
