import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import type { PlatformReportingScopeResolver } from "./platform-reporting-scope.resolver.js";
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
    private readonly scopeResolver: PlatformReportingScopeResolver,
  ) {}

  public getBookingAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const { scope, filters } = await this.scopeResolver.resolve(query);
    const result = await this.bookingAnalyticsService.getAnalytics(query, scope);
    sendSuccess(response, 200, "Booking analytics", { ...result, filters });
  };

  public getBusinessAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const { scope, filters } = await this.scopeResolver.resolve(query);
    const result = await this.businessAnalyticsService.getAnalytics(query, scope);
    sendSuccess(response, 200, "Business analytics", { ...result, filters });
  };

  /** Customer analytics are platform-wide User facts (registration, all-time activity) with no
   * Business-city attribution: City/Day are validated but not applied, and reported as such. */
  public getCustomerAnalytics = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminAnalyticsPeriodQuery;
    const { filters } = await this.scopeResolver.resolve(query);
    const result = await this.customerAnalyticsService.getAnalytics(query);
    sendSuccess(response, 200, "Customer analytics", {
      ...result,
      filters,
      scope: "PLATFORM_WIDE_NOT_CITY_OR_DAY_FILTERED",
    });
  };

  public getTopServices = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminTopServicesQuery;
    const { scope, filters } = await this.scopeResolver.resolve(query);
    const result = await this.serviceAnalyticsService.getTopServices(query, scope);
    sendSuccess(response, 200, "Top services", { ...result, filters });
  };

  /** P2.2.4 — City options: distinct registered Business cities (names only). */
  public listReportingCities = async (_request: Request, response: Response): Promise<void> => {
    const cities = await this.scopeResolver.listCities();
    sendSuccess(response, 200, "Reporting cities", { cities });
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
