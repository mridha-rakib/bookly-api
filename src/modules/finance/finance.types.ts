import type { BookingCurrency } from "../booking/booking.types.js";
import type { BusinessPayoutStatus } from "./business-payout.model.js";

/**
 * Batch 7 — the Business Finance ownership matrix (Section 3/4 of the batch brief), expressed as
 * code so the accounting rules below are traceable to one place rather than re-derived per
 * method. Every rule here reuses the Batch 6.5 invariant: a BOOKLY_MANAGED booking's upfront
 * online charge is EXACTLY ONE of PLATFORM_FEE (first booking, Bookly-owned) or DEPOSIT
 * (returning booking, Business-owned) — see booking-financial-transaction.types.ts.
 *
 *   PLATFORM_FEE      — Bookly revenue. NEVER Business payable.
 *   DEPOSIT           — Business-owned prepayment (routine, non-cancelled bookings). Real money,
 *                        but out of THIS batch's UI scope — see FinanceService's own comment.
 *   CANCELLATION_FEE  — the incremental amount charged beyond the deposit already held for a
 *                        cancellation (BookingLifecycleService.executeCancellationFeeCharge).
 *                        100% Business-owned when SUCCEEDED: Bookly's cut (if any) was already
 *                        taken earlier via that booking's own PLATFORM_FEE entry, not via this
 *                        fee. WAIVED/FAILED/PENDING contribute €0.
 *   NO_SHOW_FEE       — the same shape as CANCELLATION_FEE, for a no-show
 *                        (NoShowResolutionService.autoResolve / BookingLifecycleService.waiveFee).
 *   REFUND            — reverses whichever party owned the ORIGINAL payment being refunded.
 *                        Out of this batch's UI scope (see FinanceService's own comment) — the
 *                        one existing refund path (executeBusinessCancellationRefund) only ever
 *                        refunds a booking's PLATFORM_FEE/DEPOSIT, never a CANCELLATION_FEE/
 *                        NO_SHOW_FEE, so it never reduces the fee-recovery figures this module
 *                        computes.
 *   PROCESSING_FEE    — Business-borne, deducted from net payout ("passed through at cost, zero
 *                        markup" — matches both the existing Payouts & Finance UI copy and this
 *                        codebase's own pre-existing doc comment describing PROCESSING_FEE as
 *                        "the mirror image of BUSINESS_PAYOUT" — see
 *                        booking-financial-transaction.service.ts).
 *   BUSINESS_PAYOUT   — money that has actually left the collected pool to the Business. Never
 *                        auto-written by this batch (no real payout execution exists) — see
 *                        BusinessPayout's own doc comment.
 *   WAIVED (status)   — an honest €0: never counted as collected, Business-owned, or Bookly
 *                        revenue, regardless of type.
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
