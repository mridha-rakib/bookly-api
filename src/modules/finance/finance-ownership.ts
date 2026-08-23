/**
 * Batch 8 — the ONE place that turns a ledger entry's recorded `metadata.sourceType` (see
 * booking-financial-transaction.model.ts's own doc comment) into "who bears this."
 *
 * Only PROCESSING_FEE and REFUND entries need this: every other type's ownership is intrinsic
 * to its own `type` (PLATFORM_FEE is always Bookly's, DEPOSIT/CANCELLATION_FEE/NO_SHOW_FEE are
 * always the Business's — see finance.types.ts's own ownership-matrix comment). A
 * PROCESSING_FEE or REFUND's ownership instead depends on WHICH underlying payment produced it
 * — "the owner of the underlying payment bears its Stripe processing fee" (Batch 8's own
 * correction to Batch 7, which treated every PROCESSING_FEE as Business-borne).
 *
 * `UNKNOWN` (no `sourceType` recorded) is a real, honest outcome — never guessed at. This
 * happens for: a COMPENSATION refund (BookingCreationService.compensateFailedBookingAfterPayment
 * — money that was collected then immediately unwound after a booking-creation failure, so it
 * was never actually counted as anyone's revenue in the first place, and correctly stays
 * excluded from both Bookly's and the Business's totals); or any entry recorded before this
 * linkage existed. `classifySourceOwner` deliberately EXCLUDES `UNKNOWN` buckets from both
 * owners' totals rather than defaulting them to either — see rule #25 ("if historical ownership
 * cannot be determined deterministically: report it instead of guessing").
 */
import type { OwnershipAggregateBucket } from "../booking-financial-transaction/booking-financial-transaction.repository.js";

export type FinancialOwner = "BOOKLY" | "BUSINESS" | "UNKNOWN";

export const classifySourceOwner = (sourceType: string | null): FinancialOwner => {
  if (sourceType === "PLATFORM_FEE") {
    return "BOOKLY";
  }
  if (
    sourceType === "DEPOSIT" ||
    sourceType === "CANCELLATION_FEE" ||
    sourceType === "NO_SHOW_FEE"
  ) {
    return "BUSINESS";
  }
  return "UNKNOWN";
};

/** The types whose ownership is intrinsic (never needs `sourceType`) — always the Business's. */
const BUSINESS_OWNED_GROSS_TYPES = new Set(["DEPOSIT", "CANCELLATION_FEE", "NO_SHOW_FEE"]);

export type OwnedTotals = {
  grossCents: number;
  processingFeesCents: number;
  refundsCents: number;
  netCents: number;
};

/**
 * THE shared combiner (rule #17/#20): turns raw `OwnershipAggregateBucket[]` (from
 * BookingFinancialTransactionService.aggregateOwnedBySource) into the Business's net payable —
 * gross Business-owned inflows minus Business-borne processing fees minus Business-owned refund
 * reversals (rule #5). Every caller that needs "what does Bookly currently owe this Business"
 * (BusinessFinanceService's own payable preview, BusinessPayoutService's actual claim
 * computation, Super Admin's per-business pending list, Super Admin's platform-wide pending
 * total) MUST go through this one function — never re-derive the formula per call site.
 */
export const combineBusinessOwnedBuckets = (buckets: OwnershipAggregateBucket[]): OwnedTotals => {
  let grossCents = 0;
  let processingFeesCents = 0;
  let refundsCents = 0;

  for (const bucket of buckets) {
    if (BUSINESS_OWNED_GROSS_TYPES.has(bucket.type)) {
      grossCents += bucket.totalCents;
    } else if (
      bucket.type === "PROCESSING_FEE" &&
      classifySourceOwner(bucket.sourceType) === "BUSINESS"
    ) {
      processingFeesCents += bucket.totalCents;
    } else if (bucket.type === "REFUND" && classifySourceOwner(bucket.sourceType) === "BUSINESS") {
      refundsCents += bucket.totalCents;
    }
  }

  return {
    grossCents,
    processingFeesCents,
    refundsCents,
    netCents: grossCents - processingFeesCents - refundsCents,
  };
};

/** The Bookly-revenue counterpart — see combineBusinessOwnedBuckets's own comment; same
 * function, opposite owner. Bookly's gross is PLATFORM_FEE only; its costs are the PLATFORM_FEE-
 * sourced PROCESSING_FEE/REFUND buckets (rule #3.1: "Do NOT deduct the Stripe processing fee
 * for this transaction from the Business's payable balance" — this is where it goes instead). */
export const combineBooklyOwnedBuckets = (buckets: OwnershipAggregateBucket[]): OwnedTotals => {
  let grossCents = 0;
  let processingFeesCents = 0;
  let refundsCents = 0;

  for (const bucket of buckets) {
    if (bucket.type === "PLATFORM_FEE") {
      grossCents += bucket.totalCents;
    } else if (
      bucket.type === "PROCESSING_FEE" &&
      classifySourceOwner(bucket.sourceType) === "BOOKLY"
    ) {
      processingFeesCents += bucket.totalCents;
    } else if (bucket.type === "REFUND" && classifySourceOwner(bucket.sourceType) === "BOOKLY") {
      refundsCents += bucket.totalCents;
    }
  }

  return {
    grossCents,
    processingFeesCents,
    refundsCents,
    netCents: grossCents - processingFeesCents - refundsCents,
  };
};

/** Splits a platform-wide (`groupByBusiness: true`) bucket set into one array per Business —
 * the input to running `combineBusinessOwnedBuckets` once per Business for Super Admin's
 * pending-payout list, without a second aggregation query per Business (never N+1). */
export const groupBucketsByBusiness = (
  buckets: OwnershipAggregateBucket[],
): Map<string, OwnershipAggregateBucket[]> => {
  const grouped = new Map<string, OwnershipAggregateBucket[]>();
  for (const bucket of buckets) {
    if (!bucket.businessId) {
      continue;
    }
    const existing = grouped.get(bucket.businessId);
    if (existing) {
      existing.push(bucket);
    } else {
      grouped.set(bucket.businessId, [bucket]);
    }
  }
  return grouped;
};

/** The types to aggregate together whenever either owner's totals are needed — deliberately one
 * shared list so a single aggregation call feeds both `combineBusinessOwnedBuckets` and
 * `combineBooklyOwnedBuckets`. */
export const ALL_OWNERSHIP_RELEVANT_TYPES = [
  "PLATFORM_FEE",
  "DEPOSIT",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
  "PROCESSING_FEE",
  "REFUND",
] as const;

/** Just the Business-owned gross-generating types plus their two possible deduction types —
 * used where only the Business side is needed (payout execution, Business-scoped payable). */
export const BUSINESS_PAYABLE_TYPES = [
  "DEPOSIT",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
  "PROCESSING_FEE",
  "REFUND",
] as const;
