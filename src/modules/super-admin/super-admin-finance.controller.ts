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
import type { PayoutDestinationService } from "../payout-destination/payout-destination.service.js";

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
    private readonly payoutDestinationService: PayoutDestinationService,
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

  /** Masked read — identical shape/builder to the Business Owner's own read. A Super Admin sees
   * no more than the Owner does here; full details require the explicit reveal below. */
  public getBusinessPayoutDestination = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const params = request.validated?.params as FinanceBusinessParams;
    const view = await this.payoutDestinationService.getForSuperAdmin(params.businessId);
    sendSuccess(response, 200, "Business payout destination", view);
  };

  /**
   * The one endpoint in the application that returns a decrypted IBAN — for payout purposes
   * only. SUPER_ADMIN-gated by the router, rate-limited at the route (see
   * super-admin.route.ts), and audited by the service with an `IBAN_REVEALED` history entry
   * recording actor + timestamp and no IBAN. The response body is deliberately never logged
   * anywhere, here or in the service.
   */
  public revealBusinessPayoutDestination = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as FinanceBusinessParams;

    const revealed = await this.payoutDestinationService.revealIbanForSuperAdmin(
      userId,
      params.businessId,
    );

    sendSuccess(response, 200, "Payout destination revealed", revealed);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
