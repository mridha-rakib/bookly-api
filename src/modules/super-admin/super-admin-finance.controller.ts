import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BusinessPayoutService } from "../finance/business-payout.service.js";
import {
  toBusinessPayableDto,
  toBusinessPayoutDto,
  toFinancePayoutHistoryItemDto,
  toFinanceSummaryDto,
  toFinanceTransactionRowDto,
  toPendingPayoutsDto,
  toPlatformPayoutHistoryItemDto,
  toPlatformSummaryDto,
  toPlatformTransactionRowDto,
} from "../finance/finance.dto.js";
import type {
  ExecutePayoutBody,
  FinanceBusinessParams,
  FinancePayoutHistoryQuery,
  FinanceSummaryQuery,
  FinanceTransactionsQuery,
  PlatformTransactionsQuery,
} from "../finance/finance.schema.js";
import type { FinanceService } from "../finance/finance.service.js";

/**
 * Mounted under `/super-admin`, gated end-to-end by `requireRoles(["SUPER_ADMIN"])` (see
 * super-admin.route.ts's own comment) — every method here reuses FinanceService/
 * BusinessPayoutService's SAME core computation as the Business Owner's own finance surface
 * (rule #17), just without the Owner-ownership check (the route-level role gate is the
 * authorization here, matching this codebase's `business.route.ts` precedent of a router-wide
 * gate rather than a per-method actor check).
 */
export class SuperAdminFinanceController {
  public constructor(
    private readonly financeService: FinanceService,
    private readonly businessPayoutService: BusinessPayoutService,
  ) {}

  public getPlatformSummary = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as FinanceSummaryQuery;
    const summary = await this.financeService.getPlatformSummary(query);
    sendSuccess(response, 200, "Platform finance summary", toPlatformSummaryDto(summary));
  };

  public listPlatformTransactions = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as PlatformTransactionsQuery;
    const page = await this.financeService.listPlatformTransactions(
      { from: query.from, to: query.to },
      { page: query.page, limit: query.limit },
      query.types,
    );
    sendSuccess(response, 200, "Platform transactions", {
      transactions: page.rows.map(toPlatformTransactionRowDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public listPendingPayouts = async (_request: Request, response: Response): Promise<void> => {
    const page = await this.financeService.listPendingPayouts();
    sendSuccess(response, 200, "Pending payouts", toPendingPayoutsDto(page));
  };

  public listPlatformPayoutHistory = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const query = request.validated?.query as FinancePayoutHistoryQuery;
    const page = await this.financeService.listPlatformPayoutHistory({
      page: query.page,
      limit: query.limit,
    });
    sendSuccess(response, 200, "Platform payout history", {
      payouts: page.items.map(toPlatformPayoutHistoryItemDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public getBusinessSummary = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinanceSummaryQuery;
    const summary = await this.financeService.getSummaryForSuperAdmin(params.businessId, query);
    sendSuccess(response, 200, "Business finance summary", toFinanceSummaryDto(summary));
  };

  public listBusinessTransactions = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinanceTransactionsQuery;
    const page = await this.financeService.listTransactionsForSuperAdmin(
      params.businessId,
      { from: query.from, to: query.to },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Business finance transactions", {
      transactions: page.rows.map(toFinanceTransactionRowDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public getBusinessPayable = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as FinanceBusinessParams;
    const payable = await this.financeService.getBusinessPayableForSuperAdmin(params.businessId);
    sendSuccess(response, 200, "Business payable balance", toBusinessPayableDto(payable));
  };

  public listBusinessPayoutHistory = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as FinancePayoutHistoryQuery;
    const page = await this.financeService.listPayoutHistoryForSuperAdmin(params.businessId, {
      page: query.page,
      limit: query.limit,
    });
    sendSuccess(response, 200, "Business payout history", {
      payouts: page.items.map(toFinancePayoutHistoryItemDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  /** "Send SEPA" / "Confirm Transfer" — the Super Admin's one-step, self-attested payout
   * action (see business-payout.model.ts's own doc comment on this confirmed product
   * decision). */
  public executePayout = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const body = request.validated?.body as ExecutePayoutBody;

    const payout = await this.businessPayoutService.executePayout(userId, params.businessId, {
      providerReference: body.providerReference,
    });

    sendSuccess(response, 201, "Payout recorded", toBusinessPayoutDto(payout));
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
