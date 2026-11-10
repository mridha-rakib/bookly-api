import { Writable } from "node:stream";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingFinancialTransactionModel } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { toPlatformSummaryDto } from "../../src/modules/finance/finance.dto.js";
import {
  financeSummaryQuerySchema,
  platformTransactionsExportQuerySchema,
  platformTransactionsQuerySchema,
  superAdminFinanceSummaryQuerySchema,
} from "../../src/modules/finance/finance.schema.js";
import { FinanceService } from "../../src/modules/finance/finance.service.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { superAdminAnalyticsPeriodQuerySchema } from "../../src/modules/super-admin/super-admin.schema.js";
import { SuperAdminFinanceController } from "../../src/modules/super-admin/super-admin-finance.controller.js";

afterEach(() => vi.restoreAllMocks());

/** Inclusive Cyprus dates -> the `[from, to)` UTC window Super Admin Finance queries. */
const window = (from: string, to: string) => {
  const parsed = superAdminFinanceSummaryQuerySchema.parse({ from, to });
  return [parsed.from.toISOString(), parsed.to.toISOString()];
};
const hours = (from: string, to: string) => {
  const parsed = superAdminFinanceSummaryQuerySchema.parse({ from, to });
  return (parsed.to.getTime() - parsed.from.getTime()) / 3_600_000;
};

