/** Batch 13 — Promo Code system. Confirmed product rules (do not reinterpret):
 *  - SUPER_ADMIN only creates/manages Promo Codes (no Business Owner promo management).
 *  - Every Promo Code is Bookly-funded — never the Business.
 *  - A Promo discounts the booking-time ONLINE charge only (the already-computed
 *    clamp(20%, €5, €35) deposit) — never the underlying Service price/eligible basis.
 */
export const promoTypes = ["PERCENTAGE", "FIXED"] as const;
export type PromoType = (typeof promoTypes)[number];

/** ALL_FIRST_BOOKINGS — valid only when the backend determines the booking is a genuine first
 * qualifying booking for that Business (post-activation-race resolution, never the pre-charge
 * optimistic snapshot). ALL_BOOKINGS — valid for both first and returning. SELECTED_BUSINESSES —
 * valid only at the specific Businesses on `businessIds`, for both first and returning bookings
 * (the existing Super Admin UI's scope control offers exactly these 3 options with no way to
 * independently also restrict a Selected-Businesses promo to first-only — see the Batch 13
 * report's own note on this UI/domain mapping). */
export const promoScopes = ["ALL_FIRST_BOOKINGS", "ALL_BOOKINGS", "SELECTED_BUSINESSES"] as const;
export type PromoScope = (typeof promoScopes)[number];

/** EXPIRED is deliberately NOT a stored status — it is derived from `expiresAt` vs "now" at
 * validation/read time (rule: "do not create a cron job merely to mark promos expired"). Stored
 * status is only ever ACTIVE or DEACTIVATED, matching the one real mutation the Super Admin UI
 * performs (deactivate/reactivate). */
export const promoStatuses = ["ACTIVE", "DEACTIVATED"] as const;
export type PromoStatus = (typeof promoStatuses)[number];

/** The one confirmed funding owner — stored explicitly (not hardcoded at every read site) so the
 * ledger/redemption history stays self-explanatory and future-proof if a second funding model is
 * ever added. */
export const promoFundingOwners = ["BOOKLY"] as const;
export type PromoFundingOwner = (typeof promoFundingOwners)[number];
