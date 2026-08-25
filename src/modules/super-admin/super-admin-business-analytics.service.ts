import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessStatus } from "../business/business.types.js";
import type { ClientRepository } from "../client/client.repository.js";
import { combineBooklyOwnedBuckets, groupBucketsByBusiness } from "../finance/finance-ownership.js";
import { resolveAnalyticsPeriod } from "./super-admin-analytics.util.js";

export type SuperAdminTopBusinessRow = {
  businessId: string;
  name: string;
  city: string;
  bookingsCount: number;
  newCustomersCount: number;
  /** Bookly's own PLATFORM_FEE net revenue attributed to this Business — reuses the exact same
   * ownership primitives as Business Detail's own Finance tab (aggregateOwnedBySource with
   * groupByBusiness + combineBooklyOwnedBuckets), never booking.totalCents as a stand-in. */
  bookyRevenueCents: number;
  /** noShowCount / totalCount for the period — NO_SHOW_CHARGED + NO_SHOW_WAIVED only (a
   * NO_SHOW_CANCELLED means the no-show flow was reversed, so it is not counted as one). */
  noShowRate: number;
  /** Non-Manual bookings with platformFeeCents=0 (returning) / all non-Manual bookings — the
   * SAME New/Returning classification the platform-wide split uses, just grouped per Business. */
  returnRate: number | null;
};

export type SuperAdminBusinessAnalyticsDto = {
  period: { from: string; to: string };
  createdOverTime: Array<{ year: number; month: number; count: number }>;
  statusCounts: Record<BusinessStatus, number> & { total: number };
  topByBookings: SuperAdminTopBusinessRow[];
  topByNewCustomers: SuperAdminTopBusinessRow[];
  topByRevenue: SuperAdminTopBusinessRow[];
};

const TOP_N = 5;

/** Batch 12 — Super Admin Business Analytics. Revenue-by-business reuses the exact shared
 * ownership primitives from finance-ownership.ts (rule: "never calculate financial ownership
 * independently inside a new Analytics service") — the SAME aggregateOwnedBySource +
 * groupBucketsByBusiness + combineBooklyOwnedBuckets pipeline Super Admin Finance's own
 * pending-payout list already uses. */
export class SuperAdminBusinessAnalyticsService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly clientRepository: ClientRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
  ) {}

  public async getAnalytics(query: {
    fromDate?: Date | undefined;
    toDate?: Date | undefined;
  }): Promise<SuperAdminBusinessAnalyticsDto> {
    const { from, to } = resolveAnalyticsPeriod(query);

    const [createdOverTime, statusCounts, bookingStats, newCustomersByBusiness, revenueBuckets] =
      await Promise.all([
        this.businessRepository.countCreatedByMonth(from, to),
        this.businessRepository.countByStatus(),
        this.bookingRepository.aggregateBusinessBookingStats(from, to),
        this.clientRepository.aggregateNewActivationsByBusiness(from, to),
        this.financialTransactionService.aggregateOwnedBySource({
          types: ["PLATFORM_FEE", "PROCESSING_FEE", "REFUND"],
          unclaimedOnly: false,
          from,
          to,
          groupByBusiness: true,
        }),
      ]);

    const revenueByBusiness = groupBucketsByBusiness(revenueBuckets);
    const businessIds = new Set<string>([
      ...bookingStats.map((row) => row.businessId),
      ...newCustomersByBusiness.keys(),
      ...revenueByBusiness.keys(),
    ]);
    const businesses = await this.businessRepository.findManyByIds([...businessIds]);
    const businessById = new Map(businesses.map((b) => [String(b._id), b]));

    const rows: SuperAdminTopBusinessRow[] = [...businessIds].map((businessId) => {
      const stats = bookingStats.find((row) => row.businessId === businessId);
      const business = businessById.get(businessId);
      const nonManualCount = (stats?.newCount ?? 0) + (stats?.returningCount ?? 0);
      const revenue = revenueByBusiness.get(businessId);

      return {
        businessId,
        name: business?.name ?? "—",
        city: business?.address.city ?? "—",
        bookingsCount: stats?.totalCount ?? 0,
        newCustomersCount: newCustomersByBusiness.get(businessId) ?? 0,
        bookyRevenueCents: revenue ? combineBooklyOwnedBuckets(revenue).netCents : 0,
        noShowRate: stats && stats.totalCount > 0 ? stats.noShowCount / stats.totalCount : 0,
        returnRate: nonManualCount > 0 ? (stats?.returningCount ?? 0) / nonManualCount : null,
      };
    });

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      createdOverTime,
      statusCounts: {
        ...statusCounts,
        total:
          statusCounts.PENDING +
          statusCounts.APPROVED +
          statusCounts.WARNING +
          statusCounts.SUSPENDED,
      },
      topByBookings: [...rows].sort((a, b) => b.bookingsCount - a.bookingsCount).slice(0, TOP_N),
      topByNewCustomers: [...rows]
        .sort((a, b) => b.newCustomersCount - a.newCustomersCount)
        .slice(0, TOP_N),
      topByRevenue: [...rows]
        .sort((a, b) => b.bookyRevenueCents - a.bookyRevenueCents)
        .slice(0, TOP_N),
    };
  }
}
