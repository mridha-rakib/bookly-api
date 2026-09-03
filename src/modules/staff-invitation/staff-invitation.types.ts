/**
 * Lifecycle of a staff/supervisor invitation:
 *
 *   PENDING ─┬─▶ ACCEPTED  (invitee provisioned — the accept flow creates User + StaffMembership)
 *            ├─▶ REVOKED   (owner cancelled while still pending)
 *            └─▶ EXPIRED   (past `expiresAt`; set lazily on redeem, never TTL-deleted — the row
 *                           is kept for audit)
 *
 * The three non-PENDING states are terminal; nothing transitions out of them.
 */
export const staffInvitationStatuses = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;

export type StaffInvitationStatus = (typeof staffInvitationStatuses)[number];

/**
 * How the invitee activated the account at acceptance. `PASSWORD` — chose "set a password"
 * (a `passwordHash` is written, `authProviders: ["PASSWORD"]`). `GOOGLE` — chose "Continue with
 * Google" (no password, `authProviders: ["GOOGLE"]` + a LinkedAccount). Recorded for audit only;
 * mirrors {@link RegistrationSessionDocument.authProvider}.
 */
export const staffInvitationAuthProviders = ["PASSWORD", "GOOGLE"] as const;

export type StaffInvitationAuthProvider = (typeof staffInvitationAuthProviders)[number];

/** Default lifetime of an invitation token measured from when it is issued. */
export const STAFF_INVITATION_TTL_HOURS = 72;
