import { Types } from "mongoose";

import {
  addCalendarMonths,
  businessLocalToUtc,
  utcToBusinessLocalDate,
} from "../../common/time/business-clock.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { FinancialTransactionAggregateBucket } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { ClientRepository } from "../client/client.repository.js";
import { daysOfWeek } from "../staff/staff-schedule.types.js";
import { DashboardAnalyticsError } from "./dashboard-analytics.errors.js";
import {
  ANALYTICS_STATUS_BREAKDOWN_ORDER,
  type DashboardAnalytics,
  type DashboardAnalyticsPeriod,
} from "./dashboard-analytics.types.js";

/** Business Dashboard "Analytics" tab's Top Services panel — bounded, never an unlimited list
 * (matches SuperAdminBusinessAnalyticsService's own `TOP_N` precedent). */
const TOP_SERVICES_LIMIT = 5;

/** BookingFinancialTransactionRepository's own `MAX_BUSINESS_LEDGER_RANGE_DAYS` (92) — every
 * bounded ledger read this service makes is chunked to stay strictly under it (90, for margin)
 * rather than duplicating that constant's exact value here. A YEAR period (~365 days) is walked
 * in several such chunks and summed; this is orchestration only (repeated calls to the SAME
 * proven `aggregateForBusiness` primitive), never a re-implementation of its aggregation. */
const LEDGER_CHUNK_DAYS = 90;

/**
 * Real, business-scoped backend for the Business Owner dashboard "Analytics" tab — replaces the
 * 100% hardcoded mock data in analyticsMockData.ts/DashboardAnalytics.tsx.
 *
 * Mounted inside business.route.ts (see dashboard-analytics.route.ts's own comment), so every
 * request has already passed that router's `requireRoles(["BUSINESS_OWNER"])` gate — this
 * service still independently re-derives that the actor actually OWNS the requested businessId
 * (never trusts the path param alone), mirroring FinanceService.requireOwnedFinanceBusiness's
 * exact 404-never-a-bare-403 anti-enumeration convention.
 *
 * Every count reuses an existing, already-proven BookingRepository/ClientRepository aggregation
 * primitive (the same ones SuperAdminBookingAnalyticsService/SuperAdminBusinessAnalyticsService
 * already use platform-wide) — this module only adds businessId scoping to the two that were
 * previously global-only (`countByStatusInRange`, `aggregateTopServices` — see
 * BookingRepository's own comments on those two params). Every money figure is ledger-derived
 * via BookingFinancialTransactionService, never `Booking.totalCents` — see each field's own doc
 * comment in dashboard-analytics.types.ts for the exact formula and precedent it reuses.
 */
