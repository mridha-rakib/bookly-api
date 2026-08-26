import { Types } from "mongoose";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRole } from "../user/user.types.js";
import { formatPublicReviewerName } from "./review.dto.js";
import { ReviewError } from "./review.errors.js";
import type { ReviewDocument } from "./review.model.js";
import type { ReviewListPagination, ReviewRepository } from "./review.repository.js";
import {
  REVIEW_EDIT_WINDOW_MS,
  type ReviewModerationAction,
  type ReviewModerationStatus,
} from "./review.types.js";

export type ReviewWriteInput = {
  rating: number;
  comment?: string | undefined;
};

export type ReviewStateForBooking = {
  eligible: boolean;
  review: ReviewDocument | null;
};

/**
 * Batch 14 — the core Review domain service. Deliberately thin over `BookingRepository`'s
 * EXISTING ownership primitive (`findByIdForCustomer`) — never a second, re-derived ownership
 * check. Every write path re-resolves the owning Booking itself; nothing here ever trusts a
 * client-submitted businessId/customerUserId/status (confirmed rule 4).
 *
 * Aggregation architecture (confirmed rule 10): on-demand `$group` over the Review collection
 * (see review.repository.ts's `getAggregate`), the SAME "aggregate on demand, no denormalized
 * summary" choice this session already made for Promo's discounted-money figure
 * (PromoRedemptionRepository.sumDiscountInRange) — at current expected scale (a handful to a few
 * hundred Reviews per Business), one indexed `$group` per public-page load is cheap and, unlike a
 * denormalized `Business.ratingSummary` counter, can never drift out of sync with create/edit/
 * hide/remove. Revisit only if real load ever demands it.
 */
export class ReviewService {
  public constructor(
    private readonly reviewRepository: ReviewRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository?: BusinessRepository,
    private readonly staffRepository?: StaffRepository,
  ) {}

  /** Confirmed rule 1.1/1.2/1.4 — the ONLY entry point that verifies eligibility AND creates a
   * Review. `bookingId` is the sole client input naming which Booking this is for; businessId/
   * customerUserId/reviewerDisplayName are always server-derived from the resolved, owned
   * Booking — never accepted from the request body (confirmed rule 4). */
  public async createFromBooking(
    customerUserId: string,
    bookingId: string,
    input: ReviewWriteInput,
  ): Promise<ReviewDocument> {
    const booking = await this.requireOwnedBooking(bookingId, customerUserId);
    this.requireEligible(booking);

    const created = await this.reviewRepository.create({
      bookingId: booking._id,
      businessId: booking.businessId,
      customerUserId: new Types.ObjectId(customerUserId),
      reviewerDisplayName: formatPublicReviewerName(
        booking.customer.contact.firstName,
        booking.customer.contact.lastName,
      ),
      rating: input.rating,
      comment: input.comment,
    });
    if (!created) {
      // The unique bookingId index rejected a concurrent/duplicate attempt (confirmed rule 5) —
      // a clear domain conflict, never a raw Mongo E11000 leaking to the client.
      throw new ReviewError("BOOKING_ALREADY_REVIEWED", 409);
    }
    return created;
  }

  /** Confirmed rule 7/12 — the single read the "My Bookings" card needs to decide which of
   * "Leave a review" / "Edit" / read-only / no action to show, without a second round trip.
   * Ownership is still verified via the SAME query-filter-based Booking check (anti-enumeration:
   * a foreign bookingId is indistinguishable from an unknown one) even though only a boolean +
   * possibly-null Review is returned — never trust a client-asserted bookingId ownership. */
  public async getReviewState(
    customerUserId: string,
    bookingId: string,
  ): Promise<ReviewStateForBooking> {
    const booking = await this.requireOwnedBooking(bookingId, customerUserId);
    const eligible = this.isEligible(booking);
    const review = await this.reviewRepository.findByBookingId(booking._id);
    return { eligible, review };
  }

  /** Confirmed rule 1.7/6 — Customer may update only rating/comment, only within 14 days of
   * `review.createdAt` (never `booking.completedAt`, never reset by a prior edit). */
  public async updateOwnReview(
    customerUserId: string,
    bookingId: string,
    input: ReviewWriteInput,
  ): Promise<ReviewDocument> {
    // Ownership of the BOOKING (not just the Review) is re-verified here for the same
    // anti-enumeration reason as every other Customer-scoped Booking sub-resource in this
    // codebase — a Review for a bookingId belonging to a different Customer must be
    // indistinguishable from a bookingId with no Review at all.
    const booking = await this.requireOwnedBooking(bookingId, customerUserId);
    const review = await this.reviewRepository.findByBookingId(booking._id);
    if (!review) {
      throw new ReviewError("REVIEW_NOT_FOUND", 404);
    }

    const editableUntil = review.createdAt.getTime() + REVIEW_EDIT_WINDOW_MS;
    if (Date.now() > editableUntil) {
      throw new ReviewError("REVIEW_EDIT_WINDOW_EXPIRED", 409);
    }

    const updated = await this.reviewRepository.update(review._id, {
      rating: input.rating,
      comment: input.comment,
    });
    if (!updated) {
      throw new ReviewError("REVIEW_NOT_FOUND", 404);
    }
    return updated;
  }

  // --- Public reads (Business rating summary + Reviews list) --------------------------------

  public async getBusinessRatingSummary(
    businessId: string,
  ): Promise<{ averageRating: number | null; reviewCount: number }> {
    return this.reviewRepository.getAggregate(businessId);
  }

