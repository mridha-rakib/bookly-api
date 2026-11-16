import { readApprovedFirstClassRelease } from "./approved-first-class-release.js";
import { PACKAGE_CONSENT_STRICT_LIFETIME_MS } from "./package-consent-commit-deadline.js";
import {
  requireConsentHostVerificationProfile,
  requireQualifiedConsentHost,
} from "./trusted-time/qualified-host.js";
import { requireQualifiedLinuxBoot } from "./trusted-time/require-qualified-linux-boot.js";

/** Release authority is separate from the per-purchase durable consent certificate, payment
 * proof and transaction checks. Missing or inconsistent release/host inputs always deny. */
export class PackageBatchActivationUnavailableError extends Error {
  public readonly code = "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE";
  public readonly statusCode = 503;

  public constructor() {
    super("First-class Package activation requires a supported B1c authority");
    this.name = "PackageBatchActivationUnavailableError";
  }
}

export const verifyPackageBatchActivation = async (): Promise<void> => {
  try {
    const release = readApprovedFirstClassRelease();
    if (!release) throw new PackageBatchActivationUnavailableError();
    if (
      release.version !== 1 ||
      typeof release.approvalReference !== "string" ||
      !release.approvalReference.trim() ||
      release.approvalReference.trim() !== release.approvalReference ||
      release.lifetimeMs !== PACKAGE_CONSENT_STRICT_LIFETIME_MS
    )
      throw new PackageBatchActivationUnavailableError();
    const host = requireQualifiedConsentHost();
    if (
      release.authorityId !== host.authorityId ||
      release.hostId !== host.hostId ||
      release.configurationHash !== host.configurationHash ||
      release.approvedBootId !== host.approvedBootId
    )
      throw new PackageBatchActivationUnavailableError();
    requireConsentHostVerificationProfile(release);
    await requireQualifiedLinuxBoot(host);
  } catch {
    throw new PackageBatchActivationUnavailableError();
  }
};
