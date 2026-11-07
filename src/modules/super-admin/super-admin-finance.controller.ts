import type { Request, Response } from "express";

import { streamCsv } from "../../common/http/csv.js";
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
  PlatformTransactionsExportQuery,
  PlatformTransactionsQuery,
} from "../finance/finance.schema.js";
import type { FinanceService } from "../finance/finance.service.js";
import type { PayoutDestinationService } from "../payout-destination/payout-destination.service.js";

const EXPORT_PAGE_SIZE = 100;

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

  // --- P1.9 CSV exports ------------------------------------------------------------------------
  // Super Admin-only (router-wide SUPER_ADMIN gate). Complete filtered exports streamed through
  // the shared encoder in bounded 100-row server pages — never the browser's loaded page.
  // Amounts are integer cents with an explicit currency column; timestamps are ISO 8601 UTC.

  public exportPlatformTransactions = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const query = request.validated?.query as PlatformTransactionsExportQuery;
    await streamCsv(
      response,
      "platform-transactions.csv",
      [
        "TRANSACTION ID",
        "DATE",
        "BUSINESS ID",
        "BUSINESS",
        "BOOKING ID",
        "BOOKING REFERENCE",
        "CUSTOMER",
        "TYPE",
        "REFUND ORIGIN",
        "OWNER",
        "GROSS CENTS",
        "PROCESSING FEE CENTS",
        "NET CENTS",
        "CURRENCY",
        "STATUS",
        "PAYOUT ID",
      ],
      (page) =>
        this.financeService.listPlatformTransactions(
          { from: query.from, to: query.to },
          { page, limit: EXPORT_PAGE_SIZE },
          query.types,
        ),
      (row) => {
        const dto = toPlatformTransactionRowDto(row);
        return [
          dto.id,
          dto.date,
          dto.businessId,
          dto.businessName,
          dto.bookingId,
          dto.bookingReference,
          dto.customerName,
          dto.type,
          dto.refundOrigin,
          dto.owner,
          dto.grossCents,
          dto.stripeFeeCents,
          dto.netCents,
          dto.currency,
          dto.status,
          dto.payoutId,
        ];
      },
    );
  };

  public exportPlatformPayouts = async (_request: Request, response: Response): Promise<void> => {
    await streamCsv(
      response,
      "platform-payouts.csv",
      [
        "PAYOUT ID",
        "BUSINESS ID",
        "BUSINESS",
        "PERIOD START",
        "PERIOD END",
        "GROSS BUSINESS-OWNED CENTS",
        "PROCESSING FEES CENTS",
        "DISPUTE ADJUSTMENTS CENTS",
        "NET PAYOUT CENTS",
        "CURRENCY",
        "STATUS",
        "PAID AT",
        "PROVIDER REFERENCE",
      ],
      async (page) => {
        const result = await this.financeService.listPlatformPayoutHistory({
          page,
          limit: EXPORT_PAGE_SIZE,
        });
        return { rows: result.items, total: result.total };
      },
      (row) => {
        const dto = toPlatformPayoutHistoryItemDto(row);
        return [
          dto.id,
          dto.businessId,
          dto.businessName,
          dto.periodStart,
          dto.periodEnd,
          dto.grossBusinessOwnedCents,
          dto.processingFeesCents,
          dto.disputeAdjustmentsCents,
          dto.netPayoutCents,
          dto.currency,
          dto.status,
          dto.paidAt,
          dto.providerReference,
        ];
      },
    );
  };

  /** The pending list is already one complete server read (every Business with an unclaimed
   * balance); exported whole, stamped with the instant it was computed. */
  public exportPendingPayouts = async (_request: Request, response: Response): Promise<void> => {
    const asOf = new Date().toISOString();
    await streamCsv(
      response,
      "pending-payouts.csv",
      [
        "BUSINESS ID",
        "BUSINESS",
        "CITY",
        "CATEGORY",
        "TRANSACTIONS",
        "NO-SHOW CENTS",
        "LATE CANCEL CENTS",
        "DEPOSIT CENTS",
        "GROSS CENTS",
        "PROCESSING FEES CENTS",
        "REFUNDS CENTS",
        "DISPUTE ADJUSTMENTS CENTS",
        "NET CENTS",
        "CURRENCY",
        "AS OF",
      ],
      async (page) => {
        if (page > 1) return { rows: [], total: 0 };
        const pending = await this.financeService.listPendingPayouts();
        return { rows: pending.items, total: pending.items.length };
      },
      (row) => [
        row.businessId,
        row.businessName,
        row.city,
        row.category,
        row.transactionCount,
        row.noShowAmountCents,
        row.cancellationAmountCents,
        row.depositAmountCents,
        row.grossCents,
        row.processingFeesCents,
        row.refundsCents,
        row.disputeAdjustmentsCents,
        row.netCents,
        "EUR",
        asOf,
      ],
    );
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
