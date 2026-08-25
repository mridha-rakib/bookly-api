import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { SuperAdminDashboardService } from "./super-admin-dashboard.service.js";

export class SuperAdminDashboardController {
  public constructor(private readonly service: SuperAdminDashboardService) {}

  public getSummary = async (_request: Request, response: Response): Promise<void> => {
    const summary = await this.service.getSummary();
    sendSuccess(response, 200, "Dashboard summary", summary);
  };
}
