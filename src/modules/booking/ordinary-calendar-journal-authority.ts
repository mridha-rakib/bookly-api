/**
 * P4B-2A/P4B-2B — ordinary Calendar rollout authorities, both default denied.
 *
 * `ordinaryCalendarAuthoritativeModeAvailable` decides, once inside each creating Booking
 * transaction, whether that new Booking is journal-owned (AUTHORITATIVE) or stays with the
 * existing best-effort path (SHADOW). While it returns false every new row is SHADOW.
 *
 * `verifyOrdinaryCalendarDeliveryAuthority` gates every journal consumer action: dispatch,
 * provider mutation, worker pass and Owner recovery. While it throws, nothing reads the
 * journal to call Google.
 *
 * No environment flag, caller argument, HTTP route or database field can change either.
 * A reviewed activation release replaces this module after the credentials/scopes, the
 * uncertain-write runbook, the index rollout and the per-Booking cutover are approved. The
 * delivery authority must be enabled first (or together); enabling AUTHORITATIVE creation
 * alone would leave journal-owned Bookings with no writer. Engineering tests mock this module.
 */
export class OrdinaryCalendarDeliveryUnavailableError extends Error {
  readonly code = "ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE";
  readonly statusCode = 503;
  constructor() {
    super("Ordinary Calendar delivery requires independent verification and rollout approval");
    this.name = "OrdinaryCalendarDeliveryUnavailableError";
  }
}

export async function ordinaryCalendarAuthoritativeModeAvailable(): Promise<boolean> {
  return false;
}

export async function verifyOrdinaryCalendarDeliveryAuthority(): Promise<void> {
  throw new OrdinaryCalendarDeliveryUnavailableError();
}
