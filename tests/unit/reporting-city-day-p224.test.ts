import type { Request, Response } from "express";
import { DateTime } from "luxon";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportingScopeMatch } from "../../src/common/reporting/platform-reporting-scope.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { BookingFinancialTransactionModel } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { PlatformReportingScopeResolver } from "../../src/modules/super-admin/platform-reporting-scope.resolver.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { superAdminAnalyticsPeriodQuerySchema } from "../../src/modules/super-admin/super-admin.schema.js";
import { SuperAdminAnalyticsController } from "../../src/modules/super-admin/super-admin-analytics.controller.js";
import { SuperAdminBookingAnalyticsService } from "../../src/modules/super-admin/super-admin-booking-analytics.service.js";
import { SuperAdminDashboardService } from "../../src/modules/super-admin/super-admin-dashboard.service.js";

afterEach(() => vi.restoreAllMocks());

// --- Fixtures -------------------------------------------------------------------------------
const nicosiaBiz = new Types.ObjectId();
const limassolBiz = new Types.ObjectId();
type Doc = { businessId: Types.ObjectId; createdAt: Date; status: string };
const bookings: Doc[] = [
  // Sunday 23:30 UTC in winter = Monday 01:30 in Cyprus.
  { businessId: nicosiaBiz, createdAt: new Date("2026-11-01T23:30:00Z"), status: "UPCOMING" },
  // Monday 10:00 UTC = Monday in Cyprus.
  { businessId: nicosiaBiz, createdAt: new Date("2026-11-02T10:00:00Z"), status: "COMPLETED" },
  // Sunday 20:00 UTC = Sunday 22:00 in Cyprus.
  { businessId: nicosiaBiz, createdAt: new Date("2026-11-01T20:00:00Z"), status: "COMPLETED" },
  // Limassol Monday: excluded by City.
  { businessId: limassolBiz, createdAt: new Date("2026-11-02T10:00:00Z"), status: "UPCOMING" },
  // Spring change: Saturday 22:30 UTC 28 Mar = Sunday 00:30 Cyprus (UTC+2 before the switch).
  { businessId: nicosiaBiz, createdAt: new Date("2026-03-28T22:30:00Z"), status: "COMPLETED" },
  // Autumn change: Saturday 21:30 UTC 24 Oct = Sunday 00:30 Cyprus (UTC+3 before the switch).
  { businessId: nicosiaBiz, createdAt: new Date("2026-10-24T21:30:00Z"), status: "COMPLETED" },
];

/** Evaluates the subset of `$match` the reporting repositories build, against a document. */
// biome-ignore lint/suspicious/noExplicitAny: test-only matcher
const matches = (doc: Record<string, any>, match: Record<string, any>): boolean =>
  Object.entries(match).every(([key, condition]) => {
    if (key === "$expr") {
      const [left, right] = condition.$eq;
      const { date, timezone } = left.$isoDayOfWeek;
      const value: Date = doc[date.slice(1)];
      return DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).weekday === right;
    }
    const value = doc[key];
    if (condition && typeof condition === "object" && !(condition instanceof Types.ObjectId)) {
      if ("$in" in condition)
        return condition.$in.some((id: unknown) => String(id) === String(value));
      if ("$gte" in condition) return value >= condition.$gte && value < condition.$lt;
    }
    return String(value) === String(condition);
  });

const countWith = async (
  query: Record<string, string>,
  resolver: PlatformReportingScopeResolver,
) => {
  vi.spyOn(BookingModel, "aggregate").mockImplementation(((
    // biome-ignore lint/suspicious/noExplicitAny: test-only pipeline fixture
    pipeline: Array<Record<string, any>>,
  ) => ({
    exec: async () => {
      const kept = bookings.filter((doc) => matches(doc, pipeline[0]?.["$match"]));
      const byStatus = new Map<string, number>();
      for (const doc of kept) byStatus.set(doc.status, (byStatus.get(doc.status) ?? 0) + 1);
      return [...byStatus].map(([_id, count]) => ({ _id, count }));
    },
  })) as never);
  const parsed = superAdminAnalyticsPeriodQuerySchema.parse(query);
  const { scope } = await resolver.resolve(parsed);
  const counts = await new BookingRepository().countByStatusInRange(
    parsed.fromDate ?? new Date("2020-01-01T00:00:00Z"),
    parsed.toDate ?? new Date("2030-01-01T00:00:00Z"),
    undefined,
    scope,
  );
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
};

const resolver = new PlatformReportingScopeResolver({
  listRegisteredCities: async () => ["Limassol", "Nicosia"],
  findIdsByRegisteredCity: async (city: string) =>
    city === "Nicosia" ? [nicosiaBiz] : [limassolBiz],
});

