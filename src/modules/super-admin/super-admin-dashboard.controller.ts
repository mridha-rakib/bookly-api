import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import type { ReportingDay } from "../../common/reporting/platform-reporting-scope.js";
import type { PlatformReportingScopeResolver } from "./platform-reporting-scope.resolver.js";
import type { SuperAdminDashboardService } from "./super-admin-dashboard.service.js";

export class SuperAdminDashboardController {
  public constructor(
    private readonly service: SuperAdminDashboardService,
    private readonly scopeResolver: PlatformReportingScopeResolver,
  ) {}

  public getSummary = async (request: Request, response: Response): Promise<void> => {
    const query = (request.validated?.query ?? {}) as {
      fromDate?: Date | undefined;
      toDate?: Date | undefined;
      city?: string | undefined;
      day?: ReportingDay | undefined;
    };
    const { scope, filters } = await this.scopeResolver.resolve(query);
    const summary = await this.service.getSummary(query, scope, filters);
    sendSuccess(response, 200, "Dashboard summary", summary);
  };
}
