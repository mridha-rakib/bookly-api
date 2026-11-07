import type { PackageConsentHttpActivation } from "../../../src/modules/booking/package-consent-http-activation.js";
import { requireDevelopmentClock } from "../clock.js";

export * from "../../../src/modules/booking/package-consent-http-activation.js";

requireDevelopmentClock();
export const shippedPackageConsentHttpActivation: PackageConsentHttpActivation = Object.freeze({
  enabled: true,
});