describe("City (registered Business city) and Day (Cyprus day of week)", () => {
  it("unscoped queries are unchanged; scoped ones add Business ids and a Europe/Nicosia weekday", () => {
    expect(reportingScopeMatch(undefined)).toEqual({});
    expect(reportingScopeMatch({ businessIds: [nicosiaBiz], isoDayOfWeek: 1 })).toEqual({
      businessId: { $in: [nicosiaBiz] },
      $expr: { $eq: [{ $isoDayOfWeek: { date: "$createdAt", timezone: "Europe/Nicosia" } }, 1] },
    });
    expect(
      reportingScopeMatch(
        { businessIds: [nicosiaBiz] },
        { businessField: "_id", timestampField: "activatedAt" },
      ),
    ).toEqual({ _id: { $in: [nicosiaBiz] } });
  });

  it("a Booking created Sunday 23:30 UTC counts as Monday in Cyprus; City, Day and Period compose", async () => {
    const week = { fromDate: "2026-11-01", toDate: "2026-11-08" };
    expect(await countWith({ ...week }, resolver)).toBe(4);
    expect(await countWith({ ...week, city: "Nicosia" }, resolver)).toBe(3);
    expect(await countWith({ ...week, city: "Nicosia", day: "MONDAY" }, resolver)).toBe(2);
    expect(await countWith({ ...week, city: "Nicosia", day: "SUNDAY" }, resolver)).toBe(1);
    expect(await countWith({ ...week, day: "MONDAY" }, resolver)).toBe(3);
    // All time + Sunday: the two DST-change bookings are Sundays in Cyprus (Saturdays in UTC).
    expect(await countWith({ city: "Nicosia", day: "SUNDAY" }, resolver)).toBe(3);
    expect(await countWith({ city: "Nicosia", day: "SATURDAY" }, resolver)).toBe(0);
    // This month (November) + Monday excludes Mondays in other months.
    expect(
      await countWith({ fromDate: "2026-11-01", toDate: "2026-11-30", day: "MONDAY" }, resolver),
    ).toBe(3);
    expect(
      await countWith({ fromDate: "2026-03-01", toDate: "2026-03-31", day: "SUNDAY" }, resolver),
    ).toBe(1);
  });

  it("City options come from real registered cities; unknown values are rejected", async () => {
    await expect(resolver.listCities()).resolves.toEqual(["Limassol", "Nicosia"]);
    await expect(resolver.resolve({ city: "Atlantis" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(resolver.resolve({})).resolves.toEqual({
      scope: undefined,
      filters: { city: null, day: null },
    });
    expect(superAdminAnalyticsPeriodQuerySchema.safeParse({ day: "FUNDAY" }).success).toBe(false);

    const aggregate = vi.spyOn(BusinessModel, "aggregate").mockReturnValue({
      exec: async () => [{ _id: "Larnaca" }, { _id: "Nicosia" }],
    } as never);
    expect(await new BusinessRepository().listRegisteredCities()).toEqual(["Larnaca", "Nicosia"]);
    expect(aggregate.mock.calls[0]?.[0]).toEqual([
      { $project: { city: { $trim: { input: { $ifNull: ["$address.city", ""] } } } } },
      { $match: { city: { $ne: "" } } },
      { $group: { _id: "$city" } },
      { $sort: { _id: 1 } },
    ]);
    const find = vi.spyOn(BusinessModel, "find").mockReturnValue({
      lean: () => ({ exec: async () => [{ _id: nicosiaBiz }] }),
    } as never);
    expect(await new BusinessRepository().findIdsByRegisteredCity("Nicosia")).toEqual([nicosiaBiz]);
    expect(find.mock.calls[0]?.[0]).toEqual({
      $expr: { $eq: [{ $trim: { input: { $ifNull: ["$address.city", ""] } } }, "Nicosia"] },
    });
  });
});

describe("financial attribution", () => {
  it("ledger revenue is narrowed by the row's own Business and its ledger createdAt weekday", async () => {
    const aggregate = vi
      .spyOn(BookingFinancialTransactionModel, "aggregate")
      .mockReturnValue({ exec: async () => [] } as never);
    await new BookingFinancialTransactionRepository().aggregateBusinessOwnedBySource({
      types: ["PLATFORM_FEE"],
      unclaimedOnly: false,
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-12-01T00:00:00Z"),
      scope: { businessIds: [nicosiaBiz], isoDayOfWeek: 5 },
    });
    expect(
      ((aggregate.mock.calls[0]?.[0] ?? []) as unknown as Array<Record<string, unknown>>)[0],
    ).toEqual({
      $match: {
        type: { $in: ["PLATFORM_FEE"] },
        status: "SUCCEEDED",
        createdAt: {
          $gte: new Date("2026-11-01T00:00:00Z"),
          $lt: new Date("2026-12-01T00:00:00Z"),
        },
        businessId: { $in: [nicosiaBiz] },
        $expr: { $eq: [{ $isoDayOfWeek: { date: "$createdAt", timezone: "Europe/Nicosia" } }, 5] },
      },
    });
  });

  it("Overview: scoped bookings/revenue/businesses/pending; Customers and E16 Completed Payouts stay global", async () => {
    const deps = {
      countByStatus: vi.fn(async () => ({ PENDING: 0, APPROVED: 1, WARNING: 0, SUSPENDED: 0 })),
      countByRole: vi.fn(async () => 40),
      countAllByStatus: vi.fn(),
      countByStatusInRange: vi.fn(async (..._args: unknown[]) => ({ COMPLETED: 2 })),
      aggregateAllTimeOwnedBySource: vi.fn(async () => []),
      listPendingPayouts: vi.fn(async () => ({
        items: [
          { businessId: String(nicosiaBiz), netCents: 300 },
          { businessId: String(limassolBiz), netCents: 900 },
        ],
        totalPendingCents: 1200,
        businessCount: 2,
      })),
      sumPaidTotal: vi.fn(async () => ({ totalCents: 5000, count: 2 })),
    };
    const service = new SuperAdminDashboardService(
      { countByStatus: deps.countByStatus } as never,
      { countByRole: deps.countByRole } as never,
      {
        countAllByStatus: deps.countAllByStatus,
        countByStatusInRange: deps.countByStatusInRange,
      } as never,
      { aggregateAllTimeOwnedBySource: deps.aggregateAllTimeOwnedBySource } as never,
      { listPendingPayouts: deps.listPendingPayouts } as never,
      { sumPaidTotal: deps.sumPaidTotal } as never,
    );
    const { scope, filters } = await resolver.resolve({ city: "Nicosia", day: "MONDAY" });
    const summary = await service.getSummary({}, scope, filters);
    // All time + scope uses the createdAt-window query (countAllByStatus has no scope).
    expect(deps.countAllByStatus).not.toHaveBeenCalled();
    expect(deps.countByStatusInRange.mock.calls[0]?.[3]).toEqual(scope);
    expect(deps.countByStatus).toHaveBeenCalledWith(scope);
    expect(deps.aggregateAllTimeOwnedBySource).toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    );
    expect(summary.pendingBusinessPayableCents).toBe(300);
    expect(deps.countByRole).toHaveBeenCalledWith("CUSTOMER");
    expect(deps.sumPaidTotal).toHaveBeenCalledWith();
    expect(summary.completedPayoutsAllTimeCents).toBe(5000);
    expect(summary.customers.total).toBe(40);
    expect(summary.filters).toEqual({ city: "Nicosia", day: "MONDAY" });
  });

  it("Overview and Analytics send the identical window and scope for the same filters", async () => {
    const overviewCall = vi.fn(async () => ({}));
    const analyticsCall = vi.fn(async () => ({}));
    const overview = new SuperAdminDashboardService(
      {
        countByStatus: async () => ({ PENDING: 0, APPROVED: 0, WARNING: 0, SUSPENDED: 0 }),
      } as never,
      { countByRole: async () => 0 } as never,
      { countByStatusInRange: overviewCall } as never,
      { aggregateOwnedBySource: async () => [] } as never,
      { listPendingPayouts: async () => ({ items: [], totalPendingCents: 0 }) } as never,
      { sumPaidTotal: async () => ({ totalCents: 0, count: 0 }) } as never,
    );
    const analytics = new SuperAdminBookingAnalyticsService(
      {
        countByStatusInRange: analyticsCall,
        countCreatedByMonth: async () => [],
        aggregateClientTypeSplit: async () => ({ manual: 0, newBooking: 0, returning: 0 }),
        aggregateFulfilmentSplit: async () => ({ premises: 0, mobile: 0 }),
      } as never,
      { aggregateOwnedBySource: async () => [] } as never,
    );
    const query = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
      city: "Nicosia",
      day: "FRIDAY",
    });
    const { scope } = await resolver.resolve(query);
    await overview.getSummary(query, scope);
    await analytics.getAnalytics(query, scope);
    expect(overviewCall.mock.calls[0]).toEqual(analyticsCall.mock.calls[0]);
  });
});

