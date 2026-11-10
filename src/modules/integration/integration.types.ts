/**
 * CONNECTED: usable. ERROR: the last best-effort sync failed (transient or unknown).
 * RECONNECT_REQUIRED (P2.2.9): Google revoked/expired the grant — no Google call is attempted
 * until the Owner reconnects through the OAuth flow (which resets the row to CONNECTED).
 */
export const googleCalendarIntegrationStatuses = [
  "CONNECTED",
  "ERROR",
  "RECONNECT_REQUIRED",
] as const;

export type GoogleCalendarIntegrationStatus = (typeof googleCalendarIntegrationStatuses)[number];
