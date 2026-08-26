import type { BookingCurrency, BookingStatus } from "../booking/booking.types.js";
import type { DayOfWeek } from "../staff/staff-schedule.types.js";

/**
 * The Business Owner dashboard "Analytics" tab's real backend shape — replaces the 100%
 * hardcoded mock data in analyticsMockData.ts/DashboardAnalytics.tsx (see this module's own
 * service-level comment for exactly which existing, already-proven aggregation primitives each
 * field reuses).
 */
export type DashboardAnalyticsPeriod = "MONTH" | "YEAR" | "ALL";

/** The 7 real BookingStatus values the "Bookings by status" panel shows — matches
 * analyticsMockData.ts's own `mockBookingsByStatus` list exactly (UPCOMING/PENDING are
 * deliberately excluded: they are "not yet resolved", not an outcome — see this module's own
 * service-level comment). */
export const ANALYTICS_STATUS_BREAKDOWN_ORDER: readonly BookingStatus[] = [
  "COMPLETED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
  "NO_SHOW_CHARGED",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
];

/** Monday-first (matches `common/time/business-clock.ts`'s own `daysOfWeek`/`DayOfWeek`
 * vocabulary, never Mongo's Sunday-first `$dayOfWeek` convention past the repository
 * boundary). */
export type DashboardAnalyticsWeekdayCount = {
  dayOfWeek: DayOfWeek;
  count: number;
};

export type DashboardAnalyticsTopService = {
  serviceId: string;
  name: string;
  count: number;
};

export type DashboardAnalytics = {
  period: DashboardAnalyticsPeriod;
  currency: BookingCurrency;
  /** The resolved [from, to) window this response was computed over, business-timezone-anchored
   * (see DashboardAnalyticsService.resolvePeriodRange). */
  rangeFrom: Date;
  rangeTo: Date;

  totalBookingsCount: number;
  /** vs the immediately preceding period of the same length — `null` for `ALL` (no meaningful
   * "previous all-time" comparison exists) and `null` whenever the previous period had zero
   * bookings (a percentage against zero is not a real number). */
  totalBookingsChangePercent: number | null;

  /** Real activated Clients of THIS Business within the period (Client.activatedAt — see
   * ClientRepository.aggregateNewActivationsByBusiness's own doc comment: set exactly once, only
   * on a genuinely succeeded activation charge). */
  newCustomersCount: number;
  /** Non-Manual bookings this period whose customer was already activated before this booking
   * (the SAME Manual/New/Returning classification `lib/bookings/format.ts`'s
   * `bookingClientBadge` and BookingRepository.aggregateBusinessBookingStats already use). */
  returningCustomersCount: number;

  /** completedCount / totalCount for the period. */
  completionRate: number;
  /** (NO_SHOW_CHARGED + NO_SHOW_WAIVED) / totalCount for the period — the SAME noShowRate
   * formula SuperAdminBusinessAnalyticsService already uses per-Business. */
  noShowRate: number;
  noShowCount: number;
  /** NO_SHOW_CHARGED only (the subset of `noShowCount` that was actually auto-charged, vs
   * waived) — feeds the "X charged automatically" info line. */
  noShowChargedCount: number;

  /** Ledger-derived (BookingFinancialTransactionService), never `Booking.totalCents`: the
   * average of each BOOKLY_MANAGED booking's own SUCCEEDED upfront collection (DEPOSIT or
   * PLATFORM_FEE — the same "amount already collected online" concept
   * BookingFinancialTransactionService.findSucceededUpfrontPayment already defines) over the
   * count of BOOKLY_MANAGED bookings in the period (MANUAL bookings have no online ledger entry
   * by definition, so they are excluded from the denominator, never counted as €0 bookings). */
  avgBookingValueCents: number;
  /** vs the immediately preceding period of the same length — same `null` rules as
   * `totalBookingsChangePercent`. */
  avgBookingValueChangeCents: number | null;

  /** Ledger-derived: the sum of SUCCEEDED NO_SHOW_FEE + CANCELLATION_FEE entries for the period
   * — gross, not netted against PROCESSING_FEE (matches DashboardOverviewFinancials'
   * `noShowMonthChargedCents` own gross convention, a different card from FinanceService's own
   * netted "Your payout" figure). */
  revenueRecoveredCents: number;

  /** Top 5 Services by booking count, THIS Business only (bounded — never an unbounded list). */
  topServices: DashboardAnalyticsTopService[];

  /** Real per-status counts for the period, in `ANALYTICS_STATUS_BREAKDOWN_ORDER`'s order. */
  bookingsByStatus: Array<{ status: BookingStatus; count: number }>;

  /** Real booking counts (by `schedule.startAt`, business-timezone-bucketed) grouped by weekday
   * for the period — Monday-first, one count per weekday (never a fabricated multi-week grid). */
  busiestDays: DashboardAnalyticsWeekdayCount[];
};
