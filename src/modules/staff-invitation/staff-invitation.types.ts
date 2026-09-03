/**
 * Lifecycle of a staff/supervisor invitation:
 *
 *   PENDING ─┬─▶ ACCEPTED  (invitee provisioned — a later phase creates User + StaffMembership)
 *            ├─▶ REVOKED   (owner cancelled while still pending)
 *            └─▶ EXPIRED   (past `expiresAt`; set by a future sweep, never TTL-deleted — the row
 *                           is kept for audit)
 *
 * The three non-PENDING states are terminal; nothing transitions out of them.
 */
export const staffInvitationStatuses = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;

export type StaffInvitationStatus = (typeof staffInvitationStatuses)[number];

/** Default lifetime of an invitation token measured from when it is issued. */
export const STAFF_INVITATION_TTL_HOURS = 72;
