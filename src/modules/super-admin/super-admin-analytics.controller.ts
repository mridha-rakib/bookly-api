import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type {
  SuperAdminAnalyticsPeriodQuery,
  SuperAdminRecentActivityQuery,
  SuperAdminTopServicesQuery,
} from "./super-admin.schema.js";
import type { SuperAdminActivityService } from "./super-admin-activity.service.js";
import type { SuperAdminBookingAnalyticsService } from "./super-admin-booking-analytics.service.js";
import type { SuperAdminBusinessAnalyticsService } from "./super-admin-business-analytics.service.js";
import type { SuperAdminCityAnalyticsService } from "./super-admin-city-analytics.service.js";
import type { SuperAdminCustomerAnalyticsService } from "./super-admin-customer-analytics.service.js";
import type { SuperAdminServiceAnalyticsService } from "./super-admin-service-analytics.service.js";

/** Mounted under `/super-admin`, gated end-to-end by `requireRoles(["SUPER_ADMIN"])` — same
 * router-wide-gate precedent as every other Super Admin controller. Every method here is a thin
 * pass-through; all real aggregation happens in the individual analytics services. */
export class SuperAdminAnalyticsController {
  public constructor(
    private readonly bookingAnalyticsService: SuperAdminBookingAnalyticsService,
    private readonly businessAnalyticsService: SuperAdminBusinessAnalyticsService,
    private readonly customerAnalyticsService: SuperAdminCustomerAnalyticsService,
    private readonly serviceAnalyticsService: SuperAdminServiceAnalyticsService,
    private readonly cityAnalyticsService: SuperAdminCityAnalyticsService,
    private readonly activityService: SuperAdminActivityService,
  ) {}

  public getBookingAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const result = await this.bookingAnalyticsService.getAnalytics(query);
    sendSuccess(response, 200, "Booking analytics", result);
  };

  public getBusinessAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const result = await this.businessAnalyticsService.getAnalytics(query);
    sendSuccess(response, 200, "Business analytics", result);
  };

  public getCustomerAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const result = await this.customerAnalyticsService.getAnalytics(query);
    sendSuccess(response, 200, "Customer analytics", result);
  };

  public getTopServices = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminTopServicesQuery;
    const result = await this.serviceAnalyticsService.getTopServices(query);
    sendSuccess(response, 200, "Top services", result);
  };

  public getCityCoverage = async (_request: Request, response: Response): Promise<void> => {
    const result = await this.cityAnalyticsService.getCityCoverage();
    sendSuccess(response, 200, "City coverage", result);
  };

  public getRecentActivity = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminRecentActivityQuery;
    const result = await this.activityService.getRecentActivity(query.limit);
    sendSuccess(response, 200, "Recent activity", result);
  };
}
