/** Promo Code system. Confirmed product rules (P2 — supersede Batch 13's deposit-only rules;
 * do not reinterpret):
 *  - SUPER_ADMIN only creates/manages Promo Codes (no Business Owner promo management).
 *  - NORMAL bookings only (never package purchase/redemption/Session 2+). The promo discounts
 *    the booking PRICE — services + add-ons − service discount, travel excluded — BEFORE the
 *    FIRST upfront / RETURNING deposit is computed from the discounted price.
 *  - The Business funds the discount (no Bookly PROMO_SUBSIDY). Batch 13's Bookly-funded,
 *    deposit-only redemptions stay readable as history.
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

/** Stored explicitly (never hardcoded at read sites) so ledger/redemption history stays
 * self-explanatory. P2: every NEW promo redemption is BUSINESS-funded (the promo lowers the
 * Business's booking price; no PROMO_SUBSIDY). BOOKLY remains readable for Batch 13 rows. */
export const promoFundingOwners = ["BOOKLY", "BUSINESS"] as const;
export type PromoFundingOwner = (typeof promoFundingOwners)[number];
