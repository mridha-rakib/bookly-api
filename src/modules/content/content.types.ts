/**
 * Content Manager — FAQ vertical (Phase 1). One FAQ collection, discriminated by `audience`
 * (never separate CustomerFaq / BusinessFaq collections). Confirmed scope for this phase:
 *  - SUPER_ADMIN is the only writer (create / update / delete / reorder) — enforced by the
 *    router-wide `requireRoles(["SUPER_ADMIN"])` gate on super-admin.route.ts, same precedent as
 *    every other Super Admin surface.
 *  - The public read endpoint (`GET /content/faqs?audience=...`) returns PUBLISHED rows only,
 *    ordered by the persisted `order` field. Draft rows never leave the admin surface.
 *  - `audience` is immutable after creation: moving a row between audiences would scramble both
 *    audiences' `order` sequences, and no product rule asks for it.
 */

export const faqAudiences = ["CUSTOMER", "BUSINESS"] as const;
export type FaqAudience = (typeof faqAudiences)[number];

export const faqStatuses = ["PUBLISHED", "DRAFT"] as const;
export type FaqStatus = (typeof faqStatuses)[number];

export const FAQ_QUESTION_MAX_LENGTH = 300;
export const FAQ_ANSWER_MAX_LENGTH = 4000;

/** Upper bound on a single reorder payload — far above any realistic FAQ count per audience,
 * low enough to reject an abusive request outright at the validation layer. */
export const FAQ_REORDER_MAX_IDS = 500;