export class DashboardAnalyticsService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly clientRepository: ClientRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
  ) {}

  public async getAnalytics(
    actorUserId: string,
    businessId: string,
    period: DashboardAnalyticsPeriod,
  ): Promise<DashboardAnalytics> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const now = new Date();

    const { from, to, previous } = this.resolvePeriodRange(business, period, now);

    const [
      statusCounts,
      stats,
      previousStats,
      newCustomersCount,
      topServicesRows,
      weekdayRows,
      revenueBuckets,
      upfrontBuckets,
      previousUpfrontBuckets,
    ] = await Promise.all([
      this.bookingRepository.countByStatusInRange(from, to, business._id),
      this.bookingRepository.aggregateBusinessBookingStats(from, to, business._id),
      previous
        ? this.bookingRepository.aggregateBusinessBookingStats(
            previous.from,
            previous.to,
            business._id,
          )
        : Promise.resolve([]),
      this.newCustomersCount(business._id, from, to),
      this.bookingRepository.aggregateTopServices(from, to, TOP_SERVICES_LIMIT, business._id),
      this.bookingRepository.aggregateBookingCountsByWeekday(
        business._id,
        from,
        to,
        business.timezone,
      ),
      this.sumLedger(business._id, ["NO_SHOW_FEE", "CANCELLATION_FEE"], from, to),
      this.sumLedger(business._id, ["DEPOSIT", "PLATFORM_FEE"], from, to),
      previous
        ? this.sumLedger(business._id, ["DEPOSIT", "PLATFORM_FEE"], previous.from, previous.to)
        : Promise.resolve([] as FinancialTransactionAggregateBucket[]),
    ]);

    const businessStats = stats[0] ?? {
      totalCount: 0,
      completedCount: 0,
      noShowCount: 0,
      manualCount: 0,
      newCount: 0,
      returningCount: 0,
    };
    const previousTotalCount = previousStats[0]?.totalCount ?? 0;

    const revenueRecoveredCents = this.sumSucceeded(revenueBuckets);
    const bookedOnlineCount = businessStats.totalCount - businessStats.manualCount;
    const avgBookingValueCents =
      bookedOnlineCount > 0 ? Math.round(this.sumSucceeded(upfrontBuckets) / bookedOnlineCount) : 0;

    const previousBusinessStats = previousStats[0];
    const previousBookedOnlineCount = previousBusinessStats
      ? previousBusinessStats.totalCount - previousBusinessStats.manualCount
      : 0;
    const previousAvgBookingValueCents =
      previous && previousBookedOnlineCount > 0
        ? Math.round(this.sumSucceeded(previousUpfrontBuckets) / previousBookedOnlineCount)
        : null;

    return {
      period,
      currency: "EUR",
      rangeFrom: from,
      rangeTo: to,

      totalBookingsCount: businessStats.totalCount,
      totalBookingsChangePercent: this.changePercent(businessStats.totalCount, previousTotalCount),

      newCustomersCount,
      returningCustomersCount: businessStats.returningCount,

      completionRate: this.rate(businessStats.completedCount, businessStats.totalCount),
      noShowRate: this.rate(businessStats.noShowCount, businessStats.totalCount),
      noShowCount: businessStats.noShowCount,
      noShowChargedCount: statusCounts.NO_SHOW_CHARGED,

      avgBookingValueCents,
      avgBookingValueChangeCents:
        previousAvgBookingValueCents === null
          ? null
          : avgBookingValueCents - previousAvgBookingValueCents,

      revenueRecoveredCents,

      topServices: topServicesRows.map((row) => ({
        serviceId: row.serviceId,
        name: row.name,
        count: row.count,
      })),

      bookingsByStatus: ANALYTICS_STATUS_BREAKDOWN_ORDER.map((status) => ({
        status,
        count: statusCounts[status],
      })),

      busiestDays: this.toWeekdayCounts(weekdayRows),
    };
  }

  // --- Authorization -------------------------------------------------------------------------

  /** OWNER-only, same anti-enumeration convention as FinanceService.requireOwnedFinanceBusiness
   * (404, never a bare 403, on any mismatch or invalid id). */
  private async requireOwnedBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new DashboardAnalyticsError("DASHBOARD_ANALYTICS_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new DashboardAnalyticsError("DASHBOARD_ANALYTICS_BUSINESS_NOT_FOUND", 404);
    }
    if (!business.ownerUserId.equals(actorUserId)) {
      throw new DashboardAnalyticsError("DASHBOARD_ANALYTICS_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  // --- Period resolution ---------------------------------------------------------------------

  /**
   * MONTH/YEAR are business-local calendar boundaries (same `businessLocalToUtc`/
   * `addCalendarMonths` DST-safe helpers DashboardOverviewService already uses for its own
   * monthly boundary) with a same-length "previous period" for the %-change cards. ALL spans
   * from this Business's own `createdAt` to now — real data ("since this Business existed"),
   * never an arbitrary fixed lookback — and has no previous-period comparison (`previous:
   * undefined`): there is no meaningful "period before all time".
   */
  private resolvePeriodRange(
    business: BusinessDocument,
    period: DashboardAnalyticsPeriod,
    now: Date,
  ): { from: Date; to: Date; previous?: { from: Date; to: Date } } {
    const { dateStr } = utcToBusinessLocalDate(business.timezone, now);

    if (period === "MONTH") {
      const monthStartStr = `${dateStr.slice(0, 7)}-01`;
      const from = businessLocalToUtc(business.timezone, monthStartStr, "00:00");
      const to = businessLocalToUtc(
        business.timezone,
        addCalendarMonths(monthStartStr, 1),
        "00:00",
      );
      const previousMonthStartStr = addCalendarMonths(monthStartStr, -1);
      const previous = {
        from: businessLocalToUtc(business.timezone, previousMonthStartStr, "00:00"),
        to: from,
      };
      return { from, to, previous };
    }

    if (period === "YEAR") {
      const yearStartStr = `${dateStr.slice(0, 4)}-01-01`;
      const from = businessLocalToUtc(business.timezone, yearStartStr, "00:00");
      const to = businessLocalToUtc(
        business.timezone,
        addCalendarMonths(yearStartStr, 12),
        "00:00",
      );
      const previousYearStartStr = addCalendarMonths(yearStartStr, -12);
      const previous = {
        from: businessLocalToUtc(business.timezone, previousYearStartStr, "00:00"),
        to: from,
      };
      return { from, to, previous };
    }

    // ALL
    return { from: business.createdAt, to: now };
  }

  // --- Money (ledger-derived) ------------------------------------------------------------------

  /** Sums the SUCCEEDED bucket(s) across `types`. */
  private sumSucceeded(buckets: FinancialTransactionAggregateBucket[]): number {
    return buckets
      .filter((bucket) => bucket.status === "SUCCEEDED")
      .reduce((sum, bucket) => sum + bucket.totalCents, 0);
  }

  /** Bounded ledger reads (`BookingFinancialTransactionService.aggregateForBusiness`) are capped
   * at ~92 days; a MONTH window fits in one call, a YEAR window is walked in <=90-day chunks and
   * merged (see this class's own `LEDGER_CHUNK_DAYS` comment) — orchestration only, never a
   * second aggregation implementation. */
  private async sumLedger(
    businessId: Types.ObjectId,
    types: Array<"NO_SHOW_FEE" | "CANCELLATION_FEE" | "DEPOSIT" | "PLATFORM_FEE">,
    from: Date,
    to: Date,
  ): Promise<FinancialTransactionAggregateBucket[]> {
    const chunks = this.chunkRange(from, to);
    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        this.financialTransactionService.aggregateForBusiness({
          businessId,
          types,
          from: chunk.from,
          to: chunk.to,
        }),
      ),
    );

    const merged = new Map<string, FinancialTransactionAggregateBucket>();
    for (const bucketArr of chunkResults) {
      for (const bucket of bucketArr) {
        const key = `${bucket.type}:${bucket.status}`;
        const existing = merged.get(key);
        if (existing) {
          existing.totalCents += bucket.totalCents;
          existing.count += bucket.count;
        } else {
          merged.set(key, { ...bucket });
        }
      }
    }
    return [...merged.values()];
  }

  private chunkRange(from: Date, to: Date): Array<{ from: Date; to: Date }> {
    const chunkMs = LEDGER_CHUNK_DAYS * 24 * 60 * 60 * 1000;
    const chunks: Array<{ from: Date; to: Date }> = [];
    let cursor = from;
    while (cursor < to) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, to.getTime()));
      chunks.push({ from: cursor, to: chunkEnd });
      cursor = chunkEnd;
    }
    return chunks.length > 0 ? chunks : [{ from, to }];
  }

  private async newCustomersCount(
    businessId: Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<number> {
    const byBusiness = await this.clientRepository.aggregateNewActivationsByBusiness(from, to);
    return byBusiness.get(String(businessId)) ?? 0;
  }

  // --- Small pure helpers ----------------------------------------------------------------------

  private rate(numerator: number, denominator: number): number {
    return denominator > 0 ? numerator / denominator : 0;
  }

  private changePercent(current: number, previous: number): number | null {
    if (previous <= 0) {
      return null;
    }
    return ((current - previous) / previous) * 100;
  }

  /** Mongo's own `$dayOfWeek` (1=Sunday..7=Saturday) re-mapped to this codebase's Monday-first
   * `DayOfWeek` vocabulary (`daysOfWeek`), zero-filled for every weekday even with no bookings
   * (never a sparse list a chart would have to reinterpret — same convention
   * BookingRepository.countCreatedByMonth already uses for its own zero-filled months). */
  private toWeekdayCounts(
    rows: Array<{ mongoDayOfWeek: number; count: number }>,
  ): DashboardAnalytics["busiestDays"] {
    const countByMondayFirstIndex = new Map<number, number>();
    for (const row of rows) {
      const mondayFirstIndex = (row.mongoDayOfWeek + 5) % 7;
      countByMondayFirstIndex.set(mondayFirstIndex, row.count);
    }

    return daysOfWeek.map((dayOfWeek, index) => ({
      dayOfWeek,
      count: countByMondayFirstIndex.get(index) ?? 0,
    }));
  }
}
