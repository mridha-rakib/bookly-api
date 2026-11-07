import { Writable } from "node:stream";
import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { csvRow } from "../../src/common/http/csv.js";
import { businessLocalToUtc } from "../../src/common/time/business-clock.js";
import { DashboardOverviewService } from "../../src/modules/dashboard-overview/dashboard-overview.service.js";
import { platformTransactionsExportQuerySchema } from "../../src/modules/finance/finance.schema.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { superAdminAnalyticsPeriodQuerySchema } from "../../src/modules/super-admin/super-admin.schema.js";
import { SuperAdminDashboardService } from "../../src/modules/super-admin/super-admin-dashboard.service.js";
import { SuperAdminFinanceController } from "../../src/modules/super-admin/super-admin-finance.controller.js";
import { buildBusiness } from "./stage-b-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const csvResponse = () => {
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const setHeader = vi.fn();
  Object.assign(response, { setHeader });
  return { response: response as unknown as Response, chunks, setHeader };
};

describe("G7 — shared CSV encoder", () => {
  it("escapes quotes/commas/newlines, keeps Unicode, neutralizes formulas and keeps amounts numeric", () => {
    const when = new Date("2026-11-07T10:15:00.000Z");
    expect(
      csvRow([
        'Café "Zoë", Larnaca',
        "line1\r\nline2",
        '=HYPERLINK("x")',
        "\u0000\t+SUM(A1)",
        "  @cmd",
        "-150",
        -150,
        0,
        null,
        undefined,
        when,
      ]),
    ).toBe(
      `${[
        '"Café ""Zoë"", Larnaca"',
        '"line1\r\nline2"',
        '"\'=HYPERLINK(""x"")"',
        '"\'\u0000\t+SUM(A1)"',
        '"\'  @cmd"',
        '"\'-150"',
        '"-150"',
        '"0"',
        '""',
        '""',
        '"2026-11-07T10:15:00.000Z"',
      ].join(",")}\r\n`,
    );
  });
});

