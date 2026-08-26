import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { DashboardAnalyticsController } from "./dashboard-analytics.controller.js";
import {
  dashboardAnalyticsParamsSchema,
  dashboardAnalyticsQuerySchema,
} from "./dashboard-analytics.schema.js";
import { DashboardAnalyticsService } from "./dashboard-analytics.service.js";

/**
 * Business dashboard "Analytics" tab's real backend — Business Owner ONLY (matches
 * DashboardAnalytics.tsx's own reachability: it renders only inside `RequireBusinessOwner` on
 * `/business-dashboard`, no Supervisor/Staff route reaches it — unlike Dashboard Overview, which
 * intentionally serves all three). Mounted exactly like createFinanceRoute() — INSIDE
 * business.route.ts, underneath its router-wide `requireRoles(["BUSINESS_OWNER"])` gate (see
 * that file's own comment) — never as its own top-level router with per-route auth, since there
 * is no narrower-than-Owner surface here to carve out.
 */
export const createDashboardAnalyticsRoute = (): Router => {
  const router = Router({ mergeParams: true });

  const businessRepository = new BusinessRepository();
  const bookingRepository = new BookingRepository();
  const clientRepository = new ClientRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );

  const service = new DashboardAnalyticsService(
    businessRepository,
    bookingRepository,
    clientRepository,
    financialTransactionService,
  );
  const controller = new DashboardAnalyticsController(service);

  router.get(
    "/:businessId/dashboard/analytics",
    validateRequest({
      params: dashboardAnalyticsParamsSchema,
      query: dashboardAnalyticsQuerySchema,
    }),
    asyncHandler(controller.getAnalytics),
  );

  return router;
};
