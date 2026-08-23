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
import { SuperAdminFinanceController } from "./super-admin-finance.controller.js";

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

  router.use(authenticate, requireActiveUser(), requireRoles(["SUPER_ADMIN"]));

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