describe("G7 — Super Admin Finance exports", () => {
  const txRow = (n: number) => ({
    id: `tx-${n}`,
    businessId: "b1",
    businessName: n === 1 ? '=cmd|"/c calc"' : "Salon, Ltd",
    bookingId: `bk-${n}`,
    bookingReference: `BK-${n}`,
    customerName: "Zoë",
    type: n % 2 ? "NO_SHOW_FEE" : "REFUND",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, n)),
    grossCents: n % 2 ? 2500 : -1200,
    stripeFeeCents: 75,
    netCents: n % 2 ? 2425 : -1200,
    owner: n % 2 ? "BUSINESS" : "CUSTOMER",
    status: "SUCCEEDED",
    payoutId: n % 2 ? "po-1" : undefined,
    currency: "EUR",
    ...(n % 2 ? {} : { refundOrigin: "BOOKING_CANCELLATION" }),
  });

  it("exports every filtered transaction page, not the loaded 20, with identities and cent amounts", async () => {
    const all = Array.from({ length: 205 }, (_, i) => txRow(i + 1));
    const listPlatformTransactions = vi.fn(
      async (_period: unknown, page: { page: number; limit: number }, _types?: unknown) => ({
        rows: all.slice((page.page - 1) * page.limit, page.page * page.limit),
        total: all.length,
      }),
    );
    const controller = new SuperAdminFinanceController(
      { listPlatformTransactions } as never,
      {} as never,
      {} as never,
    );
    const query = platformTransactionsExportQuerySchema.parse({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      types: "NO_SHOW_FEE,CANCELLATION_FEE,BOGUS",
    });
    const { response, chunks, setHeader } = csvResponse();
    await controller.exportPlatformTransactions(
      { validated: { query } } as unknown as Request,
      response,
    );

    expect(listPlatformTransactions.mock.calls.map((call) => call[1])).toEqual([
      { page: 1, limit: 100 },
      { page: 2, limit: 100 },
      { page: 3, limit: 100 },
    ]);
    for (const call of listPlatformTransactions.mock.calls) {
      expect(call[0]).toEqual({ from: query.from, to: query.to });
      expect(call[2]).toEqual(["NO_SHOW_FEE", "CANCELLATION_FEE"]);
    }
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/csv; charset=utf-8");
    const lines = chunks.join("").replace(/^﻿/, "").split("\r\n");
    expect(lines).toHaveLength(207);
    expect(lines[0]).toContain('"TRANSACTION ID","DATE","BUSINESS ID","BUSINESS"');
    expect(lines[0]).toContain('"GROSS CENTS","PROCESSING FEE CENTS","NET CENTS","CURRENCY"');
    expect(lines[1]).toBe(
      '"tx-1","2026-10-01T00:00:01.000Z","b1","\'=cmd|""/c calc""","bk-1","BK-1","Zoë","NO_SHOW_FEE","","BUSINESS","2500","75","2425","EUR","SUCCEEDED","po-1"',
    );
    expect(lines[2]).toContain('"Salon, Ltd"');
    expect(lines[2]).toContain(
      '"REFUND","BOOKING_CANCELLATION","CUSTOMER","-1200","75","-1200","EUR"',
    );
    expect(lines[205]).toContain('"tx-205"');
    expect(platformTransactionsExportQuerySchema.safeParse({ ...query, page: "2" }).success).toBe(
      false,
    );
    expect(platformTransactionsExportQuerySchema.safeParse({ types: "REFUND" }).success).toBe(
      false,
    );
  });

  it("exports the complete pending list and payout history with payout identity and status", async () => {
    const listPendingPayouts = vi.fn(async () => ({
      items: [
        {
          businessId: "b1",
          businessName: "+Spa",
          city: "Limassol",
          category: "Beauty",
          grossCents: 5000,
          processingFeesCents: 150,
          refundsCents: 0,
          disputeAdjustmentsCents: -300,
          netCents: 4550,
          transactionCount: 3,
          noShowAmountCents: 2000,
          cancellationAmountCents: 1000,
          depositAmountCents: 2000,
        },
      ],
      totalPendingCents: 4550,
      businessCount: 1,
    }));
    const listPlatformPayoutHistory = vi.fn(async () => ({
      items: [
        {
          id: "po-1",
          businessId: "b1",
          businessName: "Spa",
          periodStart: new Date("2026-10-01T00:00:00Z"),
          periodEnd: new Date("2026-10-31T00:00:00Z"),
          grossBusinessOwnedCents: 5000,
          processingFeesCents: 150,
          disputeAdjustmentsCents: 0,
          netPayoutCents: 4850,
          currency: "EUR",
          status: "PAID",
          paidAt: new Date("2026-11-02T09:00:00Z"),
          providerReference: "SEPA-1",
        },
      ],
      total: 1,
    }));
    const controller = new SuperAdminFinanceController(
      { listPendingPayouts, listPlatformPayoutHistory } as never,
      {} as never,
      {} as never,
    );

    const pending = csvResponse();
    await controller.exportPendingPayouts({} as Request, pending.response);
    const pendingLines = pending.chunks.join("").replace(/^﻿/, "").split("\r\n");
    expect(listPendingPayouts).toHaveBeenCalledTimes(1);
    expect(pendingLines).toHaveLength(3);
    expect(pendingLines[1]).toMatch(
      /^"b1","'\+Spa","Limassol","Beauty","3","2000","1000","2000","5000","150","0","-300","4550","EUR","\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/,
    );

    const payouts = csvResponse();
    await controller.exportPlatformPayouts({} as Request, payouts.response);
    expect(listPlatformPayoutHistory).toHaveBeenCalledWith({ page: 1, limit: 100 });
    expect(payouts.chunks.join("")).toContain(
      '"po-1","b1","Spa","2026-10-01T00:00:00.000Z","2026-10-31T00:00:00.000Z","5000","150","0","4850","EUR","PAID","2026-11-02T09:00:00.000Z","SEPA-1"',
    );
  });

  it("export routes sit behind the Super Admin-only gate", () => {
    const router = createSuperAdminRoute();
    const gateIndex = router.stack.findIndex((layer) => layer.handle.length >= 3 && !layer.route);
    const paths = router.stack.map((layer) => layer.route?.path);
    for (const path of [
      "/finance/transactions/export.csv",
      "/finance/payouts/export.csv",
      "/finance/pending-payouts/export.csv",
      "/dashboard/summary",
    ]) {
      expect(paths.indexOf(path)).toBeGreaterThan(gateIndex + 2);
    }
    const guards = router.stack.slice(gateIndex + 1, gateIndex + 3).map((layer) => layer.handle);
    for (const [role, status] of [
      ["BUSINESS_OWNER", "ACTIVE"],
      ["SUPERVISOR", "ACTIVE"],
      ["STAFF", "ACTIVE"],
      ["CUSTOMER", "ACTIVE"],
      ["SUPER_ADMIN", "SUSPENDED"],
    ] as const) {
      let rejection: unknown;
      for (const guard of guards) {
        if (rejection) break;
        guard(
          { auth: { userId: String(new Types.ObjectId()), role, status } } as Request,
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

describe("G5 — Super Admin summary period contract", () => {
  const build = () => {
    const deps = {
      countByStatus: vi.fn(async () => ({ PENDING: 1, APPROVED: 2, WARNING: 0, SUSPENDED: 0 })),
      countByRole: vi.fn(async () => 9),
      countAllByStatus: vi.fn(async () => ({ COMPLETED: 40 })),
      countByStatusInRange: vi.fn(async () => ({ COMPLETED: 4 })),
      aggregateAllTimeOwnedBySource: vi.fn(async () => []),
      aggregateOwnedBySource: vi.fn(async () => []),
      listPendingPayouts: vi.fn(async () => ({ totalPendingCents: 700 })),
      sumPaidTotal: vi.fn(async () => ({ totalCents: 900, count: 1 })),
    };
    const service = new SuperAdminDashboardService(
      { countByStatus: deps.countByStatus } as never,
      { countByRole: deps.countByRole } as never,
      {
        countAllByStatus: deps.countAllByStatus,
        countByStatusInRange: deps.countByStatusInRange,
      } as never,
      {
        aggregateAllTimeOwnedBySource: deps.aggregateAllTimeOwnedBySource,
        aggregateOwnedBySource: deps.aggregateOwnedBySource,
      } as never,
      { listPendingPayouts: deps.listPendingPayouts } as never,
      { sumPaidTotal: deps.sumPaidTotal } as never,
    );
    return { service, deps };
  };

  it("all time keeps the original all-time reads", async () => {
    const { service, deps } = build();
    const summary = await service.getSummary();
    expect(deps.countAllByStatus).toHaveBeenCalled();
    expect(deps.aggregateAllTimeOwnedBySource).toHaveBeenCalled();
    expect(deps.countByStatusInRange).not.toHaveBeenCalled();
    expect(deps.aggregateOwnedBySource).not.toHaveBeenCalled();
    expect(summary.period.isAllTime).toBe(true);
    expect(summary.bookings.total).toBe(40);
  });

  it("a period filters only Bookings (createdAt) and Bookly revenue; current-state figures are unchanged", async () => {
    const { service, deps } = build();
    const query = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-01-01T00:00:00.000Z",
      toDate: "2027-01-01T00:00:00.000Z",
    });
    const summary = await service.getSummary(query);
    expect(deps.countByStatusInRange).toHaveBeenCalledWith(query.fromDate, query.toDate);
    expect(deps.countAllByStatus).not.toHaveBeenCalled();
    // A year is walked in <=90-day ledger chunks covering exactly [from, to).
    const chunks = deps.aggregateOwnedBySource.mock.calls.map(
      (call) => (call as unknown as [{ from: Date; to: Date }])[0],
    );
    expect(chunks[0]?.from).toEqual(query.fromDate);
    expect(chunks.at(-1)?.to).toEqual(query.toDate);
    expect(summary).toMatchObject({
      period: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-01-01T00:00:00.000Z",
        isAllTime: false,
      },
      bookings: { total: 4 },
      businesses: { total: 3 },
      customers: { total: 9 },
      pendingBusinessPayableCents: 700,
      completedPayoutsAllTimeCents: 900,
    });
    expect(deps.countByStatus).toHaveBeenCalledWith();
    expect(
      superAdminAnalyticsPeriodQuerySchema.safeParse({ fromDate: "2026-01-01T00:00:00.000Z" })
        .success,
    ).toBe(false);
    expect(superAdminAnalyticsPeriodQuerySchema.safeParse({ city: "Larnaca" }).success).toBe(false);
  });
});

describe("G9 — Staff/Supervisor Overview range and employment", () => {
  const buildService = (business: ReturnType<typeof buildBusiness>, membership: unknown) => {
    const schedule = vi.fn(async () => []);
    const totals = vi.fn(async () => ({ count: 12, remaining: 2, balanceDueCents: 0 }));
    const service = new DashboardOverviewService(
      { findById: async () => business } as never,
      { findActiveByUserId: async () => membership } as never,
      {
        findScheduleForBusinessOnDate: schedule,
        getOverviewRangeTotals: totals,
        countNoShowsForBusinessInRange: async () => 0,
        findManyByIds: async () => [],
      } as never,
      { aggregateForBusiness: async () => [], listRecentForBusiness: async () => [] } as never,
      { getNetPayoutForBusiness: async () => 0 } as never,
    );
    return { service, schedule, totals };
  };

  it("Staff 30D uses the Business-local date and only the Staff member's own membership", async () => {
    vi.useFakeTimers();
    // 22:30 UTC on 31 March = 01:30 on 1 April in Nicosia: the Business-local "today" is 1 April.
    vi.setSystemTime(new Date("2030-03-31T22:30:00Z"));
    const business = buildBusiness({ timezone: "Europe/Nicosia" });
    const actor = new Types.ObjectId();
    const membershipId = new Types.ObjectId();
    const { service, schedule, totals } = buildService(business, {
      _id: membershipId,
      userId: actor,
      businessId: business._id,
      role: "STAFF",
      employmentActive: true,
      removedAt: null,
    });
    const result = await service.getOverview(String(actor), "STAFF", String(business._id), {
      range: "30D",
    });
    const from = businessLocalToUtc(business.timezone, "2030-03-03", "00:00");
    const to = businessLocalToUtc(business.timezone, "2030-04-02", "00:00");
    expect(schedule).toHaveBeenCalledWith(business._id, from, to, membershipId);
    expect(totals).toHaveBeenCalledWith(business._id, from, to, expect.any(Date), membershipId);
    expect(result).toMatchObject({
      scope: "STAFF_SCOPED",
      financials: null,
      todayBookingsCount: 12,
      period: { fromDate: "2030-03-03", toDate: "2030-04-01" },
    });
  });

  it("inactive or other-Business Staff/Supervisor memberships are denied before any read", async () => {
    const business = buildBusiness({ timezone: "Europe/Nicosia" });
    const actor = new Types.ObjectId();
    for (const [role, membership] of [
      ["STAFF", { role: "STAFF", employmentActive: false, removedAt: null }],
      ["SUPERVISOR", { role: "SUPERVISOR", employmentActive: true, removedAt: new Date() }],
      [
        "SUPERVISOR",
        { role: "SUPERVISOR", employmentActive: true, removedAt: null, otherBusiness: true },
      ],
    ] as const) {
      const { service, schedule } = buildService(business, {
        _id: new Types.ObjectId(),
        userId: actor,
        businessId: "otherBusiness" in membership ? new Types.ObjectId() : business._id,
        ...membership,
      });
      await expect(
        service.getOverview(String(actor), role, String(business._id), { range: "7D" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(schedule).not.toHaveBeenCalled();
    }
  });
});
