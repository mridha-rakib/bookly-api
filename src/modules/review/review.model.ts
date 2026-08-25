import { model, Schema, type Types } from "mongoose";
import {
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_RATING_MAX,
  REVIEW_RATING_MIN,
  type ReviewModerationAction,
  type ReviewModerationStatus,
  reviewModerationActions,
  reviewModerationStatuses,
} from "./review.types.js";

/**
 * Batch 14 — a single Review collection (no separate Rating collection — nothing in the
 * confirmed rules justifies splitting them). One Review per Booking, enforced by a DB-level
 * unique index on `bookingId` (never only an application-level existence check — see
 * review.repository.ts's `create`, which relies on this index for concurrency safety).
 *
 * `reviewerDisplayName` is a SNAPSHOT computed once at creation time from the owning Booking's
 * own `customer.contact` snapshot (firstName/lastName) — never a live User lookup. This matches
 * this codebase's established snapshot discipline (see BookingServiceLineServiceSnapshot/
 * BookingServiceLineStaffSnapshot) and is what makes the public Review list N+1-free: no
 * per-review Customer document read is ever needed, and no email/phone/customerUserId is ever
 * serialized publicly (see review.dto.ts's DTOs, which never include `customerUserId`).
 *
 * `businessId` is denormalized from the Booking at creation time (a Business is never renamed
 * away from its own reviews — no separate Business-name snapshot is needed here; the public page
 * reads the live Business document for display context, matching confirmed rule 11's "no extra
 * snapshots without a real requirement").
 *
 * Moderation is forward-only from PUBLISHED (confirmed rule 1.11 + rule 21): HIDE/REMOVE both
 * transition FROM "PUBLISHED" only, enforced via a CAS-style `findOneAndUpdate` filtered on the
 * current status (see review.repository.ts's `transitionStatus`) — no Restore action exists,
 * since no product evidence supports one; the Review row and full moderationHistory are always
 * preserved (never physically erased), matching this codebase's "history-preserving, not
 * destructive" moderation convention (see PromoService.delete's own precedent).
 */

export type ReviewModerationHistoryEntry = {
  action: ReviewModerationAction;
  actorUserId: Types.ObjectId;
  previousStatus: ReviewModerationStatus;
  resultingStatus: ReviewModerationStatus;
  createdAt: Date;
};

export type ReviewDocument = {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  reviewerDisplayName: string;
  rating: number;
  comment?: string | undefined;
  status: ReviewModerationStatus;
  moderationHistory: ReviewModerationHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
};

const reviewModerationHistoryEntrySchema = new Schema<ReviewModerationHistoryEntry>(
  {
    action: { type: String, enum: reviewModerationActions, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    previousStatus: { type: String, enum: reviewModerationStatuses, required: true },
    resultingStatus: { type: String, enum: reviewModerationStatuses, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const reviewSchema = new Schema<ReviewDocument>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reviewerDisplayName: { type: String, required: true, trim: true },
    rating: {
      type: Number,
      required: true,
      min: REVIEW_RATING_MIN,
      max: REVIEW_RATING_MAX,
      validate: Number.isInteger,
    },
    comment: { type: String, trim: true, maxlength: REVIEW_COMMENT_MAX_LENGTH },
    status: {
      type: String,
      enum: reviewModerationStatuses,
      required: true,
      default: "PUBLISHED",
    },
    moderationHistory: { type: [reviewModerationHistoryEntrySchema], required: true, default: [] },
  },
  { timestamps: true },
);

// Confirmed rule 1.4 — one Review per Booking, enforced at the database level (concurrency-safe:
// a duplicate create attempt fails with a Mongo E11000 error, caught by review.repository.ts and
// mapped to a clear domain conflict — never a raw Mongo error, never a second Review).
reviewSchema.index({ bookingId: 1 }, { unique: true });
// The public Business Reviews list + on-demand aggregate (see review.repository.ts's
// `listPublishedByBusinessId`/`getAggregate`) — both filter on exactly {businessId, status} and
// sort by createdAt.
reviewSchema.index({ businessId: 1, status: 1, createdAt: -1 });
// Super Admin's global (cross-business) moderation list, optionally status-filtered.
reviewSchema.index({ status: 1, createdAt: -1 });

export const ReviewModel = model<ReviewDocument>("Review", reviewSchema);
