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
export type PackageCheckoutReadiness =
  | { available: true; reason: null }
  | {
      available: false;
      reason:
        | "CONSENT_HTTP_DISABLED"
        | "CONSENT_LIFETIME_NOT_CONFIGURED"
        | "CONSENT_LIFETIME_UNAPPROVED"
        | "CONSENT_HOST_UNQUALIFIED"
        | "BATCH_AUTHORITY_UNAVAILABLE";
    };

/** Sanitized display diagnostics only. No configuration, host identity or key is exposed. */
export async function readPackageCheckoutReadiness(
  consentHttp: PackageConsentHttpActivation = shippedPackageConsentHttpActivation,
): Promise<PackageCheckoutReadiness> {
  const http = readPackageConsentHttpReadiness(consentHttp);
  if (http.state === "DISABLED") return { available: false, reason: "CONSENT_HTTP_DISABLED" };
  if (http.state === "NOT_CONFIGURED")
    return { available: false, reason: "CONSENT_LIFETIME_NOT_CONFIGURED" };
  if (http.state === "LIFETIME_UNAPPROVED")
    return { available: false, reason: "CONSENT_LIFETIME_UNAPPROVED" };
  try {
    requireQualifiedConsentHost();
  } catch (error) {
    if (error instanceof AppError) return { available: false, reason: "CONSENT_HOST_UNQUALIFIED" };
    throw error;
  }
  try {
    await verifyPackageBatchActivation();
    return { available: true, reason: null };
  } catch (error) {
    if (error instanceof PackageBatchActivationUnavailableError || error instanceof AppError)
      return { available: false, reason: "BATCH_AUTHORITY_UNAVAILABLE" };
    throw error;
  }
}

export async function readPackageCheckoutAvailability(
  consentHttp: PackageConsentHttpActivation = shippedPackageConsentHttpActivation,
): Promise<boolean> {
  return (await readPackageCheckoutReadiness(consentHttp)).available;
}
