/**
 * Marketing Email Stage M3A/M3B — campaign domain enums + snapshot shapes.
 *
 * M3A built the persistent campaign + recipient domain + audience materialization (no send).
 * M3B adds the delivery worker: `MATERIALIZING → SENDING → SENT`, live per-recipient eligibility
 * re-check, live source re-validation, the marketing renderer, retry/backoff, and campaign
 * completion. Still SUPER_ADMIN / PLATFORM / `ALL_OPTED_IN` / ARTICLE|PROMO only.
 */

/** M3 v1 campaign types. Both are PLATFORM campaigns created by SUPER_ADMIN. `BUSINESS_ADDON`
 * is deliberately absent — deferred to M3D. */
export const marketingCampaignTypes = ["ARTICLE", "PROMO"] as const;
export type MarketingCampaignType = (typeof marketingCampaignTypes)[number];

/** Only PLATFORM in M3A. `BUSINESS` is reserved for M3D and is never accepted from a request. */
export const marketingCampaignOwnerScopes = ["PLATFORM"] as const;
export type MarketingCampaignOwnerScope = (typeof marketingCampaignOwnerScopes)[number];

/**
 * Campaign lifecycle. M3A uses only DRAFT → SCHEDULED → MATERIALIZING. The rest are declared so
 * M3B/M3C extend the same enum rather than redefining it.
 *  - DRAFT         created, editable (schedule only, in M3A)
 *  - SCHEDULED     a send time is fixed (== createdAt for "send now")
 *  - MATERIALIZING audience is being built into MarketingCampaignRecipient rows
 *  - SENDING       (M3B) worker is delivering
 *  - SENT          (M3B) terminal success
 *  - CANCELLED     stopped before completion
 *  - FAILED        source invalid / unrecoverable
 */
export const marketingCampaignStatuses = [
  "DRAFT",
  "SCHEDULED",
  "MATERIALIZING",
  "SENDING",
  "SENT",
  "CANCELLED",
  "FAILED",
] as const;
export type MarketingCampaignStatus = (typeof marketingCampaignStatuses)[number];

/** Statuses a campaign may be cancelled from. `SENDING` is a best-effort cancel (M3B): the
 * worker stops claiming and every still-pending recipient is terminalized `CANCELLED`, but a
 * message already handed to the provider cannot be recalled. */
export const cancellableMarketingCampaignStatuses = [
  "DRAFT",
  "SCHEDULED",
  "MATERIALIZING",
  "SENDING",
] as const satisfies readonly MarketingCampaignStatus[];

/** Audience selection. v1 is platform-wide opted-in customers only. */
export const marketingAudienceScopes = ["ALL_OPTED_IN"] as const;
export type MarketingAudienceScope = (typeof marketingAudienceScopes)[number];

/** What the campaign points at. Matches {@link MarketingCampaignType} 1:1 in M3A. */
export const marketingSourceKinds = ["BLOG_POST", "PROMO_CODE"] as const;
export type MarketingSourceKind = (typeof marketingSourceKinds)[number];

/**
 * Recipient row lifecycle. M3A only ever writes `PENDING`. `PROCESSING` is the M3B claim state;
 * the rest are M3B terminal states:
 *  - SENT                   delivered (provider-accepted)
 *  - SKIPPED_OPT_OUT        live `marketingEmail` is no longer true
 *  - SKIPPED_UNVERIFIED     live email not verified / unusable
 *  - SKIPPED_INACTIVE       user missing / not CUSTOMER / not ACTIVE
 *  - SKIPPED_SOURCE_INVALID the article/promo went invalid mid-campaign
 *  - FAILED                 permanent provider error, or attempts exhausted
 *  - CANCELLED              the campaign was cancelled while this row was still pending/in-flight
 */
export const marketingRecipientStatuses = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "SKIPPED_OPT_OUT",
  "SKIPPED_UNVERIFIED",
  "SKIPPED_INACTIVE",
  "SKIPPED_SOURCE_INVALID",
  "FAILED",
  "CANCELLED",
] as const;
export type MarketingRecipientStatus = (typeof marketingRecipientStatuses)[number];

/** Every non-`PENDING`, non-`PROCESSING` state — used by the completion check and the count
 * reconciliation aggregation. */
export const terminalMarketingRecipientStatuses = [
  "SENT",
  "SKIPPED_OPT_OUT",
  "SKIPPED_UNVERIFIED",
  "SKIPPED_INACTIVE",
  "SKIPPED_SOURCE_INVALID",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly MarketingRecipientStatus[];

// --- Source snapshots (hybrid strategy: display fields frozen here, validity re-read live at
// M3B send time via `source.sourceId`). Deliberately minimal — no bodyHtml, no full documents.

export type ArticleSourceSnapshot = {
  title: string;
  excerpt: string;
  /** Resolved cover image URL at creation time, or `null`. May be a short-lived presigned URL —
   * M3B re-resolves from the live BlogPost when it renders. */
  coverImageUrl: string | null;
};

export type PromoSourceSnapshot = {
  normalizedCode: string;
  type: "PERCENTAGE" | "FIXED";
  value: number;
  expiresAt: Date;
  scope: string;
  businessIds: string[];
};

export type MarketingCampaignSource = {
  kind: MarketingSourceKind;
  /** The live source `_id` (BlogPost / PromoCode) — the anchor M3B re-validates against. */
  sourceId: string;
  /** Present for BLOG_POST (the article slug). */
  sourceSlug?: string | undefined;
  /** Absolute customer-facing URL built from an EXISTING route (never an invented landing page). */
  ctaUrl: string;
  snapshot: ArticleSourceSnapshot | PromoSourceSnapshot;
};

export type MarketingCampaignCounts = {
  audience: number;
  sent: number;
  skippedOptOut: number;
  skippedUnverified: number;
  skippedInactive: number;
  skippedSourceInvalid: number;
  failed: number;
  cancelled: number;
};

export const zeroMarketingCampaignCounts = (): MarketingCampaignCounts => ({
  audience: 0,
  sent: 0,
  skippedOptOut: 0,
  skippedUnverified: 0,
  skippedInactive: 0,
  skippedSourceInvalid: 0,
  failed: 0,
  cancelled: 0,
});

/** Maps a terminal {@link MarketingRecipientStatus} to the {@link MarketingCampaignCounts} key it
 * increments. `audience` is never derived from a recipient status. */
export const RECIPIENT_STATUS_TO_COUNT_KEY: Record<
  Exclude<MarketingRecipientStatus, "PENDING" | "PROCESSING">,
  keyof Omit<MarketingCampaignCounts, "audience">
> = {
  SENT: "sent",
  SKIPPED_OPT_OUT: "skippedOptOut",
  SKIPPED_UNVERIFIED: "skippedUnverified",
  SKIPPED_INACTIVE: "skippedInactive",
  SKIPPED_SOURCE_INVALID: "skippedSourceInvalid",
  FAILED: "failed",
  CANCELLED: "cancelled",
};
