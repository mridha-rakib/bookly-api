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

/**
 * Content Manager — Blog vertical (Phase 2). One `BlogPost` collection is the single source of
 * truth for both the Super Admin CMS and the public blog. Confirmed scope:
 *  - SUPER_ADMIN is the only writer — same router-wide `requireRoles(["SUPER_ADMIN"])` gate.
 *  - Public endpoints (`GET /content/blog`, `GET /content/blog/:slug`) return PUBLISHED posts
 *    only; DRAFT is never resolvable publicly, by slug or otherwise.
 *  - `bodyHtml` is sanitized server-side on every write (see blog.sanitize.ts) so the DB only
 *    ever holds render-safe HTML.
 *  - Media lives in a dedicated `BlogMedia` asset store (S3 object keys, never signed URLs);
 *    read URLs are minted fresh on every response.
 *
 * The category enum below is CANONICAL and shared by admin + public. The blog category
 * `FOUNDING_PARTNER` is unrelated to `Business.isFoundingPartner` (a separate marketing flag on
 * the Business model) — they only share a display phrase.
 */
export const blogCategories = [
  "FOUNDING_PARTNER",
  "BOOKLY_NEWS",
  "FOR_BUSINESS",
  "CUSTOMER_TIPS",
] as const;
export type BlogCategory = (typeof blogCategories)[number];

export const blogStatuses = ["DRAFT", "PUBLISHED"] as const;
export type BlogStatus = (typeof blogStatuses)[number];

export const BLOG_TITLE_MAX_LENGTH = 200;
export const BLOG_SLUG_MAX_LENGTH = 90;
export const BLOG_EXCERPT_MAX_LENGTH = 500;
export const BLOG_BODY_HTML_MAX_LENGTH = 200_000;
export const BLOG_GALLERY_MAX = 20;

/** Accepted upload types for blog cover/gallery images — same set business-media allows. */
export const blogImageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type BlogImageMimeType = (typeof blogImageMimeTypes)[number];

/**
 * Content Manager — Static Pages vertical (Phase 3). A FIXED set of system legal pages, not a
 * general page builder. Confirmed product rules (derived from the existing UI + AskUserQuestion):
 *  - SUPER_ADMIN is the only writer; there is no create / delete (no "Add page" UI, no dynamic
 *    public route). A page row is upserted the first time it is saved.
 *  - Pages are ALWAYS LIVE — no Draft/Published status. Editing updates the live content
 *    immediately (a live platform must always have accessible Terms/Privacy).
 *  - English only for this phase (the public legal routes render EN; the editor's old GR tab is
 *    removed).
 *  - `bodyHtml` is sanitized server-side on every write (content.sanitize.ts).
 *  - `pageKey` is the stable machine identity (unique); `title` is an editable display value and
 *    is never the DB identity.
 */
export const staticPageKeys = ["TERMS", "TERMS_OF_USE", "PRIVACY", "COOKIES"] as const;
export type StaticPageKey = (typeof staticPageKeys)[number];

/**
 * Canonical display title + public route path per page. The route paths match the existing
 * Next.js route files and Footer links exactly — they are wiring facts, not legal content.
 */
export const STATIC_PAGE_DEFAULTS: Record<StaticPageKey, { title: string; routePath: string }> = {
  TERMS: { title: "Terms & Conditions", routePath: "/terms-of-service" },
  TERMS_OF_USE: { title: "Terms of Use", routePath: "/terms-of-use" },
  PRIVACY: { title: "Privacy Policy", routePath: "/privacy" },
  COOKIES: { title: "Cookie Policy", routePath: "/cookies" },
};

export const STATIC_PAGE_TITLE_MAX_LENGTH = 200;
export const STATIC_PAGE_BODY_HTML_MAX_LENGTH = 200_000;
