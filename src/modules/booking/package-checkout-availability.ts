import { AppError } from "../../common/errors/app-error.js";
import {
  PackageBatchActivationUnavailableError,
  verifyPackageBatchActivation,
} from "./package-batch-authority.js";
import {
  type PackageConsentHttpActivation,
  readPackageConsentHttpReadiness,
  shippedPackageConsentHttpActivation,
} from "./package-consent-http-activation.js";
import { requireQualifiedConsentHost } from "./trusted-time/qualified-host.js";

/** Read-only display hint for catalogue/offer DTOs. True only when a Customer could actually
 * start the journey: Consent HTTP is activated in this composition (same gate the mounted
 * consent route applies), the consent host is qualified, and batch purchase is activated.
 * Any partial rollout returns false. It grants nothing: every quote, acceptance,
 * certification and purchase request re-checks its own authority.
 * Normal composition always returns false (all three fail closed). No writes, no clock read. */
export async function readPackageCheckoutAvailability(
  consentHttp: PackageConsentHttpActivation = shippedPackageConsentHttpActivation,
): Promise<boolean> {
  if (readPackageConsentHttpReadiness(consentHttp).state !== "READY") return false;
  try {
    requireQualifiedConsentHost();
    await verifyPackageBatchActivation();
    return true;
  } catch (error) {
    if (error instanceof PackageBatchActivationUnavailableError || error instanceof AppError)
      return false;
    throw error;
  }
}
