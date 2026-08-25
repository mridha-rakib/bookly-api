import type { BookingCurrency } from "../booking/booking.types.js";
import type { BusinessPayoutStatus } from "./business-payout.model.js";

/**
 * The Business/Bookly Finance ownership matrix — Batch 7 established the base rules; Batch 8
 * CORRECTED the PROCESSING_FEE rule (previously always Business-borne) and activated DEPOSIT/
 * REFUND settlement. Every rule reuses the Batch 6.5 invariant: a BOOKLY_MANAGED booking's
 * upfront online charge is EXACTLY ONE of PLATFORM_FEE (first booking, Bookly-owned) or DEPOSIT
 * (returning booking, Business-owned) — see booking-financial-transaction.types.ts.
 *
 *   PLATFORM_FEE      — Bookly revenue. NEVER Business payable.
 *   DEPOSIT           — Business-owned prepayment, held by Bookly until a manual Super Admin
 *                        payout (Batch 8 — see BusinessPayoutService). Enters the Business's
 *                        payable balance; the existing Payouts & Finance UI has no dedicated
 *                        card for it (see FinanceService.getSummary's own comment on why the
 *                        4 fee-recovery cards stay unchanged), but Payout History/the true
 *                        payable balance correctly include it.
 *   CANCELLATION_FEE  — the incremental amount charged beyond the deposit already held for a
 *                        cancellation (BookingLifecycleService.executeCancellationFeeCharge).
 *                        100% Business-owned when SUCCEEDED: Bookly's cut (if any) was already
 *                        taken earlier via that booking's own PLATFORM_FEE entry, not via this
 *                        fee. WAIVED/FAILED/PENDING contribute €0.
 *   NO_SHOW_FEE       — the same shape as CANCELLATION_FEE, for a no-show
 *                        (NoShowResolutionService.autoResolve / BookingLifecycleService.waiveFee).
 *   REFUND            — reverses whichever party owned the ORIGINAL payment being refunded (see
 *                        finance-ownership.ts's `classifySourceOwner`, keyed off the REFUND
 *                        entry's own `metadata.sourceType`, recorded at the moment it's written
 *                        — never inferred from date/amount). A PLATFORM_FEE refund reduces
 *                        Bookly's revenue; a DEPOSIT refund reduces the Business's payable. A
 *                        COMPENSATION refund (a booking-creation charge whose own ledger entry
 *                        never durably persisted) is excluded from BOTH totals — see
 *                        BookingCreationService.compensateFailedBookingAfterPayment's own
 *                        comment.
 *   PROCESSING_FEE    — BATCH 8 CORRECTION: the OWNER OF THE UNDERLYING PAYMENT bears its Stripe
 *                        processing fee, not "always the Business" as Batch 7 assumed. A
 *                        PLATFORM_FEE's processing fee reduces Bookly's net revenue; a
 *                        DEPOSIT/CANCELLATION_FEE/NO_SHOW_FEE's processing fee reduces the
 *                        Business's payable. Attribution is via `metadata.sourceType`/
 *                        `sourceTransactionId`, recorded when the fee is captured (see
 *                        StripeWebhookService.recordProcessingFee) — never guessed.
 *   BUSINESS_PAYOUT   — the ledger's own CREDIT type for "money left the collected pool" is NOT
 *                        used for real payouts (see BusinessPayout's own doc comment on why a
 *                        separate collection exists instead) — reserved for a future use, unused
 *                        by this batch.
 *   WAIVED (status)   — an honest €0: never counted as collected, Business-owned, or Bookly
 *                        revenue, regardless of type.
 *
 * "Payable" vs "payout-eligible balance" (Batch 8): a Business-owned SUCCEEDED entry contributes
 * to the payable balance until its `payoutId` is set (see the ledger model's own doc comment) —
 * date is NEVER used to decide whether something was already paid (rule #6).
 */
export const FINANCE_LEDGER_CURRENCY: BookingCurrency = "EUR";

export type FinancePeriod = { from: Date; to: Date };

export type FinanceFeeBucket = { amountCents: number; count: number };

export type FinanceSummary = {
  currency: BookingCurrency;
  period: { from: Date; to: Date };
  noShowFees: FinanceFeeBucket;
  lateCancellationFees: FinanceFeeBucket;
  processingFees: { amountCents: number };
  netPayoutCents: number;
  protectedEarningsAllTimeCents: number;
};

