import { requireDevelopmentClock } from "../clock.js";

export type { QualifiedConsentHost } from "../../../src/modules/booking/trusted-time/qualified-host.js";
export function requireQualifiedConsentHost() {
  return requireDevelopmentClock().profile();
}
// Historical development verification uses retained epochs and its own seal domain in clock.ts.
// Never delegate development evidence to, or populate, the shipped qualification registry.
export function requireConsentHostVerificationProfile(): never {
  throw Error("Development host-clock evidence requires its distinct development verifier");
}
