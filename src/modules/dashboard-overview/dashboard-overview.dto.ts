import type {
  DashboardOverview,
  DashboardOverviewActivityEntry,
} from "./dashboard-overview.types.js";

const toActivityEntryDto = (entry: DashboardOverviewActivityEntry) => ({
  id: entry.id,
  type: entry.type,
  status: entry.status,
  amountCents: entry.amountCents,
  currency: entry.currency,
  customerName: entry.customerName,
  serviceName: entry.serviceName,
  bookingReference: entry.bookingReference,
  createdAt: entry.createdAt.toISOString(),
});

export const toDashboardOverviewDto = (overview: DashboardOverview) => ({
  scope: overview.scope,
  currency: overview.currency,
  todayDateStr: overview.todayDateStr,
  todayBookingsCount: overview.todayBookingsCount,
  todayRemainingCount: overview.todayRemainingCount,
  schedule: overview.schedule,
  timeline: overview.timeline,
  financials: overview.financials
    ? {
        payAtVenueDueCents: overview.financials.payAtVenueDueCents,
        noShowMonthCount: overview.financials.noShowMonthCount,
        noShowMonthChargedCents: overview.financials.noShowMonthChargedCents,
        monthlyRevenueCents: overview.financials.monthlyRevenueCents,
        recentActivity: overview.financials.recentActivity.map(toActivityEntryDto),
      }
    : null,
});
