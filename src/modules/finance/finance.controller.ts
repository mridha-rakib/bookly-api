import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import { ProviderReversalQueryService } from "../provider-reversal/provider-reversal.query.js";
import type { BusinessReversalListQuery } from "../provider-reversal/provider-reversal.schema.js";
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
  public constructor(
    private readonly financeService: FinanceService,
    // P6 — the Business's own view of provider reversals it bears (optional trailing dep).
    private readonly reversalQuery?: ProviderReversalQueryService,
  ) {}

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

  /** P6 — disputes on this Business's own (Business-borne) principal; no investigation internals,
   * no dispute evidence (that stays in the Stripe Dashboard). */
  public listDisputes = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as BusinessReversalListQuery;
    const businessId = await this.financeService.requireOwnedFinanceBusinessId(
      userId,
      params.businessId,
    );
    const page = this.reversalQuery
      ? await this.reversalQuery.listDisputes({ ...query, businessId, economicOwner: "BUSINESS" })
      : { items: [], total: 0 };
    sendSuccess(response, 200, "Payment disputes", {
      disputes: page.items.map((item) => ProviderReversalQueryService.forBusiness(item)),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  /** P6 — refunds made outside Bookly that reduced this Business's payable. */
  public listExternalRefunds = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;
    const query = request.validated?.query as BusinessReversalListQuery;
    const businessId = await this.financeService.requireOwnedFinanceBusinessId(
      userId,
      params.businessId,
    );
    const page = this.reversalQuery
      ? await this.reversalQuery.listExternalRefunds({
          ...query,
          businessId,
          economicOwner: "BUSINESS",
          state: "ACCOUNTED",
        })
      : { items: [], total: 0 };
    sendSuccess(response, 200, "External refunds", {
      refunds: page.items.map((item) => ProviderReversalQueryService.forBusiness(item)),
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
