import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import { toDashboardAnalyticsDto } from "./dashboard-analytics.dto.js";
import type {
  DashboardAnalyticsParams,
  DashboardAnalyticsQuery,
} from "./dashboard-analytics.schema.js";
import type { DashboardAnalyticsService } from "./dashboard-analytics.service.js";

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate (see dashboard-analytics.route.ts's own comment) — every request reaching here already
 * carries a BUSINESS_OWNER actor; DashboardAnalyticsService.requireOwnedBusiness still
 * independently verifies that Owner actually owns THIS businessId (defense in depth, matching
 * FinanceController's exact precedent).
 */
export class DashboardAnalyticsController {
  public constructor(private readonly dashboardAnalyticsService: DashboardAnalyticsService) {}

  public getAnalytics = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as DashboardAnalyticsParams;
    const query = request.validated?.query as DashboardAnalyticsQuery;

    const analytics = await this.dashboardAnalyticsService.getAnalytics(
      userId,
      params.businessId,
      query.period,
    );

    sendSuccess(response, 200, "Dashboard analytics", toDashboardAnalyticsDto(analytics));
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
