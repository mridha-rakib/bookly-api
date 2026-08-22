import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessPayoutRepository } from "./business-payout.repository.js";
import { FinanceError } from "./finance.errors.js";
import {
  FINANCE_LEDGER_CURRENCY,
  type FinancePayoutHistoryPage,
  type FinanceSummary,
  type FinanceTransactionPage,
} from "./finance.types.js";

/** The ledger types the current Payouts & Finance UI actually displays — see
 * DashboardPayoutsList/PayoutsBreakdown/PayoutsHistory's own investigation notes (Batch 7
 * report): "No-show fees", "Late cancel fees", "Processing fees", "Your payout". Deliberately
 * excludes PLATFORM_FEE (Bookly revenue, never shown here), DEPOSIT (real Business-owned money
 * from routine, non-cancelled bookings — but this screen has no card for it; see this class's
 * own comment on `getSummary`), and REFUND (the one existing refund path never reverses these
 * two fee types — see finance.types.ts's own ownership-matrix comment). */
const FEE_RECOVERY_TYPES = ["NO_SHOW_FEE", "CANCELLATION_FEE"] as const;

export class FinanceService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly bookingRepository: BookingRepository,
    private readonly businessPayoutRepository: BusinessPayoutRepository,
  ) {}

  /**
   * Business Finance summary — feeds the 4 summary cards (No-show fees / Late cancel fees /
   * Processing fees / Your payout) and the "protected earnings" banner, matching
   * DashboardPayoutsList.tsx/PayoutsBanner.tsx exactly (Batch 7, Section 16: "match the actual
   * frontend, not the brief's example shape").
   *
   * SCOPE NOTE (deliberate, reported in the Batch 7 final report): this figure is fee-recovery
   * only (no-show + late-cancellation charges), matching what the CURRENT UI actually shows —
   * it does NOT include a returning customer's routine DEPOSIT revenue from normally-completed
   * bookings, even though that money is real and Business-owned (rule #6). The existing screen
   * has no card for it and this batch does not redesign the UI (rule #15). That aggregation is
   * still available as a reusable primitive
   * (BookingFinancialTransactionService.aggregateForBusiness with `types: ["DEPOSIT"]`) for a
   * future UI iteration or Super Admin use (rule #19) — it is simply not wired into this DTO.
   */
  public async getSummary(
    actorUserId: string,
    businessId: string,
    period: { from: Date; to: Date },
  ): Promise<FinanceSummary> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);

    const buckets = await this.financialTransactionService.aggregateForBusiness({
      businessId: business._id,
      types: ["NO_SHOW_FEE", "CANCELLATION_FEE", "PROCESSING_FEE"],
      from: period.from,
      to: period.to,
    });

    const noShowFees = this.sumBucket(buckets, "NO_SHOW_FEE", "SUCCEEDED");
    const lateCancellationFees = this.sumBucket(buckets, "CANCELLATION_FEE", "SUCCEEDED");
    const processingFeesCents = this.sumBucket(buckets, "PROCESSING_FEE", "SUCCEEDED").amountCents;

    const protectedEarningsAllTimeCents =
      await this.financialTransactionService.sumAllTimeForBusiness({
        businessId: business._id,
        types: [...FEE_RECOVERY_TYPES],
        status: "SUCCEEDED",
      });

    return {
      currency: FINANCE_LEDGER_CURRENCY,
      period,
      noShowFees,
      lateCancellationFees,
      processingFees: { amountCents: processingFeesCents },
      netPayoutCents:
        noShowFees.amountCents + lateCancellationFees.amountCents - processingFeesCents,
      protectedEarningsAllTimeCents,
    };
  }

  /** The transaction-breakdown table — one row per NO_SHOW_FEE/CANCELLATION_FEE ledger entry,
   * with a single batched Booking lookup (never N+1 — rule #17/#22 of the brief) for the
   * booking reference and customer summary each row needs. */
  public async listTransactions(
    actorUserId: string,
    businessId: string,
    period: { from: Date; to: Date },
    pagination: { page: number; limit: number },
  ): Promise<FinanceTransactionPage> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);

    const { rows, total } = await this.financialTransactionService.listFeeTransactionsPage({
      businessId: business._id,
      types: [...FEE_RECOVERY_TYPES],
      from: period.from,
      to: period.to,
      page: pagination.page,
      limit: pagination.limit,
    });

    const bookingIds = [...new Set(rows.map((row) => String(row.bookingId)))];
    const bookings = await this.bookingRepository.findManyByIds(business._id, bookingIds);
    const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));

    return {
      total,
      rows: rows.map((entry) =>
        this.toTransactionRow(entry, bookingById.get(String(entry.bookingId))),
      ),
    };
  }

  /** Payout history — see business-payout.model.ts's own doc comment: this reads real
   * BusinessPayout records only. No real payout-execution process exists in this codebase yet,
   * so this returns an honest empty page for every Business today rather than fabricating
   * "Paid" rows from collected transactions (rule #18). */
  public async listPayoutHistory(
    actorUserId: string,
    businessId: string,
    pagination: { page: number; limit: number },
  ): Promise<FinancePayoutHistoryPage> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);

    const { items, total } = await this.businessPayoutRepository.listByBusinessId({
      businessId: business._id,
      page: pagination.page,
      limit: pagination.limit,
    });

    return {
      total,
      items: items.map((item) => ({
        id: String(item._id),
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        grossBusinessOwnedCents: item.grossBusinessOwnedCents,
        processingFeesCents: item.processingFeesCents,
        netPayoutCents: item.netPayoutCents,
        currency: item.currency,
        status: item.status,
        paidAt: item.paidAt,
        providerReference: item.providerReference,
      })),
    };
  }

  private toTransactionRow(
    entry: BookingFinancialTransactionDocument,
    booking: BookingDocument | undefined,
  ): FinanceTransactionPage["rows"][number] {
    const isFirstBooking = (booking?.financials.platformFeeCents ?? 0) > 0;
    const businessOwnedCents = entry.status === "SUCCEEDED" ? entry.amountCents : 0;

    return {
      id: String(entry._id),
      bookingId: String(entry.bookingId),
      bookingReference: booking?.reference ?? "—",
      customerName: booking
        ? [booking.customer.contact.firstName, booking.customer.contact.lastName]
            .filter(Boolean)
            .join(" ")
        : "Unknown customer",
      customerType: isFirstBooking ? "FIRST_BOOKING" : "RETURNING",
      type: entry.type as "NO_SHOW_FEE" | "CANCELLATION_FEE",
      createdAt: entry.createdAt,
      amountCents: entry.amountCents,
      businessOwnedCents,
      status: entry.status as "SUCCEEDED" | "FAILED" | "WAIVED" | "PENDING",
      currency: entry.currency,
    };
  }

  private sumBucket(
    buckets: Array<{ type: string; status: string; totalCents: number; count: number }>,
    type: string,
    status: string,
  ): { amountCents: number; count: number } {
    const bucket = buckets.find((entry) => entry.type === type && entry.status === status);
    return { amountCents: bucket?.totalCents ?? 0, count: bucket?.count ?? 0 };
  }

  /**
   * Finance authorization (Batch 7, Section 28): OWNER-ONLY, deliberately narrower than Booking
   * management (which allows Owner + Supervisor — see BookingService.requireBookingManagementAccess).
   * There is no canonical product rule granting Supervisor financial access, and Finance is more
   * sensitive than day-to-day booking operations, so this follows the exact precedent
   * business.route.ts already established for Business Profile/Staff/Travel-Settings/etc.
   * ("Business Profile is a Business Owner surface only") — mirrors
   * StaffService.requireOwnedStaffBusiness exactly: ownership via `Business.ownerUserId` only,
   * never a linked/secondary BusinessAccess grant, and a 404 (never a bare 403) on every
   * mismatch so a forged businessId can never be distinguished from one that doesn't exist
   * (anti-enumeration, matching every other management surface in this codebase).
   */
  private async requireOwnedFinanceBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private requireValidObjectId(value: string): void {
    if (!/^[a-f\d]{24}$/i.test(value)) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }
  }
}
