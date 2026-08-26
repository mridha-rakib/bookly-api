import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessPayoutRepository } from "./business-payout.repository.js";
import { FinanceError } from "./finance.errors.js";
import {
  type BusinessPayableSummary,
  FINANCE_LEDGER_CURRENCY,
  type FinancePayoutHistoryPage,
  type FinanceSummary,
  type FinanceTransactionPage,
  type PendingPayoutsPage,
  type PlatformFinanceSummary,
  type PlatformPayoutHistoryPage,
  type PlatformTransactionPage,
  type PlatformTransactionType,
} from "./finance.types.js";
import {
  BUSINESS_PAYABLE_TYPES,
  classifySourceOwner,
  combineBooklyOwnedBuckets,
  combineBusinessOwnedBuckets,
  groupBucketsByBusiness,
} from "./finance-ownership.js";

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

  // --- Business Owner surface (Batch 7, unchanged scope) -----------------------------------

  /**
   * Business Finance summary — feeds the 4 summary cards (No-show fees / Late cancel fees /
   * Processing fees / Your payout) and the "protected earnings" banner, matching
   * DashboardPayoutsList.tsx/PayoutsBanner.tsx exactly.
   *
   * SCOPE NOTE (deliberate, unchanged since Batch 7 — reconfirmed in Batch 8, Section 16): this
   * figure is fee-recovery only (no-show + late-cancellation charges). It does NOT include a
   * returning customer's routine DEPOSIT revenue — the existing screen has no card for it and
   * this batch does not redesign the UI. Batch 8 activates real payout settlement
   * (BusinessPayoutService) and Payout History (below) DOES correctly include DEPOSIT, since
   * that table has no "fees only" claim in its own copy — see this class's own final-report
   * note on this intentional card-vs-payout-total asymmetry.
   */
  public async getSummary(
    actorUserId: string,
    businessId: string,
    period: { from: Date; to: Date },
  ): Promise<FinanceSummary> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);
    return this.buildSummary(business._id, period);
  }

  public async listTransactions(
    actorUserId: string,
    businessId: string,
    period: { from: Date; to: Date },
    pagination: { page: number; limit: number },
  ): Promise<FinanceTransactionPage> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);
    return this.buildTransactionsPage(business._id, period, pagination);
  }

  public async listPayoutHistory(
    actorUserId: string,
    businessId: string,
    pagination: { page: number; limit: number },
  ): Promise<FinancePayoutHistoryPage> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);
    return this.buildPayoutHistoryPage(business._id, pagination);
  }

  /** The Business's own current true payable balance (gross Business-owned inflows minus
   * Business-borne processing fees/refunds, not yet swept into a payout) — the same formula
   * BusinessPayoutService.executePayout claims against (rule #17: shared primitives). Not
   * currently wired to a Business Owner UI card (none exists for it — see this class's own
   * `getSummary` comment) but exposed here for completeness/future use and for Super Admin's
   * Business Detail Finance tab (see `getBusinessPayableForSuperAdmin`). */
  public async getBusinessPayable(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessPayableSummary> {
    const business = await this.requireOwnedFinanceBusiness(actorUserId, businessId);
    return this.buildBusinessPayable(business);
  }

  // --- Super Admin surface (Batch 8) --------------------------------------------------------
  // No ownership check in any of these — authorization is the SUPER_ADMIN route-level gate
  // (see super-admin.route.ts's own comment); these reuse the EXACT SAME `buildX` core methods
  // as the Business Owner surface above, so the same transaction produces the same result
  // everywhere (rule #17).

  public async getSummaryForSuperAdmin(
    businessId: string,
    period: { from: Date; to: Date },
  ): Promise<FinanceSummary> {
    const business = await this.requireBusiness(businessId);
    return this.buildSummary(business._id, period);
  }

  public async listTransactionsForSuperAdmin(
    businessId: string,
    period: { from: Date; to: Date },
    pagination: { page: number; limit: number },
  ): Promise<FinanceTransactionPage> {
    const business = await this.requireBusiness(businessId);
    return this.buildTransactionsPage(business._id, period, pagination);
  }

  public async listPayoutHistoryForSuperAdmin(
    businessId: string,
    pagination: { page: number; limit: number },
  ): Promise<FinancePayoutHistoryPage> {
    const business = await this.requireBusiness(businessId);
    return this.buildPayoutHistoryPage(business._id, pagination);
  }

  public async getBusinessPayableForSuperAdmin(
    businessId: string,
  ): Promise<BusinessPayableSummary> {
    const business = await this.requireBusiness(businessId);
    return this.buildBusinessPayable(business);
  }

  /** Platform-wide summary — Bookly's own net revenue, total collected for Businesses, total
   * already sent, and the current accumulated pending payout balance (rule #6: never date-
   * filtered — see PlatformFinanceSummary's own doc comment). Feeds SuperAdminFinanceBanner /
   * SuperAdminFinanceStats. */
  public async getPlatformSummary(period: {
    from: Date;
    to: Date;
  }): Promise<PlatformFinanceSummary> {
    const periodBuckets = await this.financialTransactionService.aggregateOwnedBySource({
      types: ["PLATFORM_FEE", "NO_SHOW_FEE", "CANCELLATION_FEE", "PROCESSING_FEE", "REFUND"],
      unclaimedOnly: false,
      from: period.from,
      to: period.to,
    });

    const bookly = combineBooklyOwnedBuckets(periodBuckets);
    const noShow = periodBuckets.find((b) => b.type === "NO_SHOW_FEE")?.totalCents ?? 0;
    const cancellation = periodBuckets.find((b) => b.type === "CANCELLATION_FEE")?.totalCents ?? 0;

    const [{ totalCents: sentCents, count: payoutCount }, pendingBuckets, allTimeBuckets] =
      await Promise.all([
        this.businessPayoutRepository.sumPaidTotal(),
        this.financialTransactionService.aggregateOwnedBySource({
          types: [...BUSINESS_PAYABLE_TYPES],
          unclaimedOnly: true,
          groupByBusiness: true,
        }),
        this.financialTransactionService.aggregateAllTimeOwnedBySource({
          types: ["NO_SHOW_FEE", "CANCELLATION_FEE"],
        }),
      ]);
    const protectedEarningsAllTimeCents = allTimeBuckets.reduce(
      (sum, bucket) => sum + bucket.totalCents,
      0,
    );

    const perBusiness = groupBucketsByBusiness(pendingBuckets);
    let pendingTotalCents = 0;
    let pendingBusinessCount = 0;
    for (const buckets of perBusiness.values()) {
      const net = combineBusinessOwnedBuckets(buckets).netCents;
      if (net > 0) {
        pendingTotalCents += net;
        pendingBusinessCount += 1;
      }
    }

    return {
      currency: FINANCE_LEDGER_CURRENCY,
      period,
      bookly,
      collectedForBusinesses: {
        amountCents: noShow + cancellation,
        noShowAmountCents: noShow,
        cancellationAmountCents: cancellation,
      },
      sentToBusinesses: { amountCents: sentCents, payoutCount },
      pendingPayouts: { amountCents: pendingTotalCents, businessCount: pendingBusinessCount },
      protectedEarningsAllTimeCents,
    };
  }

  /** The per-Business pending-payout list — SuperAdminFinancePending's rows, and the source of
   * the platform summary's `pendingPayouts` total above. Always the FULL accumulated balance —
   * see PendingPayoutsPage's own doc comment on why this is never date-filtered (rule #6). ONE
   * aggregation query, then batched Business lookups (rule #20: no N+1). */
  public async listPendingPayouts(): Promise<PendingPayoutsPage> {
    const buckets = await this.financialTransactionService.aggregateOwnedBySource({
      types: [...BUSINESS_PAYABLE_TYPES],
      unclaimedOnly: true,
      groupByBusiness: true,
    });

    const perBusiness = groupBucketsByBusiness(buckets);
    const businessIds = [...perBusiness.keys()];
    const businesses = await this.businessRepository.findManyByIds(businessIds);
    const businessById = new Map(businesses.map((b) => [String(b._id), b]));

    const items: BusinessPayableSummary[] = [];
    let totalPendingCents = 0;

    for (const [businessId, businessBuckets] of perBusiness) {
      const totals = combineBusinessOwnedBuckets(businessBuckets);
      if (totals.netCents <= 0) {
        continue;
      }
      const business = businessById.get(businessId);
      items.push({
        businessId,
        businessName: business?.name ?? "Unknown business",
        city: business?.address.city ?? "",
        category: business?.category ?? "",
        grossCents: totals.grossCents,
        processingFeesCents: totals.processingFeesCents,
        refundsCents: totals.refundsCents,
        netCents: totals.netCents,
        transactionCount: businessBuckets.reduce((sum, b) => sum + b.count, 0),
        noShowAmountCents: businessBuckets.find((b) => b.type === "NO_SHOW_FEE")?.totalCents ?? 0,
        cancellationAmountCents:
          businessBuckets.find((b) => b.type === "CANCELLATION_FEE")?.totalCents ?? 0,
        depositAmountCents: businessBuckets.find((b) => b.type === "DEPOSIT")?.totalCents ?? 0,
        promoSubsidyAmountCents: totals.promoSubsidyCents,
      });
      totalPendingCents += totals.netCents;
    }

    items.sort((a, b) => b.netCents - a.netCents);

    return { items, totalPendingCents, businessCount: items.length };
  }

  /** Super Admin Finance Log — platform-wide paginated transaction read across the 4 types the
   * existing UI's own `feeType` union supports (NO_SHOW_FEE/CANCELLATION_FEE/PLATFORM_FEE/
   * REFUND — see SuperAdminFinanceLog.tsx's own `TransactionItem.feeType`; DEPOSIT rows are not
   * part of this screen's contract). Batched Booking+Business lookups, never N+1. */
  public async listPlatformTransactions(
    period: { from: Date; to: Date },
    pagination: { page: number; limit: number },
    types?: PlatformTransactionType[],
  ): Promise<PlatformTransactionPage> {
    const { rows, total } = await this.financialTransactionService.listGlobalPage({
      types: types ?? ["NO_SHOW_FEE", "CANCELLATION_FEE", "PLATFORM_FEE", "REFUND"],
      from: period.from,
      to: period.to,
      page: pagination.page,
      limit: pagination.limit,
    });

    const bookingIds = [...new Set(rows.map((r) => String(r.bookingId)))];
    const businessIds = [...new Set(rows.map((r) => String(r.businessId)))];
    const [bookings, businesses] = await Promise.all([
      this.bookingRepository.findManyByIdsCrossBusiness(bookingIds),
      this.businessRepository.findManyByIds(businessIds),
    ]);
    const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
    const businessById = new Map(businesses.map((b) => [String(b._id), b]));

    return {
      total,
      rows: rows.map((entry) => this.toPlatformTransactionRow(entry, bookingById, businessById)),
    };
  }

  /** Super Admin Finance — global payout history ("SEPA sent" view), newest first. */
  public async listPlatformPayoutHistory(pagination: {
    page: number;
    limit: number;
  }): Promise<PlatformPayoutHistoryPage> {
    const { items, total } = await this.businessPayoutRepository.listAll(pagination);
    const businessIds = [...new Set(items.map((item) => String(item.businessId)))];
    const businesses = await this.businessRepository.findManyByIds(businessIds);
    const businessById = new Map(businesses.map((b) => [String(b._id), b]));

    return {
      total,
      items: items.map((item) => ({
        id: String(item._id),
        businessId: String(item.businessId),
        businessName: businessById.get(String(item.businessId))?.name ?? "Unknown business",
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

  // --- Dashboard Overview surface -----------------------------------------------------------
  // No actor-ownership check here (unlike getSummary above) — same "authorization already
  // happened, just resolve+compute" contract as the Super Admin surface further up. The caller
  // (DashboardOverviewService) independently re-derives the actor's own Owner-or-Supervisor
  // access to this businessId before ever calling this, mirroring
  // BookingService.requireBookingManagementAccess's own precedent of a broader-than-Finance
  // authorization surface reusing this same shared `buildSummary` core (rule #17: never a second,
  // independently-invented revenue formula).

  /** Dashboard Overview's "Monthly revenue" card — reuses the EXACT SAME net-payout computation
   * as the Business Owner/Super Admin Finance summary (`buildSummary`), scoped to whatever
   * period the caller passes (Dashboard Overview passes the current calendar month). Does not
   * alter `getSummary`'s existing all-time-capable Payouts tab behavior in any way — purely
   * additive. */
  public async getNetPayoutForBusiness(
    businessId: string,
    period: { from: Date; to: Date },
  ): Promise<number> {
    const business = await this.requireBusiness(businessId);
    const summary = await this.buildSummary(business._id, period);
    return summary.netPayoutCents;
  }

  // --- Shared core (used by both Owner-facing and Super-Admin-facing methods above) --------

  private async buildSummary(
    businessId: BusinessDocument["_id"],
    period: { from: Date; to: Date },
  ): Promise<FinanceSummary> {
    const buckets = await this.financialTransactionService.aggregateForBusiness({
      businessId,
      types: ["NO_SHOW_FEE", "CANCELLATION_FEE", "PROCESSING_FEE"],
      from: period.from,
      to: period.to,
    });

    const noShowFees = this.sumBucket(buckets, "NO_SHOW_FEE", "SUCCEEDED");
    const lateCancellationFees = this.sumBucket(buckets, "CANCELLATION_FEE", "SUCCEEDED");
    const processingFeesCents = this.sumBucket(buckets, "PROCESSING_FEE", "SUCCEEDED").amountCents;

    const protectedEarningsAllTimeCents =
      await this.financialTransactionService.sumAllTimeForBusiness({
        businessId,
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

  private async buildTransactionsPage(
    businessId: BusinessDocument["_id"],
    period: { from: Date; to: Date },
    pagination: { page: number; limit: number },
  ): Promise<FinanceTransactionPage> {
    const { rows, total } = await this.financialTransactionService.listFeeTransactionsPage({
      businessId,
      types: [...FEE_RECOVERY_TYPES],
      from: period.from,
      to: period.to,
      page: pagination.page,
      limit: pagination.limit,
    });

    const bookingIds = [...new Set(rows.map((row) => String(row.bookingId)))];
    const bookings = await this.bookingRepository.findManyByIds(businessId, bookingIds);
    const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));

    return {
      total,
      rows: rows.map((entry) =>
        this.toTransactionRow(entry, bookingById.get(String(entry.bookingId))),
      ),
    };
  }

  private async buildPayoutHistoryPage(
    businessId: BusinessDocument["_id"],
    pagination: { page: number; limit: number },
  ): Promise<FinancePayoutHistoryPage> {
    const { items, total } = await this.businessPayoutRepository.listByBusinessId({
      businessId,
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

  private async buildBusinessPayable(business: BusinessDocument): Promise<BusinessPayableSummary> {
    const entries = await this.financialTransactionService.findUnclaimedForPayout(business._id, [
      ...BUSINESS_PAYABLE_TYPES,
    ]);

    let grossCents = 0;
    let processingFeesCents = 0;
    let refundsCents = 0;
    let noShowAmountCents = 0;
    let cancellationAmountCents = 0;
    let depositAmountCents = 0;
    let promoSubsidyAmountCents = 0;

    for (const entry of entries) {
      if (entry.type === "NO_SHOW_FEE") {
        grossCents += entry.amountCents;
        noShowAmountCents += entry.amountCents;
      } else if (entry.type === "CANCELLATION_FEE") {
        grossCents += entry.amountCents;
        cancellationAmountCents += entry.amountCents;
      } else if (entry.type === "DEPOSIT") {
        grossCents += entry.amountCents;
        depositAmountCents += entry.amountCents;
      } else if (entry.type === "PROMO_SUBSIDY") {
        // Batch 13 — always Business-owned by construction (never `sourceType`-classified —
        // see finance-ownership.ts's own comment on why this differs from PROCESSING_FEE/REFUND).
        grossCents += entry.amountCents;
        promoSubsidyAmountCents += entry.amountCents;
      } else if (entry.type === "PROCESSING_FEE" || entry.type === "REFUND") {
        const sourceType = (entry.metadata?.["sourceType"] as string | undefined) ?? null;
        if (classifySourceOwner(sourceType) === "BUSINESS") {
          if (entry.type === "PROCESSING_FEE") {
            processingFeesCents += entry.amountCents;
          } else {
            refundsCents += entry.amountCents;
          }
        }
      }
    }

    return {
      businessId: String(business._id),
      businessName: business.name,
      city: business.address.city,
      category: business.category,
      grossCents,
      processingFeesCents,
      refundsCents,
      netCents: grossCents - processingFeesCents - refundsCents,
      transactionCount: entries.length,
      noShowAmountCents,
      cancellationAmountCents,
      depositAmountCents,
      promoSubsidyAmountCents,
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

  private toPlatformTransactionRow(
    entry: BookingFinancialTransactionDocument,
    bookingById: Map<string, BookingDocument>,
    businessById: Map<string, BusinessDocument>,
  ): PlatformTransactionPage["rows"][number] {
    const booking = bookingById.get(String(entry.bookingId));
    const business = businessById.get(String(entry.businessId));
    const owner: "BOOKLY" | "BUSINESS" | "CUSTOMER" =
      entry.type === "PLATFORM_FEE" ? "BOOKLY" : entry.type === "REFUND" ? "CUSTOMER" : "BUSINESS";

    return {
      id: String(entry._id),
      businessId: String(entry.businessId),
      businessName: business?.name ?? "Unknown business",
      bookingId: String(entry.bookingId),
      bookingReference: booking?.reference ?? "—",
      customerName: booking
        ? [booking.customer.contact.firstName, booking.customer.contact.lastName]
            .filter(Boolean)
            .join(" ")
        : "Unknown customer",
      type: entry.type as PlatformTransactionType,
      createdAt: entry.createdAt,
      grossCents: entry.amountCents,
      stripeFeeCents: 0,
      netCents: entry.status === "SUCCEEDED" ? entry.amountCents : 0,
      owner,
      status: entry.status as "SUCCEEDED" | "FAILED" | "WAIVED" | "PENDING",
      payoutId: entry.payoutId ? String(entry.payoutId) : undefined,
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
   * Finance authorization (Section 28/22): OWNER-ONLY for the Business-facing methods above,
   * deliberately narrower than Booking management (which allows Owner + Supervisor — see
   * BookingService.requireBookingManagementAccess). There is no canonical product rule granting
   * Supervisor financial access, and Finance is more sensitive than day-to-day booking
   * operations, so this follows the exact precedent business.route.ts already established for
   * Business Profile/Staff/Travel-Settings/etc. Mirrors StaffService.requireOwnedStaffBusiness
   * exactly: ownership via `Business.ownerUserId` only, never a linked/secondary BusinessAccess
   * grant, and a 404 (never a bare 403) on every mismatch.
   */
  private async requireOwnedFinanceBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
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
