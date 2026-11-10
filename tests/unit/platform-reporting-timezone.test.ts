import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroFilledMonths } from "../../src/common/time/analytics-buckets.js";
import { PLATFORM_REPORTING_TIMEZONE } from "../../src/common/time/platform-reporting.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import {
  superAdminAnalyticsPeriodQuerySchema,
  superAdminTopServicesQuerySchema,
} from "../../src/modules/super-admin/super-admin.schema.js";
import { resolveSeriesWindow } from "../../src/modules/super-admin/super-admin-analytics.util.js";
import { SuperAdminBookingAnalyticsService } from "../../src/modules/super-admin/super-admin-booking-analytics.service.js";
import { SuperAdminDashboardService } from "../../src/modules/super-admin/super-admin-dashboard.service.js";

afterEach(() => vi.restoreAllMocks());

/** Inclusive Cyprus dates -> the exact `[from, to)` UTC window the API filters on. */
const window = (fromDate: string, toDate: string) => {
  const parsed = superAdminAnalyticsPeriodQuerySchema.parse({ fromDate, toDate });
  return [parsed.fromDate?.toISOString(), parsed.toDate?.toISOString()];
};
const hours = (fromDate: string, toDate: string) => {
  const parsed = superAdminAnalyticsPeriodQuerySchema.parse({ fromDate, toDate });
  return ((parsed.toDate?.getTime() ?? 0) - (parsed.fromDate?.getTime() ?? 0)) / 3_600_000;
};

describe("E17 — Cyprus (Europe/Nicosia) reporting boundaries", () => {
  it("winter day is UTC+2, summer day is UTC+3", () => {
    expect(window("2026-01-15", "2026-01-15")).toEqual([
      "2026-01-14T22:00:00.000Z",
      "2026-01-15T22:00:00.000Z",
    ]);
    expect(window("2026-07-15", "2026-07-15")).toEqual([
      "2026-07-14T21:00:00.000Z",
      "2026-07-15T21:00:00.000Z",
    ]);
  });

  it("DST transition days are 23 and 25 hours long, not 24", () => {
    // Spring forward: Sunday 29 March 2026, 03:00 -> 04:00 local.
    expect(window("2026-03-29", "2026-03-29")).toEqual([
      "2026-03-28T22:00:00.000Z",
      "2026-03-29T21:00:00.000Z",
    ]);
    expect(hours("2026-03-29", "2026-03-29")).toBe(23);
    // Fall back: Sunday 25 October 2026, 04:00 -> 03:00 local.
    expect(window("2026-10-25", "2026-10-25")).toEqual([
      "2026-10-24T21:00:00.000Z",
      "2026-10-25T22:00:00.000Z",
    ]);
    expect(hours("2026-10-25", "2026-10-25")).toBe(25);
  });

  it("a Cyprus day starts on the previous UTC calendar date", () => {
    const [from] = window("2026-11-07", "2026-11-07");
    expect(from).toBe("2026-11-06T22:00:00.000Z");
  });

  it("month, quarter, week and year boundaries follow the Cyprus calendar", () => {
    expect(window("2026-11-01", "2026-11-30")).toEqual([
      "2026-10-31T22:00:00.000Z",
      "2026-11-30T22:00:00.000Z",
    ]);
    // Q1 spans the spring transition: starts at UTC+2, ends at UTC+3.
    expect(window("2026-01-01", "2026-03-31")).toEqual([
      "2025-12-31T22:00:00.000Z",
      "2026-03-31T21:00:00.000Z",
    ]);
    // ISO week Monday 2 Nov - Sunday 8 Nov 2026.
    expect(window("2026-11-02", "2026-11-08")).toEqual([
      "2026-11-01T22:00:00.000Z",
      "2026-11-08T22:00:00.000Z",
    ]);
    expect(window("2026-01-01", "2026-12-31")).toEqual([
      "2025-12-31T22:00:00.000Z",
      "2026-12-31T22:00:00.000Z",
    ]);
  });

  it("Top services uses the same boundaries; exact instants are still accepted unchanged", () => {
    const top = superAdminTopServicesQuerySchema.parse({
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
      limit: "6",
    });
    expect([top.fromDate?.toISOString(), top.toDate?.toISOString()]).toEqual(
      window("2026-07-01", "2026-07-31"),
    );
    const instants = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-01-01T00:00:00.000Z",
      toDate: "2027-01-01T00:00:00.000Z",
    });
    expect(instants.toDate?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(superAdminAnalyticsPeriodQuerySchema.safeParse({ fromDate: "2026-11-02" }).success).toBe(
      false,
    );
    expect(
      superAdminAnalyticsPeriodQuerySchema.safeParse({
        fromDate: "2026-11-09",
        toDate: "2026-11-02",
      }).success,
    ).toBe(false);
    expect(
      superAdminAnalyticsPeriodQuerySchema.safeParse({
        fromDate: "2026-02-30",
        toDate: "2026-03-02",
      }).success,
    ).toBe(false);
  });
});

