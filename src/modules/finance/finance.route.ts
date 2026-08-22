import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessPayoutRepository } from "./business-payout.repository.js";
import { FinanceController } from "./finance.controller.js";
import {
  financeBusinessParamsSchema,
  financePayoutHistoryQuerySchema,
  financeSummaryQuerySchema,
  financeTransactionsQuerySchema,
} from "./finance.schema.js";
import { FinanceService } from "./finance.service.js";

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate (Batch 7, Section 28) — Finance is deliberately narrower than Booking management, which
 * allows Owner + Supervisor. There is no product rule authorizing SUPERVISOR/STAFF/CUSTOMER
 * access to Business Finance in this phase, matching the exact precedent business.route.ts
 * already set for Business Profile/Staff/Travel-Settings/Cancellation-Policy (see that file's
 * own comment). FinanceService.requireOwnedFinanceBusiness additionally verifies the actor
 * actually OWNS the requested businessId (never a linked/secondary BusinessAccess grant).
 */
export const createFinanceRoute = (): Router => {
  const router = Router({ mergeParams: true });

  const businessRepository = new BusinessRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const bookingRepository = new BookingRepository();
  const businessPayoutRepository = new BusinessPayoutRepository();

  const service = new FinanceService(
    businessRepository,
    financialTransactionService,
    bookingRepository,
    businessPayoutRepository,
  );
  const controller = new FinanceController(service);

  router.get(
    "/:businessId/finance/summary",
    validateRequest({ params: financeBusinessParamsSchema, query: financeSummaryQuerySchema }),
    asyncHandler(controller.getSummary),
  );
  router.get(
    "/:businessId/finance/transactions",
    validateRequest({ params: financeBusinessParamsSchema, query: financeTransactionsQuerySchema }),
    asyncHandler(controller.listTransactions),
  );
  router.get(
    "/:businessId/finance/payouts",
    validateRequest({
      params: financeBusinessParamsSchema,
      query: financePayoutHistoryQuerySchema,
    }),
    asyncHandler(controller.listPayoutHistory),
  );

  return router;
};
