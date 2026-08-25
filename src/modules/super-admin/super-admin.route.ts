import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessLifecycleService } from "../business/business-lifecycle.service.js";
import { ClientRepository } from "../client/client.repository.js";
import { BusinessPayoutRepository } from "../finance/business-payout.repository.js";
import { BusinessPayoutService } from "../finance/business-payout.service.js";
import {
  executePayoutBodySchema,
  financeBusinessParamsSchema,
  financePayoutHistoryQuerySchema,
  financeSummaryQuerySchema,
  financeTransactionsQuerySchema,
  platformTransactionsQuerySchema,
} from "../finance/finance.schema.js";
import { FinanceService } from "../finance/finance.service.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import {
  superAdminAnalyticsPeriodQuerySchema,
  superAdminBookingIdParamsSchema,
  superAdminBusinessIdParamsSchema,
  superAdminListBookingsQuerySchema,
  superAdminListBusinessesQuerySchema,
  superAdminListCustomersQuerySchema,
  superAdminRecentActivityQuerySchema,
  superAdminRejectBusinessBodySchema,
  superAdminSuspendBusinessBodySchema,
  superAdminTopServicesQuerySchema,
  superAdminUserIdParamsSchema,
} from "./super-admin.schema.js";
import { SuperAdminActivityService } from "./super-admin-activity.service.js";
import { SuperAdminAnalyticsController } from "./super-admin-analytics.controller.js";
import { SuperAdminBookingController } from "./super-admin-booking.controller.js";
import { SuperAdminBookingService } from "./super-admin-booking.service.js";
import { SuperAdminBookingAnalyticsService } from "./super-admin-booking-analytics.service.js";
import { SuperAdminBusinessController } from "./super-admin-business.controller.js";
import { SuperAdminBusinessService } from "./super-admin-business.service.js";
import { SuperAdminBusinessAnalyticsService } from "./super-admin-business-analytics.service.js";
import { SuperAdminCityAnalyticsService } from "./super-admin-city-analytics.service.js";
import { SuperAdminCustomerController } from "./super-admin-customer.controller.js";
import { SuperAdminCustomerService } from "./super-admin-customer.service.js";
import { SuperAdminCustomerAnalyticsService } from "./super-admin-customer-analytics.service.js";
import { SuperAdminDashboardController } from "./super-admin-dashboard.controller.js";
import { SuperAdminDashboardService } from "./super-admin-dashboard.service.js";
import { SuperAdminFinanceController } from "./super-admin-finance.controller.js";
import { SuperAdminServiceAnalyticsService } from "./super-admin-service-analytics.service.js";

/**
 * Batch 8 — the first real Super Admin backend surface in this codebase (confirmed by
 * investigation: previously zero SUPER_ADMIN-gated routes existed anywhere, and
 * requireApprovedBusiness's own doc comment independently notes "a Super Admin route today has
 * zero business-management endpoints"). Every route here is SUPER_ADMIN-only, end to end, via
 * the same router-wide-gate pattern business.route.ts already established for
 * BUSINESS_OWNER-only surfaces — never a per-route role check.
 */
