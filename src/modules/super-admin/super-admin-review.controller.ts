import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  ListModerationReviewsQuery,
  ModerateReviewBody,
  ReviewIdParams,
} from "../review/review.schema.js";
import type { SuperAdminReviewService } from "./super-admin-review.service.js";

/** Mounted under `/super-admin`, gated end-to-end by the router-wide `requireRoles(["SUPER_ADMIN"])`
 * gate (see super-admin.route.ts) — same precedent as every other Super Admin controller.
 * BUSINESS_OWNER/SUPERVISOR/STAFF/CUSTOMER are all rejected before ever reaching this class. */
export class SuperAdminReviewController {
  public constructor(private readonly service: SuperAdminReviewService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListModerationReviewsQuery;
    const result = await this.service.list(
      { status: query.status, businessId: query.businessId },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Reviews", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as ReviewIdParams;
    const review = await this.service.getById(params.reviewId);
    sendSuccess(response, 200, "Review", review);
  };

  public moderate = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as ReviewIdParams;
    const body = request.validated?.body as ModerateReviewBody;
    const actorUserId = this.requireActorId(request);

    const review = await this.service.moderate(params.reviewId, body.action, actorUserId);
    sendSuccess(response, 200, body.action === "HIDE" ? "Review hidden" : "Review removed", review);
  };

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
