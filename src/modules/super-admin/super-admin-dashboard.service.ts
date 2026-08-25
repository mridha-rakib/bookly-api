import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingStatus } from "../booking/booking.types.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessStatus } from "../business/business.types.js";
import type { BusinessPayoutRepository } from "../finance/business-payout.repository.js";
import type { FinanceService } from "../finance/finance.service.js";
import { combineBooklyOwnedBuckets } from "../finance/finance-ownership.js";
import type { UserRepository } from "../user/user.repository.js";

export type SuperAdminDashboardSummaryDto = {
  businesses: Record<BusinessStatus, number> & { total: number };
  customers: { total: number };
  bookings: Record<BookingStatus, number> & { total: number };
  /** All-time Bookly-owned net revenue (PLATFORM_FEE, less Bookly's own PROCESSING_FEE/REFUND
   * share) — same ownership primitives as the Finance tab's own summary
   * (BookingFinancialTransactionService.aggregateAllTimeOwnedBySource +
   * combineBooklyOwnedBuckets), never a separate calculator. */
  platformRevenueCents: number;
  /** All-time, unclaimed Business-owed balance across every Business — the SAME figure
   * `FinanceService.listPendingPayouts` already computes for the Finance tab. */
  pendingBusinessPayableCents: number;
  /** Batch 12 — all-time total of Business payouts already marked PAID — the SAME
   * `BusinessPayoutRepository.sumPaidTotal` primitive the Finance tab's own platform summary
   * (`sentToBusinesses`) already reuses, never a separate calculator. */
  completedPayoutsAllTimeCents: number;
};

/** Batch 11/12 — ONLY the metrics safely derivable from existing real data with existing real
 * primitives (rule #17/#18 — no cohort analysis, no forecasting, no metric invented merely
 * because a prompt mentioned it). Every number here is a server-side aggregate; nothing is
 * summed in React. */
export class SuperAdminDashboardService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly userRepository: UserRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly financeService: FinanceService,
    private readonly businessPayoutRepository: BusinessPayoutRepository,
  ) {}

  public async getSummary(): Promise<SuperAdminDashboardSummaryDto> {
    const [
      businessCounts,
      customerTotal,
      bookingCounts,
      booklyBuckets,
      pendingPayouts,
      paidPayouts,
    ] = await Promise.all([
      this.businessRepository.countByStatus(),
      this.userRepository.countByRole("CUSTOMER"),
      this.bookingRepository.countAllByStatus(),
      this.financialTransactionService.aggregateAllTimeOwnedBySource({
        types: ["PLATFORM_FEE", "PROCESSING_FEE", "REFUND"],
      }),
      this.financeService.listPendingPayouts(),
      this.businessPayoutRepository.sumPaidTotal(),
    ]);

    const bookly = combineBooklyOwnedBuckets(booklyBuckets);

    return {
      businesses: {
        ...businessCounts,
        total:
          businessCounts.PENDING +
          businessCounts.APPROVED +
          businessCounts.WARNING +
          businessCounts.SUSPENDED,
      },
      customers: { total: customerTotal },
      bookings: {
        ...bookingCounts,
        total: Object.values(bookingCounts).reduce((sum, count) => sum + count, 0),
      },
      platformRevenueCents: bookly.netCents,
      pendingBusinessPayableCents: pendingPayouts.totalPendingCents,
      completedPayoutsAllTimeCents: paidPayouts.totalCents,
    };
  }
}
