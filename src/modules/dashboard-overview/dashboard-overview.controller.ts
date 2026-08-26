import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { UserRole } from "../user/user.types.js";
import { toDashboardOverviewDto } from "./dashboard-overview.dto.js";
import type { DashboardOverviewParams } from "./dashboard-overview.schema.js";
import type { DashboardOverviewService } from "./dashboard-overview.service.js";

export class DashboardOverviewController {
  public constructor(private readonly dashboardOverviewService: DashboardOverviewService) {}

  public getOverview = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as DashboardOverviewParams;

    const overview = await this.dashboardOverviewService.getOverview(
      userId,
      role,
      params.businessId,
    );

    sendSuccess(response, 200, "Dashboard overview", toDashboardOverviewDto(overview));
  };

  private requireBusinessActor(request: Request): { userId: string; role: UserRole } {
    const userId = request.auth?.userId;
    const role = request.auth?.role;

    if (!userId || (role !== "BUSINESS_OWNER" && role !== "SUPERVISOR" && role !== "STAFF")) {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return { userId, role };
  }
}
