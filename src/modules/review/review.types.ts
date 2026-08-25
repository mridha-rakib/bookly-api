/**
 * Batch 14 — Reviews & Ratings. Confirmed rules (see the Batch 14 investigation + implementation
 * spec): a Review is created from a Booking, contributes to the Business's aggregate rating only
 * (no Service/Staff rating), is auto-published, and can only be Hidden or Removed by SUPER_ADMIN
 * — never restored (no product evidence supports a restore action; do not invent one).
 */

export const reviewModerationStatuses = ["PUBLISHED", "HIDDEN", "REMOVED"] as const;
export type ReviewModerationStatus = (typeof reviewModerationStatuses)[number];

export const reviewModerationActions = ["HIDE", "REMOVE"] as const;
export type ReviewModerationAction = (typeof reviewModerationActions)[number];

/** Confirmed rule 1.7 — the edit window is anchored to `review.createdAt`, never
 * `booking.completedAt` or reset on edit. 14 days, exact. */
export const REVIEW_EDIT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Confirmed rule 1.6 — comment is optional, bounded, no title/photos/category ratings. */
export const REVIEW_COMMENT_MAX_LENGTH = 1000;

export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;
