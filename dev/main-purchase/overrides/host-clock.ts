import { hostObservationSchema } from "../../../src/modules/booking/trusted-time/host-clock.js";
import { requireDevelopmentClock } from "../clock.js";

export * from "../../../src/modules/booking/trusted-time/host-clock.js";
export async function observeConsentHost(witness: string) {
  return hostObservationSchema.parse(requireDevelopmentClock().observe(witness));
}
export function verifyConsentHostObservation(value: unknown, witness: string) {
  return requireDevelopmentClock().verify(hostObservationSchema.parse(value), witness);
}
