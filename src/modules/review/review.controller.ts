import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import { toCustomerReviewDto, toPublicReviewDto } from "./review.dto.js";
import type {
  BookingIdReviewParams,
  ListPublicReviewsQuery,
  ReviewBusinessIdParams,
  ReviewWriteBody,
} from "./review.schema.js";
import type { ReviewService } from "./review.service.js";

/** Customer-facing (create/read-own/edit, mounted under `/me`) + public-facing (Business rating
 * summary/Reviews list, mounted under `/catalog`) Review endpoints — see review.route.ts for the
 * exact mounting. Both sides share the same `ReviewService`, never a second implementation. */
export class ReviewController {
  public constructor(private readonly reviewService: ReviewService) {}

  // --- Customer (own booking's review) --------------------------------------------------------

  public getStateForBooking = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdReviewParams;

    const state = await this.reviewService.getReviewState(userId, params.bookingId);

    sendSuccess(response, 200, "Review state", {
      eligible: state.eligible,
      review: state.review ? toCustomerReviewDto(state.review) : null,
    });
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdReviewParams;
    const body = request.validated?.body as ReviewWriteBody;

    const review = await this.reviewService.createFromBooking(userId, params.bookingId, {
      rating: body.rating,
      comment: body.comment,
    });

    sendSuccess(response, 201, "Review submitted", toCustomerReviewDto(review));
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdReviewParams;
    const body = request.validated?.body as ReviewWriteBody;

    const review = await this.reviewService.updateOwnReview(userId, params.bookingId, {
      rating: body.rating,
      comment: body.comment,
    });

    sendSuccess(response, 200, "Review updated", toCustomerReviewDto(review));
  };

  // --- Public (Business rating summary + Reviews list) ----------------------------------------

  public getBusinessRatingSummary = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as ReviewBusinessIdParams;

    const summary = await this.reviewService.getBusinessRatingSummary(params.businessId);

    sendSuccess(response, 200, "Business rating summary", {
      businessId: params.businessId,
      averageRating: summary.averageRating,
      reviewCount: summary.reviewCount,
    });
  };

  public listBusinessReviews = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as ReviewBusinessIdParams;
    const query = request.validated?.query as ListPublicReviewsQuery;

    const result = await this.reviewService.listBusinessReviews(params.businessId, {
      page: query.page,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Business reviews", {
      reviews: result.reviews.map(toPublicReviewDto),
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  private requireCustomerId(request: Request): string {
    const userId = request.auth?.userId;
    const role = request.auth?.role;

    if (!userId || role !== "CUSTOMER") {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return userId;
  }
}
