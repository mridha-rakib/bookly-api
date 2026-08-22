import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import {
  toFinancePayoutHistoryItemDto,
  toFinanceSummaryDto,
  toFinanceTransactionRowDto,
} from "./finance.dto.js";
import type {
  FinanceBusinessParams,
  FinancePayoutHistoryQuery,
  FinanceSummaryQuery,
  FinanceTransactionsQuery,
} from "./finance.schema.js";
import type { FinanceService } from "./finance.service.js";

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate (see finance.route.ts's own comment) — every request reaching here already carries a
 * BUSINESS_OWNER actor; FinanceService.requireOwnedFinanceBusiness still independently verifies
 * that Owner actually owns THIS businessId (defense in depth, matching StaffService).
 */
export class FinanceController {
  public constructor(private readonly financeService: FinanceService) {}

  public getSummary = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinanceSummaryQuery;

    const summary = await this.financeService.getSummary(userId, params.businessId, {
      from: query.from,
      to: query.to,
    });

    sendSuccess(response, 200, "Finance summary", toFinanceSummaryDto(summary));
  };

  public listTransactions = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinanceTransactionsQuery;

    const page = await this.financeService.listTransactions(
      userId,
      params.businessId,
      { from: query.from, to: query.to },
      { page: query.page, limit: query.limit },
    );

    sendSuccess(response, 200, "Finance transactions", {
      transactions: page.rows.map(toFinanceTransactionRowDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public listPayoutHistory = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinancePayoutHistoryQuery;

    const page = await this.financeService.listPayoutHistory(userId, params.businessId, {
      page: query.page,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Payout history", {
      payouts: page.items.map(toFinancePayoutHistoryItemDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