export type FinanceTransactionType = "NO_SHOW_FEE" | "CANCELLATION_FEE";
export type FinanceTransactionStatus = "SUCCEEDED" | "FAILED" | "WAIVED" | "PENDING";
export type FinanceCustomerType = "FIRST_BOOKING" | "RETURNING";

export type FinanceTransactionRow = {
  id: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  customerType: FinanceCustomerType;
  type: FinanceTransactionType;
  createdAt: Date;
  amountCents: number;
  businessOwnedCents: number;
  status: FinanceTransactionStatus;
  currency: BookingCurrency;
};

export type FinanceTransactionPage = {
  rows: FinanceTransactionRow[];
  total: number;
};

export type FinancePayoutHistoryItem = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  grossBusinessOwnedCents: number;
  processingFeesCents: number;
  netPayoutCents: number;
  currency: BookingCurrency;
  status: BusinessPayoutStatus;
  paidAt?: Date | undefined;
  providerReference?: string | undefined;
};

export type FinancePayoutHistoryPage = {
  items: FinancePayoutHistoryItem[];
  total: number;
};

// --- Batch 8: Business payable + Super Admin platform-wide finance ----------------------------

export type BusinessPayableSummary = {
  businessId: string;
  businessName: string;
  city: string;
  category: string;
  grossCents: number;
  processingFeesCents: number;
  refundsCents: number;
  netCents: number;
  transactionCount: number;
  /** Business-owned gross split by source, for display parity with the existing Super Admin
   * mock UI's per-row "No-show €X + late cancel €Y" breakdown. */
  noShowAmountCents: number;
  cancellationAmountCents: number;
  depositAmountCents: number;
  /** Batch 13 — the portion of `grossCents` that came from Bookly-funded PROMO_SUBSIDY credits
   * (a returning booking's Promo shortfall) — broken out for the same display-parity reason as
   * the other source splits above; never folded silently into `depositAmountCents`. */
  promoSubsidyAmountCents: number;
};

export type PendingPayoutsPage = {
  items: BusinessPayableSummary[];
  totalPendingCents: number;
  businessCount: number;
};

export type PlatformFinanceSummary = {
  currency: BookingCurrency;
  period: { from: Date; to: Date };
  /** Bookly's own net platform revenue for the period: PLATFORM_FEE gross minus the
   * Bookly-borne Stripe processing fee minus any Bookly-owned refund reversal. */
  bookly: {
    grossCents: number;
    processingFeesCents: number;
    refundsCents: number;
    netCents: number;
  };
  /** No-show + late-cancellation fees collected on Businesses' behalf this period (gross,
   * regardless of payout status — matches the existing "Collected for businesses" card). */
  collectedForBusinesses: {
    amountCents: number;
    noShowAmountCents: number;
    cancellationAmountCents: number;
  };
  /** All-time (never date-filtered) no-show + late-cancellation recovery, matching
   * SuperAdminFinanceBanner's own "All time · platform-wide" framing — the platform-wide
   * counterpart to Batch 7's PayoutsBanner. */
  protectedEarningsAllTimeCents: number;
  /** Sums BusinessPayout.netPayoutCents where status=PAID — all-time, not period-scoped (a
   * payout is a point-in-time event; the existing card's own "SEPA payouts sent" framing is
   * all-time, matching PayoutsBanner's own "All time" precedent from Batch 7). */
  sentToBusinesses: { amountCents: number; payoutCount: number };
  /** The current, all-time (never date-filtered — rule #6: a date filter must never hide real
   * unpaid money) accumulated pending payable across every Business. */
  pendingPayouts: { amountCents: number; businessCount: number };
};

export type PlatformTransactionType =
  | "NO_SHOW_FEE"
  | "CANCELLATION_FEE"
  | "PLATFORM_FEE"
  | "REFUND";

export type PlatformTransactionRow = {
  id: string;
  businessId: string;
  businessName: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  type: PlatformTransactionType;
  createdAt: Date;
  grossCents: number;
  stripeFeeCents: number;
  netCents: number;
  owner: "BOOKLY" | "BUSINESS" | "CUSTOMER";
  status: FinanceTransactionStatus;
  payoutId?: string | undefined;
  currency: BookingCurrency;
};

export type PlatformTransactionPage = {
  rows: PlatformTransactionRow[];
  total: number;
};

export type PlatformPayoutHistoryItem = FinancePayoutHistoryItem & {
  businessId: string;
  businessName: string;
};

export type PlatformPayoutHistoryPage = {
  items: PlatformPayoutHistoryItem[];
  total: number;
};
