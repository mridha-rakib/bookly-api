import type { ApprovedHostConfiguration } from "./approved-release-loader.js";
import { createFileAuditKeyResolver } from "./file-audit-key-resolver.js";
import {
  pinnedFirstClassHostConfiguration,
  readLiveFirstClassAuthority,
} from "./first-class-deployment-authority.js";
import { assertConsentHostHistoryContinuity } from "./host-authority-history.js";
import type { QualifiedConsentHostCompositionInput } from "./qualified-host-composition.js";

/** Host composition authenticated at startup by the independent deployment authority.
 * Environment flags, request data and database records cannot populate this value. */
function readApprovedHostConfiguration(): ApprovedHostConfiguration | undefined {
  return pinnedFirstClassHostConfiguration;
}

function composeInput(): QualifiedConsentHostCompositionInput | undefined {
  const configuration = readApprovedHostConfiguration();
  if (!configuration) return undefined;
  try {
    assertConsentHostHistoryContinuity(configuration.previousEntries, configuration.entries);
    const resolve = createFileAuditKeyResolver(configuration.keyRoot, configuration.readerGroupId);
    return {
      policy: configuration.policy,
      entries: configuration.entries,
      // Issuing new evidence requires a currently fresh attestation. Verifying historical
      // evidence keeps working on the startup-authenticated registry.
      resolveProtectedKey: (reference, version, purpose) => {
        if (purpose !== "VERIFY" && !readLiveFirstClassAuthority())
          throw Error("First-Class deployment authority is not current");
        return resolve(reference, version, purpose);
      },
    };
  } catch {
    return undefined;
  }
}

export const approvedConsentHostInput = composeInput();
