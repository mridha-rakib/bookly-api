/** LOCAL ACCEPTANCE override (NON-PRODUCTION). Consent HTTP enabled with the shipped lifetime
 * rule (no lifetimeMs override, so exactly 1,800,000 ms is enforced by the shipped reader). */
import type { PackageConsentHttpActivation } from "../../../src/modules/booking/package-consent-http-activation.js";
import { assertLocalAcceptanceComposed } from "../authority.js";

export * from "../../../src/modules/booking/package-consent-http-activation.js";

assertLocalAcceptanceComposed();
export const shippedPackageConsentHttpActivation: PackageConsentHttpActivation = Object.freeze({
  enabled: true,
});
