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
import { BusinessPayoutRepository } from "../finance/business-payout.repository.js";
import { FinanceService } from "../finance/finance.service.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { DashboardOverviewController } from "./dashboard-overview.controller.js";
import { dashboardOverviewParamsSchema } from "./dashboard-overview.schema.js";
import { DashboardOverviewService } from "./dashboard-overview.service.js";

/**
 * Business dashboard "Overview" screen's real backend — Owner/Supervisor (full) and Staff
 * (scoped-down, own bookings only). Applies auth per-route (not a blanket gate) exactly like
 * createClientRoute/createAvailabilityRoute/createBusinessBookingRoute, so it MUST be mounted
 * before business.route.ts's router-wide `requireRoles(["BUSINESS_OWNER"])` gate — otherwise
 * SUPERVISOR/STAFF would 403 before ever reaching DashboardOverviewService's own scoping (see
 * api-router.ts's own comment on this exact ordering requirement for its siblings).
 */
export const createDashboardOverviewRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const businessRepository = new BusinessRepository();
  const staffRepository = new StaffRepository();
  const bookingRepository = new BookingRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const financeService = new FinanceService(
    businessRepository,
    financialTransactionService,
    bookingRepository,
    new BusinessPayoutRepository(),
  );

  const service = new DashboardOverviewService(
    businessRepository,
    staffRepository,
    bookingRepository,
    financialTransactionService,
    financeService,
  );
  const controller = new DashboardOverviewController(service);

  router.get(
    "/:businessId/dashboard/overview",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR", "STAFF"]),
    validateRequest({ params: dashboardOverviewParamsSchema }),
    asyncHandler(controller.getOverview),
  );

  return router;
};
