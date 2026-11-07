/** LOCAL ACCEPTANCE override (NON-PRODUCTION). Only acquisition is replaced; the shipped schema,
 * chrony parser and verifyConsentHostObservation are re-exported unchanged. */

import type { HostObservation } from "../../../src/modules/booking/trusted-time/host-clock.js";
import { hostObservationSchema } from "../../../src/modules/booking/trusted-time/host-clock.js";
import { assertLocalAcceptanceComposed, observeLocalAcceptanceClock } from "../authority.js";

export * from "../../../src/modules/booking/trusted-time/host-clock.js";

export async function observeConsentHost(witnessHash: string): Promise<HostObservation> {
  return hostObservationSchema.parse(
    observeLocalAcceptanceClock(assertLocalAcceptanceComposed(), witnessHash),
  );
}