describe("E17 — Cyprus monthly buckets", () => {
  it("zero-fills Cyprus months for a Cyprus year; UTC mode is unchanged", () => {
    const [from, to] = window("2026-01-01", "2026-12-31").map((iso) => new Date(iso as string));
    const cyprus = zeroFilledMonths(from as Date, to as Date, PLATFORM_REPORTING_TIMEZONE);
    expect(cyprus).toHaveLength(12);
    expect(cyprus[0]).toEqual({ year: 2026, month: 1 });
    expect(cyprus.at(-1)).toEqual({ year: 2026, month: 12 });
    // Without a zone the original UTC behavior (inclusive of `to`'s UTC month) is kept.
    expect(zeroFilledMonths(from as Date, to as Date)[0]).toEqual({ year: 2025, month: 12 });
  });

  it("groups created-at months in Europe/Nicosia only when asked", async () => {
    const aggregate = vi
      .spyOn(BookingModel, "aggregate")
      .mockReturnValue({ exec: async () => [] } as never);
    const repository = new BookingRepository();
    const from = new Date("2025-12-31T22:00:00.000Z");
    const to = new Date("2026-12-31T22:00:00.000Z");
    await repository.countCreatedByMonth(from, to, PLATFORM_REPORTING_TIMEZONE);
    await repository.countCreatedByMonth(from, to);
    const groupOf = (call: number) =>
      ((aggregate.mock.calls[call]?.[0] ?? []) as unknown as Array<Record<string, unknown>>)[1];
    expect(groupOf(0)).toMatchObject({
      $group: {
        _id: {
          year: { $year: { date: "$createdAt", timezone: "Europe/Nicosia" } },
          month: { $month: { date: "$createdAt", timezone: "Europe/Nicosia" } },
        },
      },
    });
    expect(groupOf(1)).toMatchObject({
      $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } } },
    });
  });

  it("all-time trend window starts at a Cyprus month start 11 months back", () => {
    const series = resolveSeriesWindow({
      from: new Date("2020-01-01T00:00:00.000Z"),
      to: new Date("2026-11-07T10:00:00.000Z"),
      isAllTime: true,
    });
    expect(series.from.toISOString()).toBe("2025-11-30T22:00:00.000Z"); // 1 Dec 2025, Cyprus
  });

  it("Booking analytics passes the Cyprus window and zone to the bucket query and reports it", async () => {
    const countCreatedByMonth = vi.fn(async () => []);
    const service = new SuperAdminBookingAnalyticsService(
      {
        countByStatusInRange: async () => ({}),
        countCreatedByMonth,
        aggregateClientTypeSplit: async () => ({ manual: 0, newBooking: 0, returning: 0 }),
        aggregateFulfilmentSplit: async () => ({ premises: 0, mobile: 0 }),
      } as never,
      { aggregateOwnedBySource: async () => [] } as never,
    );
    const query = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
    const result = await service.getAnalytics(query);
    expect(countCreatedByMonth).toHaveBeenCalledWith(
      query.fromDate,
      query.toDate,
      "Europe/Nicosia",
      undefined, // no City/Day scope
    );
    expect(result.period).toEqual({
      from: "2026-06-30T21:00:00.000Z",
      to: "2026-07-31T21:00:00.000Z",
      timezone: "Europe/Nicosia",
    });
  });

  it("Overview summary reports the zone and keeps current-state reads unfiltered", async () => {
    const countByStatusInRange = vi.fn(async () => ({}));
    const countByStatus = vi.fn(async () => ({
      PENDING: 0,
      APPROVED: 0,
      WARNING: 0,
      SUSPENDED: 0,
    }));
    const sumPaidTotal = vi.fn(async () => ({ totalCents: 900, count: 1 }));
    const service = new SuperAdminDashboardService(
      { countByStatus } as never,
      { countByRole: async () => 0 } as never,
      { countByStatusInRange, countAllByStatus: vi.fn() } as never,
      { aggregateOwnedBySource: async () => [] } as never,
      { listPendingPayouts: async () => ({ totalPendingCents: 0 }) } as never,
      { sumPaidTotal } as never,
    );
    const query = superAdminAnalyticsPeriodQuerySchema.parse({
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const summary = await service.getSummary(query);
    expect(countByStatusInRange).toHaveBeenCalledWith(
      new Date("2025-12-31T22:00:00.000Z"),
      new Date("2026-12-31T22:00:00.000Z"),
      undefined,
      undefined, // no City/Day scope
    );
    expect(summary.period).toMatchObject({ isAllTime: false, timezone: "Europe/Nicosia" });
    expect(countByStatus).toHaveBeenCalledWith(undefined);
    expect(sumPaidTotal).toHaveBeenCalledWith();
    expect(summary.completedPayoutsAllTimeCents).toBe(900);
  });
});