  public async listBusinessReviews(
    businessId: string,
    pagination: ReviewListPagination,
  ): Promise<{ reviews: ReviewDocument[]; total: number }> {
    return this.reviewRepository.listPublishedByBusinessId(businessId, pagination);
  }

  // --- Business dashboard reads (Batch 19 — Owner/Supervisor viewing their OWN business's
  // reviews; same underlying data as the public reads above, just ownership/membership-checked
  // instead of CUSTOMER-role-checked). STAFF is deliberately excluded — matches the exact
  // ownership/membership boundary BookingService.requireBookingManagementAccess and
  // ClientService's requireBusinessAccess already enforce (no product rule grants STAFF
  // business-management read access; confirmed by that consistent precedent). -------------------

  public async getBusinessRatingSummaryForActor(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<{ averageRating: number | null; reviewCount: number }> {
    await this.requireBusinessManagementAccess(actorUserId, actorRole, businessId);
    return this.getBusinessRatingSummary(businessId);
  }

  public async listBusinessReviewsForActor(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    pagination: ReviewListPagination,
  ): Promise<{ reviews: ReviewDocument[]; total: number }> {
    await this.requireBusinessManagementAccess(actorUserId, actorRole, businessId);
    return this.listBusinessReviews(businessId, pagination);
  }

  // --- Super Admin moderation (confirmed rule 1.11/1.18) -------------------------------------

  public async getById(reviewId: string): Promise<ReviewDocument> {
    if (!Types.ObjectId.isValid(reviewId)) {
      throw new ReviewError("REVIEW_NOT_FOUND", 404);
    }
    const review = await this.reviewRepository.findById(reviewId);
    if (!review) {
      throw new ReviewError("REVIEW_NOT_FOUND", 404);
    }
    return review;
  }

  public async listForModeration(
    filter: { status?: ReviewModerationStatus | undefined; businessId?: string | undefined },
    pagination: ReviewListPagination,
  ): Promise<{ reviews: ReviewDocument[]; total: number }> {
    return this.reviewRepository.listForModeration(filter, pagination);
  }

  /** Forward-only from PUBLISHED (confirmed rule 1.11/21 — no Restore). CAS-protected: two
   * concurrent moderation actions (or a stale retry) can transition a Review at most once. */
  public async moderate(
    reviewId: string,
    action: ReviewModerationAction,
    actorUserId: string,
  ): Promise<ReviewDocument> {
    const review = await this.getById(reviewId);
    if (review.status !== "PUBLISHED") {
      throw new ReviewError("REVIEW_INVALID_STATUS_TRANSITION", 409);
    }

    const resultingStatus: ReviewModerationStatus = action === "HIDE" ? "HIDDEN" : "REMOVED";
    const updated = await this.reviewRepository.transitionStatus(
      review._id,
      "PUBLISHED",
      resultingStatus,
      {
        action,
        actorUserId: new Types.ObjectId(actorUserId),
        previousStatus: "PUBLISHED",
        resultingStatus,
        createdAt: new Date(),
      },
    );
    if (!updated) {
      // Lost a concurrent race to another moderation action — the review is no longer PUBLISHED.
      throw new ReviewError("REVIEW_INVALID_STATUS_TRANSITION", 409);
    }
    return updated;
  }

  // --- Internal ------------------------------------------------------------------------------

  /** Mirrors BookingService.requireBookingManagementAccess / ClientService's requireBusinessAccess
   * exactly (same ownership/membership shape, same anti-enumeration 404-not-403 on mismatch) —
   * deliberately not extracted into a shared helper since each caller's error type differs. */
  private async requireBusinessManagementAccess(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!this.businessRepository || !this.staffRepository) {
      throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
    }

    if (!Types.ObjectId.isValid(businessId)) {
      throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
    }

    if (actorRole === "BUSINESS_OWNER") {
      if (!business.ownerUserId.equals(actorUserId)) {
        throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    if (actorRole === "SUPERVISOR") {
      const membership = await this.staffRepository.findActiveByUserId(actorUserId);

      if (membership?.role !== "SUPERVISOR" || !membership.businessId.equals(business._id)) {
        throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    throw new ReviewError("REVIEW_BUSINESS_NOT_FOUND", 404);
  }

  private async requireOwnedBooking(
    bookingId: string,
    customerUserId: string,
  ): Promise<BookingDocument> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new ReviewError("REVIEW_BOOKING_NOT_FOUND", 404);
    }
    const booking = await this.bookingRepository.findByIdForCustomer(bookingId, customerUserId);
    if (!booking) {
      throw new ReviewError("REVIEW_BOOKING_NOT_FOUND", 404);
    }
    return booking;
  }

  /** Confirmed rule 1.1/1.2 — COMPLETED status AND BOOKLY_MANAGED source, both required. A
   * MANUAL booking is NEVER eligible, even if COMPLETED, even if the Customer is linked, even if
   * the request is hand-forged with a real bookingId the Customer genuinely owns (confirmed rule
   * 20) — this check is the single enforcement point both `createFromBooking` and
   * `getReviewState` share, so there is no second code path that could disagree. */
  private isEligible(booking: BookingDocument): boolean {
    return booking.source === "BOOKLY_MANAGED" && booking.status === "COMPLETED";
  }

  private requireEligible(booking: BookingDocument): void {
    if (!this.isEligible(booking)) {
      throw new ReviewError("BOOKING_NOT_REVIEW_ELIGIBLE", 400);
    }
  }
}
