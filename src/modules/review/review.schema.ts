import { z } from "zod";
import {
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_RATING_MAX,
  REVIEW_RATING_MIN,
  reviewModerationActions,
  reviewModerationStatuses,
} from "./review.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const bookingIdReviewParamsSchema = z.object({ bookingId: objectIdSchema }).strict();
export const reviewIdParamsSchema = z.object({ reviewId: objectIdSchema }).strict();
export const businessIdParamsSchema = z.object({ businessId: objectIdSchema }).strict();

// Confirmed rule 1.5/1.6 — integer 1-5 only (no 0/6/decimals/half-stars); comment optional,
// bounded, no title/photos/category ratings. Never accepts businessId/customerUserId/status —
// those are always server-derived from the resolved, owned Booking (confirmed rule 4).
export const reviewWriteBodySchema = z
  .object({
    rating: z.number().int().min(REVIEW_RATING_MIN).max(REVIEW_RATING_MAX),
    comment: z.string().trim().max(REVIEW_COMMENT_MAX_LENGTH).optional(),
  })
  .strict();

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

export const listPublicReviewsQuerySchema = paginationQuerySchema.strict().transform((value) => ({
  page: value.page ? Math.max(1, Number(value.page)) : 1,
  limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 10,
}));

export const listModerationReviewsQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(reviewModerationStatuses).optional(),
    businessId: objectIdSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    businessId: value.businessId,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export const moderateReviewBodySchema = z
  .object({ action: z.enum(reviewModerationActions) })
  .strict();

export type BookingIdReviewParams = z.infer<typeof bookingIdReviewParamsSchema>;
export type ReviewIdParams = z.infer<typeof reviewIdParamsSchema>;
export type ReviewBusinessIdParams = z.infer<typeof businessIdParamsSchema>;
export type ReviewWriteBody = z.infer<typeof reviewWriteBodySchema>;
export type ListPublicReviewsQuery = z.infer<typeof listPublicReviewsQuerySchema>;
export type ListModerationReviewsQuery = z.infer<typeof listModerationReviewsQuerySchema>;
export type ModerateReviewBody = z.infer<typeof moderateReviewBodySchema>;