describe("E17 — Super Admin Finance Cyprus boundaries", () => {
  it("winter (UTC+2), summer (UTC+3) and both DST transition days", () => {
    expect(window("2026-01-15", "2026-01-15")).toEqual([
      "2026-01-14T22:00:00.000Z",
      "2026-01-15T22:00:00.000Z",
    ]);
    expect(window("2026-07-15", "2026-07-15")).toEqual([
      "2026-07-14T21:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
    ]);
    expect(hours("2026-03-29", "2026-03-29")).toBe(23);
    expect(hours("2026-10-25", "2026-10-25")).toBe(25);
  });

  it("month end and year end use an inclusive Cyprus end date (no 23:59:59.999 cut-off)", () => {
    expect(window("2026-11-01", "2026-11-30")).toEqual([
      "2026-10-31T22:00:00.000Z",
      "2026-11-30T22:00:00.000Z",
    ]);
    expect(window("2026-12-01", "2026-12-31")).toEqual([
      "2026-11-30T22:00:00.000Z",
      "2026-12-31T22:00:00.000Z",
    ]);
  });

  it("matches the Overview/Analytics boundaries for the same dates", () => {
    const analytics = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
    const finance = superAdminFinanceSummaryQuerySchema.parse({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect([finance.from, finance.to]).toEqual([analytics.fromDate, analytics.toDate]);
  });

  it("accepts 92 Cyprus calendar days across DST while rejecting a 93rd day", () => {
    // 92 days through the spring change (23-hour day) fits.
    expect(
      superAdminFinanceSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-02" })
        .success,
    ).toBe(true);
    // 92 days through autumn includes the extra hour and remains a valid calendar selection.
    expect(
      superAdminFinanceSummaryQuerySchema.safeParse({ from: "2026-09-01", to: "2026-12-01" })
        .success,
    ).toBe(true);
    expect(
      superAdminFinanceSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-03" })
        .success,
    ).toBe(false);
    expect(
      superAdminFinanceSummaryQuerySchema.safeParse({ from: "2026-02-10", to: "2026-02-01" })
        .success,
    ).toBe(false);
    // Exact instants (legacy form) are still accepted as given.
    expect(
      superAdminFinanceSummaryQuerySchema
        .parse({
          from: "2026-02-01T00:00:00.000Z",
          to: "2026-03-01T00:00:00.000Z",
        })
        .to.toISOString(),
    ).toBe("2026-03-01T00:00:00.000Z");
  });

  it("Business Owner / per-Business Finance schemas are unchanged (instants only)", () => {
    expect(
      financeSummaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-31" }).success,
    ).toBe(false);
    expect(
      financeSummaryQuerySchema
        .parse({ from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" })
        .from.toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("Transaction log: table/CSV parity and timestamp field", () => {
  const params = { from: "2026-10-01", to: "2026-10-31", types: "NO_SHOW_FEE,CANCELLATION_FEE" };

  it("the paginated table and the CSV export resolve the same window and types", async () => {
    const table = platformTransactionsQuerySchema.parse({ ...params, page: "2", limit: "20" });
    const csv = platformTransactionsExportQuerySchema.parse(params);
    expect([table.from, table.to, table.types]).toEqual([csv.from, csv.to, csv.types]);
    expect(table.from.toISOString()).toBe("2026-09-30T21:00:00.000Z"); // summer
    expect(table.to.toISOString()).toBe("2026-10-31T22:00:00.000Z"); // after fall-back

    const listPlatformTransactions = vi.fn(async () => ({ rows: [], total: 57 }));
    const controller = new SuperAdminFinanceController(
      { listPlatformTransactions } as never,
      {} as never,
      {} as never,
    );
    const json = vi.fn();
    await controller.listPlatformTransactions(
      { validated: { query: table } } as unknown as Request,
      { status: vi.fn().mockReturnThis(), json } as unknown as Response,
    );
    const sink = new Writable({ write: (_c, _e, done) => done() });
    Object.assign(sink, { setHeader: vi.fn() });
    await controller.exportPlatformTransactions(
      { validated: { query: csv } } as unknown as Request,
      sink as unknown as Response,
    );
    const [tableCall, csvCall] = listPlatformTransactions.mock.calls as unknown as Array<
      [unknown, { page: number; limit: number }, unknown]
    >;
    expect(tableCall?.[0]).toEqual(csvCall?.[0]);
    expect(tableCall?.[2]).toEqual(csvCall?.[2]);
    expect(tableCall?.[1]).toEqual({ page: 2, limit: 20 });
    expect(json.mock.calls[0]?.[0]).toMatchObject({
      data: { pagination: { page: 2, limit: 20, total: 57 } },
    });
  });

  it("filters the ledger on createdAt with the half-open Cyprus window", async () => {
    const chain = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      exec: async () => [],
    };
    const find = vi.spyOn(BookingFinancialTransactionModel, "find").mockReturnValue(chain as never);
    vi.spyOn(BookingFinancialTransactionModel, "countDocuments").mockReturnValue({
      exec: async () => 0,
    } as never);
    const table = platformTransactionsQuerySchema.parse(params);
    await new BookingFinancialTransactionRepository().listGlobalPage({
      ...(table.types ? { types: table.types } : {}),
      from: table.from,
      to: table.to,
      page: 1,
      limit: 20,
    });
    expect(find).toHaveBeenCalledWith({
      type: { $in: ["NO_SHOW_FEE", "CANCELLATION_FEE"] },
      createdAt: { $gte: table.from, $lt: table.to },
    });
  });
});

describe("P2.3 Finance 92-calendar-day autumn regression", () => {
  const dates = { from: "2026-09-01", to: "2026-12-01" };
  it("summary, table and CSV agree on the full 2,209-hour window and reject a 93rd day", () => {
    const summary = superAdminFinanceSummaryQuerySchema.parse(dates);
    const table = platformTransactionsQuerySchema.parse(dates);
    const csv = platformTransactionsExportQuerySchema.parse(dates);
    expect((summary.to.getTime() - summary.from.getTime()) / 3600000).toBe(2209);
    expect([summary.from, summary.to]).toEqual([table.from, table.to]);
    expect([csv.from, csv.to]).toEqual([table.from, table.to]);
    for (const schema of [
      superAdminFinanceSummaryQuerySchema,
      platformTransactionsQuerySchema,
      platformTransactionsExportQuerySchema,
    ]) {
      expect(schema.safeParse({ ...dates, to: "2026-12-02" }).success).toBe(false);
    }
  });
  it("chunks summary ledger reads without gaps or double counting; payout totals stay all-time", async () => {
    const period = superAdminFinanceSummaryQuerySchema.parse(dates);
    const aggregateOwnedBySource = vi.fn(async (input: { unclaimedOnly: boolean }) =>
      input.unclaimedOnly
        ? []
        : [
            { type: "PLATFORM_FEE", sourceType: "BOOKING", totalCents: 100, count: 1 },
            { type: "NO_SHOW_FEE", sourceType: "BOOKING", totalCents: 200, count: 1 },
          ],
    );
    const sumPaidTotal = vi.fn(async () => ({ totalCents: 500, count: 1 }));
    const service = new FinanceService(
      {} as never,
      { aggregateOwnedBySource, aggregateAllTimeOwnedBySource: async () => [] } as never,
      {} as never,
      { sumPaidTotal } as never,
    );
    const summary = await service.getPlatformSummary(period);
    expect(summary.bookly.netCents).toBe(200);
    expect(summary.collectedForBusinesses.amountCents).toBe(400);
    expect(sumPaidTotal).toHaveBeenCalledExactlyOnceWith();
    const calls = aggregateOwnedBySource.mock.calls.filter(
      ([input]) => !input.unclaimedOnly,
    ) as unknown as [{ from: Date; to: Date }][];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].from).toEqual(period.from);
    expect(calls[0]?.[0].to).toEqual(calls[1]?.[0].from);
    expect(calls[1]?.[0].to).toEqual(period.to);
    for (const [input] of calls)
      expect(input.to.getTime() - input.from.getTime()).toBeLessThanOrEqual(92 * 86400000);
  });
  it("keeps global table pagination bounded across the extra hour while preserving per-Business elapsed guards", async () => {
    const period = superAdminFinanceSummaryQuerySchema.parse(dates);
    const listGlobalPage = vi.fn(async () => ({ rows: [], total: 37 }));
    const aggregateBusinessOwnedBySource = vi.fn();
    const ledger = new BookingFinancialTransactionService({
      listGlobalPage,
      aggregateBusinessOwnedBySource,
    } as never);
    expect(await ledger.listGlobalPage({ ...period, page: 2, limit: 20 })).toEqual({
      rows: [],
      total: 37,
    });
    expect(listGlobalPage).toHaveBeenCalledExactlyOnceWith({ ...period, page: 2, limit: 20 });
    await expect(
      ledger.listGlobalPage({
        from: period.from,
        to: new Date(period.to.getTime() + 86400000),
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      ledger.aggregateOwnedBySource({ ...period, types: ["PLATFORM_FEE"], unclaimedOnly: false }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(aggregateBusinessOwnedBySource).not.toHaveBeenCalled();
  });
});

describe("E16 and authorization", () => {
  it("Sent to businesses (completed payouts) stays all-time; the summary reports Cyprus time", async () => {
    const sumPaidTotal = vi.fn(async () => ({ totalCents: 4850, count: 1 }));
    const aggregateOwnedBySource = vi.fn(async () => []);
    const service = new FinanceService(
      {} as never,
      { aggregateOwnedBySource, aggregateAllTimeOwnedBySource: async () => [] } as never,
      {} as never,
      { sumPaidTotal } as never,
    );
    const period = superAdminFinanceSummaryQuerySchema.parse({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    const summary = await service.getPlatformSummary(period);
    expect(sumPaidTotal).toHaveBeenCalledWith();
    expect(aggregateOwnedBySource).toHaveBeenCalledWith(
      expect.objectContaining({ from: period.from, to: period.to, unclaimedOnly: false }),
    );
    const dto = toPlatformSummaryDto(summary);
    expect(dto.sentToBusinesses).toMatchObject({ amountCents: 4850, payoutCount: 1 });
    expect(dto.period).toEqual({
      from: "2026-10-31T22:00:00.000Z",
      to: "2026-11-30T22:00:00.000Z",
      timezone: "Europe/Nicosia",
    });
  });

  it("platform Finance routes stay behind the Super Admin-only gate", () => {
    const router = createSuperAdminRoute();
    const gateIndex = router.stack.findIndex((layer) => layer.handle.length >= 3 && !layer.route);
    const paths = router.stack.map((layer) => layer.route?.path);
    for (const path of [
      "/finance/summary",
      "/finance/promo-discounts",
      "/finance/transactions",
      "/finance/transactions/export.csv",
    ]) {
      expect(paths.indexOf(path)).toBeGreaterThan(gateIndex + 2);
    }
    const guards = router.stack.slice(gateIndex + 1, gateIndex + 3).map((layer) => layer.handle);
    for (const role of ["BUSINESS_OWNER", "SUPERVISOR", "STAFF", "CUSTOMER"]) {
      let rejection: unknown;
      for (const guard of guards) {
        if (rejection) break;
        guard(
          { auth: { userId: "u", role, status: "ACTIVE" } } as unknown as Request,
          {} as Response,
          (error?: unknown) => {
            rejection = error;
          },
        );
      }
      expect(rejection).toMatchObject({ statusCode: 403 });
    }
  });
});