describe("authorization and labels", () => {
  it("Customer analytics validate City/Day but report platform-wide scope", async () => {
    const getAnalytics = vi.fn(async () => ({ registeredTotal: 40 }));
    const controller = new SuperAdminAnalyticsController(
      {} as never,
      {} as never,
      { getAnalytics } as never,
      {} as never,
      {} as never,
      {} as never,
      resolver,
    );
    const json = vi.fn();
    await controller.getCustomerAnalytics(
      { validated: { query: { city: "Nicosia", day: "MONDAY" } } } as unknown as Request,
      { status: vi.fn().mockReturnThis(), json } as unknown as Response,
    );
    expect(json.mock.calls[0]?.[0]).toMatchObject({
      data: { registeredTotal: 40, scope: "PLATFORM_WIDE_NOT_CITY_OR_DAY_FILTERED" },
    });
  });

  it("reporting routes stay behind the Super Admin-only gate", () => {
    const router = createSuperAdminRoute();
    const gateIndex = router.stack.findIndex((layer) => layer.handle.length >= 3 && !layer.route);
    const paths = router.stack.map((layer) => layer.route?.path);
    for (const path of [
      "/dashboard/summary",
      "/analytics/bookings",
      "/analytics/top-services",
      "/analytics/reporting-cities",
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
