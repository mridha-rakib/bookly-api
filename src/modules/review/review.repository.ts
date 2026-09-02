import { Types } from "mongoose";
import {
  type ReviewDocument,
  ReviewModel,
  type ReviewModerationHistoryEntry,
} from "./review.model.js";
import type { ReviewModerationStatus } from "./review.types.js";

export type CreateReviewInput = {
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  reviewerDisplayName: string;
  rating: number;
  comment?: string | undefined;
};

export type UpdateReviewInput = {
  rating: number;
  comment?: string | undefined;
};

export type ReviewListPagination = { page: number; limit: number };

export type ReviewModerationFilter = {
  status?: ReviewModerationStatus | undefined;
  businessId?: Types.ObjectId | string | undefined;
};

export type ReviewAggregate = { averageRating: number | null; reviewCount: number };

export class ReviewRepository {
  /** Confirmed rule 1.4/rule 5 — concurrency-safe: relies entirely on the unique `bookingId`
   * index (review.model.ts), never a read-then-write existence check. Returns `null` (never
   * throws a raw Mongo error) when a Review for this Booking already exists — a real, expected
   * outcome the caller maps to a clear domain conflict (`BOOKING_ALREADY_REVIEWED`). */
  public async create(input: CreateReviewInput): Promise<ReviewDocument | null> {
    try {
      return await new ReviewModel({
        ...input,
        status: "PUBLISHED",
        moderationHistory: [],
      }).save();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async findById(reviewId: Types.ObjectId | string): Promise<ReviewDocument | null> {
    return ReviewModel.findById(reviewId).exec();
  }

  public async findByBookingId(bookingId: Types.ObjectId | string): Promise<ReviewDocument | null> {
    return ReviewModel.findOne({ bookingId }).exec();
  }

  /** Confirmed rule 1.6/rule 6 — Customer may update only rating/comment; `createdAt` (the edit
   * window anchor) is never touched. */
  public async update(
    reviewId: Types.ObjectId | string,
    update: UpdateReviewInput,
  ): Promise<ReviewDocument | null> {
    return ReviewModel.findByIdAndUpdate(
      reviewId,
      { $set: { rating: update.rating, comment: update.comment } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  /** Confirmed rule 1.11/rule 21 — CAS transition, filtered on `fromStatus`, so a concurrent
   * second moderation action (or a stale client retry) can never silently overwrite an already-
   * moderated Review; returns `null` when the Review is no longer in `fromStatus` (the caller
   * maps that to `REVIEW_INVALID_STATUS_TRANSITION`, never a raw Mongo/undefined crash). */
  public async transitionStatus(
    reviewId: Types.ObjectId | string,
    fromStatus: ReviewModerationStatus,
    toStatus: ReviewModerationStatus,
    historyEntry: ReviewModerationHistoryEntry,
  ): Promise<ReviewDocument | null> {
    return ReviewModel.findOneAndUpdate(
      { _id: reviewId, status: fromStatus },
      { $set: { status: toStatus }, $push: { moderationHistory: historyEntry } },
      { returnDocument: "after" },
    ).exec();
  }

  /** The public Business Reviews list — PUBLISHED only, never HIDDEN/REMOVED (confirmed rule
   * 1.11's "must never leak publicly"). */
  public async listPublishedByBusinessId(
    businessId: Types.ObjectId | string,
    pagination: ReviewListPagination,
  ): Promise<{ reviews: ReviewDocument[]; total: number }> {
    const filter = { businessId, status: "PUBLISHED" as const };
    const skip = (pagination.page - 1) * pagination.limit;
    const [reviews, total] = await Promise.all([
      ReviewModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      ReviewModel.countDocuments(filter).exec(),
    ]);
    return { reviews, total };
  }

  /** Confirmed rule 9/10 — on-demand aggregation (Option A, see review.service.ts's own doc
   * comment on why a denormalized summary isn't warranted yet), always PUBLISHED-only, always
   * correct after create/edit/hide/remove since it reads the live collection every call — no
   * synchronization to get wrong. `averageRating: null` (never a fabricated 0) when there are no
   * PUBLISHED Reviews yet. */
  public async getAggregate(businessId: Types.ObjectId | string): Promise<ReviewAggregate> {
    const [result] = await ReviewModel.aggregate<{ averageRating: number; reviewCount: number }>([
      { $match: { businessId: new Types.ObjectId(businessId), status: "PUBLISHED" } },
      { $group: { _id: null, averageRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } },
    ]).exec();
    if (!result) {
      return { averageRating: null, reviewCount: 0 };
    }
    return {
      averageRating: Math.round(result.averageRating * 10) / 10,
      reviewCount: result.reviewCount,
    };
  }

  /** Super Admin's global (optionally Business-scoped, optionally status-filtered) moderation
   * list — every status is visible here (unlike the public list), matching confirmed rule 16's
   * "Display enough context for moderation." */
  public async listForModeration(
    filter: ReviewModerationFilter,
    pagination: ReviewListPagination,
  ): Promise<{ reviews: ReviewDocument[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.status) query["status"] = filter.status;
    if (filter.businessId) query["businessId"] = filter.businessId;

    const skip = (pagination.page - 1) * pagination.limit;
    const [reviews, total] = await Promise.all([
      ReviewModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      ReviewModel.countDocuments(query).exec(),
    ]);
    return { reviews, total };
  }

  /**
   * Account-closure cleanup — anonymize this customer's reviewer identity across every review
   * they authored. Best-effort and idempotent: sets the snapshot display name to a constant,
   * matched on the immutable `customerUserId`. Rating, comment, status and moderation history
   * are untouched, and `customerUserId` itself is retained for integrity. Returns how many
   * reviews were updated.
   */
  public async anonymizeReviewerForDeletion(
    customerUserId: Types.ObjectId | string,
  ): Promise<number> {
    const result = await ReviewModel.updateMany(
      { customerUserId },
      { $set: { reviewerDisplayName: "Deleted User" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
