import type { ReviewDocument } from "./review.model.js";
import { REVIEW_EDIT_WINDOW_MS } from "./review.types.js";

/**
 * Confirmed rule 1.13 — public reviewer identity is First Name + Last Name Initial ("Maria K."),
 * never a full surname, email, phone, or any Customer/User database identifier. If only a first
 * name is available, that alone is shown — never an invented surname. This is the ONE reusable
 * formatter (confirmed rule 23) and is applied ONCE, at Review-creation time (see
 * review.service.ts), producing the `reviewerDisplayName` snapshot on the Review document itself
 * — never recomputed from a live User read, so no Review DTO ever needs to touch the User/Client
 * documents to render publicly.
 */
export const formatPublicReviewerName = (firstName: string, lastName?: string): string => {
  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName?.trim();
  if (!trimmedLast) {
    return trimmedFirst;
  }
  return `${trimmedFirst} ${trimmedLast.charAt(0).toUpperCase()}.`;
};

/** The public Business Reviews list row — deliberately narrow: no `customerUserId`, no
 * `businessId` (the caller already knows which Business's list this is), no moderation
 * internals. `verified` is always `true` since a Review can only ever be created from a real
 * BOOKLY_MANAGED + COMPLETED Booking the reviewing Customer owned (server-enforced, never a
 * client-settable flag) — see confirmed rule 1.2/1.13 and review.service.ts's `createFromBooking`. */
export type PublicReviewDto = {
  id: string;
  reviewerDisplayName: string;
  rating: number;
  comment?: string | undefined;
  createdAt: string;
  verified: true;
};

export const toPublicReviewDto = (review: ReviewDocument): PublicReviewDto => ({
  id: String(review._id),
  reviewerDisplayName: review.reviewerDisplayName,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt.toISOString(),
  verified: true,
});

/** The Customer's own read of their Review — includes `editableUntil` so the frontend never has
 * to recompute the 14-day deadline itself (confirmed rule 1.7: `review.createdAt`, never
 * `booking.completedAt`, never reset on edit). */
export type CustomerReviewDto = {
  id: string;
  bookingId: string;
  rating: number;
  comment?: string | undefined;
  createdAt: string;
  updatedAt: string;
  editableUntil: string;
};

export const toCustomerReviewDto = (review: ReviewDocument): CustomerReviewDto => ({
  id: String(review._id),
  bookingId: String(review.bookingId),
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt.toISOString(),
  updatedAt: review.updatedAt.toISOString(),
  editableUntil: new Date(review.createdAt.getTime() + REVIEW_EDIT_WINDOW_MS).toISOString(),
});

/** Confirmed rule 9 — Business-level aggregate only; `averageRating: null` (never a fabricated
 * 4.8/5.0/0) when `reviewCount === 0`. */
export type BusinessRatingSummaryDto = {
  businessId: string;
  averageRating: number | null;
  reviewCount: number;
};

/** Super Admin moderation row — full context (confirmed rule 16), but still never a raw
 * Customer/User document: only the same `reviewerDisplayName` snapshot the public list uses, plus
 * enough Business/Booking context (name + reference) for a moderator to act with confidence. */
export type SuperAdminReviewRowDto = {
  id: string;
  bookingId: string;
  bookingReference: string;
  businessId: string;
  businessName: string;
  reviewerDisplayName: string;
  rating: number;
  comment?: string | undefined;
  status: ReviewDocument["status"];
  createdAt: string;
  moderationHistory: Array<{
    action: ReviewDocument["moderationHistory"][number]["action"];
    actorUserId: string;
    previousStatus: ReviewDocument["status"];
    resultingStatus: ReviewDocument["status"];
    createdAt: string;
  }>;
};
