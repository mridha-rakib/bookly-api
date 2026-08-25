import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { SuperAdminReviewRowDto } from "../review/review.dto.js";
import type { ReviewDocument } from "../review/review.model.js";
import type { ReviewService } from "../review/review.service.js";
import type { ReviewModerationAction, ReviewModerationStatus } from "../review/review.types.js";

export type SuperAdminReviewListResult = {
  reviews: SuperAdminReviewRowDto[];
  pagination: { page: number; limit: number; total: number };
};

/** Batch 14 — Super Admin Review moderation. Composes the domain `ReviewService` (never
 * re-implements the CAS moderation transition here) with batched Business/Booking enrichment —
 * the same "one batched lookup, never N+1" convention every other Super Admin list surface in
 * this codebase already uses (see SuperAdminPromoService's own precedent). */
export class SuperAdminReviewService {
  public constructor(
    private readonly reviewService: ReviewService,
    private readonly businessRepository: BusinessRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async list(
    filter: { status?: ReviewModerationStatus | undefined; businessId?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<SuperAdminReviewListResult> {
    const { reviews, total } = await this.reviewService.listForModeration(filter, pagination);
    const rows = await this.enrich(reviews);
    return {
      reviews: rows,
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getById(reviewId: string): Promise<SuperAdminReviewRowDto> {
    const review = await this.reviewService.getById(reviewId);
    const [row] = await this.enrich([review]);
    // enrich() always returns exactly one row per input review (a missing Business/Booking name
    // falls back to "—", never drops the row) — the non-null assertion is safe.
    return row as SuperAdminReviewRowDto;
  }

  public async moderate(
    reviewId: string,
    action: ReviewModerationAction,
    actorUserId: string,
  ): Promise<SuperAdminReviewRowDto> {
    const review = await this.reviewService.moderate(reviewId, action, actorUserId);
    const [row] = await this.enrich([review]);
    return row as SuperAdminReviewRowDto;
  }

  private async enrich(reviews: ReviewDocument[]): Promise<SuperAdminReviewRowDto[]> {
    const businessIds = [...new Set(reviews.map((r) => String(r.businessId)))];
    const bookingIds = [...new Set(reviews.map((r) => String(r.bookingId)))];
    const [businesses, bookings] = await Promise.all([
      this.businessRepository.findManyByIds(businessIds),
      this.bookingRepository.findManyByIdsCrossBusiness(bookingIds),
    ]);
    const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));
    const bookingReferenceById = new Map(bookings.map((b) => [String(b._id), b.reference]));

    return reviews.map((review) => ({
      id: String(review._id),
      bookingId: String(review.bookingId),
      bookingReference: bookingReferenceById.get(String(review.bookingId)) ?? "—",
      businessId: String(review.businessId),
      businessName: businessNameById.get(String(review.businessId)) ?? "—",
      reviewerDisplayName: review.reviewerDisplayName,
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      createdAt: review.createdAt.toISOString(),
      moderationHistory: review.moderationHistory.map((entry) => ({
        action: entry.action,
        actorUserId: String(entry.actorUserId),
        previousStatus: entry.previousStatus,
        resultingStatus: entry.resultingStatus,
        createdAt: entry.createdAt.toISOString(),
      })),
    }));
  }
}
