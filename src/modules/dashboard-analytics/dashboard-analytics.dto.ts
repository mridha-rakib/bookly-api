import type { DashboardAnalytics } from "./dashboard-analytics.types.js";

export const toDashboardAnalyticsDto = (analytics: DashboardAnalytics) => ({
  period: analytics.period,
  currency: analytics.currency,
  range: { from: analytics.rangeFrom.toISOString(), to: analytics.rangeTo.toISOString() },

  totalBookingsCount: analytics.totalBookingsCount,
  totalBookingsChangePercent: analytics.totalBookingsChangePercent,

  newCustomersCount: analytics.newCustomersCount,
  returningCustomersCount: analytics.returningCustomersCount,

  completionRate: analytics.completionRate,
  noShowRate: analytics.noShowRate,
  noShowCount: analytics.noShowCount,
  noShowChargedCount: analytics.noShowChargedCount,

  avgBookingValueCents: analytics.avgBookingValueCents,
  avgBookingValueChangeCents: analytics.avgBookingValueChangeCents,

  revenueRecoveredCents: analytics.revenueRecoveredCents,

  topServices: analytics.topServices,
  bookingsByStatus: analytics.bookingsByStatus,
  busiestDays: analytics.busiestDays,
});
