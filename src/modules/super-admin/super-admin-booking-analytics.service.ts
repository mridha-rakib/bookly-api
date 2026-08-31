import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingStatus } from "../booking/booking.types.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { combineBooklyOwnedBuckets } from "../finance/finance-ownership.js";
import {
  aggregateOwnershipForPeriod,
  resolveAnalyticsPeriod,
  resolveSeriesWindow,
} from "./super-admin-analytics.util.js";

export type SuperAdminBookingAnalyticsDto = {
  period: { from: string; to: string };
  totalCount: number;
  statusCounts: Record<BookingStatus, number>;
  /** createdAt-bucketed, zero-filled per month in range — see BookingRepository.countCreatedByMonth. */
  monthlySeries: Array<{ year: number; month: number; count: number }>;
  /** The SAME Manual/New/Returning classification lib/bookings/format.ts's bookingClientBadge
   * already uses on the frontend — never a fourth vocabulary invented here. */
  clientTypeSplit: { manual: number; newBooking: number; returning: number };
  fulfilmentSplit: { premises: number; mobile: number };
  /** Bookly's own net PLATFORM_FEE revenue FOR THIS PERIOD — reuses the exact same ownership
   * primitives as the Finance tab (aggregateOwnedBySource + combineBooklyOwnedBuckets), never a
   * separate calculator. Explicitly period-bound, unlike the Dashboard's all-time figure. */
  platformRevenueCents: number;
  /** "Booking by category" from the old mock UI has no backend equivalent: a Booking's
   * serviceLines snapshot the service NAME, pricing mode, and duration at booking time, but never
   * a category — so a category breakdown would require a live join to the (possibly archived)
   * Service, which could silently misrepresent history. Reported, not fabricated. */
  categoryBreakdownUnsupported: true;
};

/** Batch 12 — Super Admin Booking Analytics. Every count is a bounded, server-side aggregation
 * over BookingModel; booking-creation metrics use `createdAt` (never `schedule.startAt`, which is
 * "when the appointment happens", a different question). */
export class SuperAdminBookingAnalyticsService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
  ) {}

  public async getAnalytics(query: {
    fromDate?: Date | undefined;
    toDate?: Date | undefined;
  }): Promise<SuperAdminBookingAnalyticsDto> {
    const period = resolveAnalyticsPeriod(query);
    const { from, to } = period;
    const series = resolveSeriesWindow(period);

    const [statusCounts, monthlySeries, clientTypeSplit, fulfilmentSplit, revenueBuckets] =
      await Promise.all([
        this.bookingRepository.countByStatusInRange(from, to),
        this.bookingRepository.countCreatedByMonth(series.from, series.to),
        this.bookingRepository.aggregateClientTypeSplit(from, to),
        this.bookingRepository.aggregateFulfilmentSplit(from, to),
        aggregateOwnershipForPeriod(this.financialTransactionService, {
          types: ["PLATFORM_FEE", "PROCESSING_FEE", "REFUND"],
          period,
        }),
      ]);

    const bookly = combineBooklyOwnedBuckets(revenueBuckets);
    const totalCount = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totalCount,
      statusCounts,
      monthlySeries,
      clientTypeSplit,
      fulfilmentSplit,
      platformRevenueCents: bookly.netCents,
      categoryBreakdownUnsupported: true,
    };
  }
}