export const createSuperAdminRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const businessRepository = new BusinessRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const bookingRepository = new BookingRepository();
  const businessPayoutRepository = new BusinessPayoutRepository();

  const financeService = new FinanceService(
    businessRepository,
    financialTransactionService,
    bookingRepository,
    businessPayoutRepository,
  );
  const businessPayoutService = new BusinessPayoutService(
    businessRepository,
    financialTransactionService,
    businessPayoutRepository,
  );
  const controller = new SuperAdminFinanceController(financeService, businessPayoutService);

  const businessLifecycleService = new BusinessLifecycleService(businessRepository);
  const businessController = new SuperAdminBusinessController(
    new SuperAdminBusinessService(
      businessRepository,
      bookingRepository,
      userRepository,
      businessLifecycleService,
    ),
  );
  const bookingController = new SuperAdminBookingController(
    new SuperAdminBookingService(bookingRepository, businessRepository),
  );
  const customerController = new SuperAdminCustomerController(
    new SuperAdminCustomerService(userRepository, bookingRepository),
  );
  const dashboardController = new SuperAdminDashboardController(
    new SuperAdminDashboardService(
      businessRepository,
      userRepository,
      bookingRepository,
      financialTransactionService,
      financeService,
      businessPayoutRepository,
    ),
  );

  const clientRepository = new ClientRepository();
  const analyticsController = new SuperAdminAnalyticsController(
    new SuperAdminBookingAnalyticsService(bookingRepository, financialTransactionService),
    new SuperAdminBusinessAnalyticsService(
      businessRepository,
      bookingRepository,
      clientRepository,
      financialTransactionService,
    ),
    new SuperAdminCustomerAnalyticsService(userRepository, bookingRepository),
    new SuperAdminServiceAnalyticsService(bookingRepository, businessRepository),
    new SuperAdminCityAnalyticsService(businessRepository),
    new SuperAdminActivityService(businessRepository, userRepository, businessPayoutRepository),
  );

  router.use(authenticate, requireActiveUser(), requireRoles(["SUPER_ADMIN"]));

  // --- Businesses ---
  router.get(
    "/businesses",
    validateRequest({ query: superAdminListBusinessesQuerySchema }),
    asyncHandler(businessController.list),
  );
  router.get(
    "/businesses/:businessId",
    validateRequest({ params: superAdminBusinessIdParamsSchema }),
    asyncHandler(businessController.getById),
  );
  router.post(
    "/businesses/:businessId/approve",
    validateRequest({ params: superAdminBusinessIdParamsSchema }),
    asyncHandler(businessController.approve),
  );
  router.post(
    "/businesses/:businessId/reject",
    validateRequest({
      params: superAdminBusinessIdParamsSchema,
      body: superAdminRejectBusinessBodySchema,
    }),
    asyncHandler(businessController.reject),
  );
  router.post(
    "/businesses/:businessId/suspend",
    validateRequest({
      params: superAdminBusinessIdParamsSchema,
      body: superAdminSuspendBusinessBodySchema,
    }),
    asyncHandler(businessController.suspend),
  );

  // --- Global Bookings ---
  router.get(
    "/bookings",
    validateRequest({ query: superAdminListBookingsQuerySchema }),
    asyncHandler(bookingController.list),
  );
  router.get(
    "/bookings/:bookingId",
    validateRequest({ params: superAdminBookingIdParamsSchema }),
    asyncHandler(bookingController.getById),
  );

  // --- Global Customers ---
  router.get(
    "/customers",
    validateRequest({ query: superAdminListCustomersQuerySchema }),
    asyncHandler(customerController.list),
  );
  router.get(
    "/customers/:userId",
    validateRequest({ params: superAdminUserIdParamsSchema }),
    asyncHandler(customerController.getById),
  );

  // --- Dashboard ---
  router.get("/dashboard/summary", asyncHandler(dashboardController.getSummary));

  // --- Analytics ---
  router.get(
    "/analytics/bookings",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getBookingAnalytics),
  );
  router.get(
    "/analytics/businesses",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getBusinessAnalytics),
  );
  router.get(
    "/analytics/customers",
    validateRequest({ query: superAdminAnalyticsPeriodQuerySchema }),
    asyncHandler(analyticsController.getCustomerAnalytics),
  );
  router.get(
    "/analytics/top-services",
    validateRequest({ query: superAdminTopServicesQuerySchema }),
    asyncHandler(analyticsController.getTopServices),
  );
  router.get("/analytics/cities", asyncHandler(analyticsController.getCityCoverage));
  router.get(
    "/analytics/recent-activity",
    validateRequest({ query: superAdminRecentActivityQuerySchema }),
    asyncHandler(analyticsController.getRecentActivity),
  );

  // --- Platform-wide ---
  router.get(
    "/finance/summary",
    validateRequest({ query: financeSummaryQuerySchema }),
    asyncHandler(controller.getPlatformSummary),
  );
  router.get(
    "/finance/transactions",
    validateRequest({ query: platformTransactionsQuerySchema }),
    asyncHandler(controller.listPlatformTransactions),
  );
  router.get("/finance/pending-payouts", asyncHandler(controller.listPendingPayouts));
  router.get(
    "/finance/payouts",
    validateRequest({ query: financePayoutHistoryQuerySchema }),
    asyncHandler(controller.listPlatformPayoutHistory),
  );

  // --- Per-Business (Business Detail Finance tab) ---
  router.get(
    "/businesses/:businessId/finance/summary",
    validateRequest({ params: financeBusinessParamsSchema, query: financeSummaryQuerySchema }),
    asyncHandler(controller.getBusinessSummary),
  );
  router.get(
    "/businesses/:businessId/finance/transactions",
    validateRequest({ params: financeBusinessParamsSchema, query: financeTransactionsQuerySchema }),
    asyncHandler(controller.listBusinessTransactions),
  );
  router.get(
    "/businesses/:businessId/finance/payable",
    validateRequest({ params: financeBusinessParamsSchema }),
    asyncHandler(controller.getBusinessPayable),
  );
  router.get(
    "/businesses/:businessId/finance/payouts",
    validateRequest({
      params: financeBusinessParamsSchema,
      query: financePayoutHistoryQuerySchema,
    }),
    asyncHandler(controller.listBusinessPayoutHistory),
  );
  router.post(
    "/businesses/:businessId/finance/payouts",
    validateRequest({ params: financeBusinessParamsSchema, body: executePayoutBodySchema }),
    asyncHandler(controller.executePayout),
  );

  return router;
};
