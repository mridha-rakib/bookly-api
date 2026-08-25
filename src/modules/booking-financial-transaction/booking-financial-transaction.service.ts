import type { ClientSession, Types } from "mongoose";

import { BookingFinancialTransactionError } from "./booking-financial-transaction.errors.js";
import type { BookingFinancialTransactionDocument } from "./booking-financial-transaction.model.js";
import type {
  BookingFinancialTransactionRepository,
  CreateBookingFinancialTransactionInput,
  FinancialTransactionAggregateBucket,
  ListByBusinessIdInput,
  OwnershipAggregateBucket,
} from "./booking-financial-transaction.repository.js";
import { MAX_BUSINESS_LEDGER_RANGE_DAYS } from "./booking-financial-transaction.repository.js";
import type {
  BookingFinancialTransactionDirection,
  BookingFinancialTransactionType,
} from "./booking-financial-transaction.types.js";

const oneDayMs = 24 * 60 * 60 * 1000;

/** The one direction each type permits — BUSINESS_PAYOUT is always CREDIT (see
 * booking-financial-transaction.types.ts), every charge type is always DEBIT, REFUND is
 * always CREDIT. ADJUSTMENT is the only type where the caller genuinely chooses.
 * PROCESSING_FEE is fixed DEBIT too, but by a different convention than the customer-facing
 * charge types: it is the offsetting leg for "money leaving the collected pool before it
 * reaches the Business" (the mirror image of BUSINESS_PAYOUT's fixed CREDIT), not a charge
 * against what the customer owes. */
const fixedDirectionByType: Partial<
  Record<BookingFinancialTransactionType, BookingFinancialTransactionDirection>
> = {
  DEPOSIT: "DEBIT",
  PAYMENT: "DEBIT",
  PLATFORM_FEE: "DEBIT",
  CANCELLATION_FEE: "DEBIT",
  NO_SHOW_FEE: "DEBIT",
  REFUND: "CREDIT",
  BUSINESS_PAYOUT: "CREDIT",
  PROCESSING_FEE: "DEBIT",
  // Batch 13 — mirrors BUSINESS_PAYOUT's own convention: money arriving to settle/close a
  // position (here, Bookly making the Business whole for a promo shortfall), never a second
  // debit against what the customer owes.
  PROMO_SUBSIDY: "CREDIT",
};

export type RecordTransactionInput = CreateBookingFinancialTransactionInput;

export type ListForBusinessInput = {
  businessId: Types.ObjectId | string;
  type?: BookingFinancialTransactionType | undefined;
  from: Date;
  to: Date;
  limit?: number | undefined;
};

export class BookingFinancialTransactionService {
  public constructor(
    private readonly transactionRepository: BookingFinancialTransactionRepository,
  ) {}

  /**
   * Records one immutable ledger entry. This is the only write path any future
   * Payment/Cancellation/No-show/Payout module is expected to call — never Mongoose directly
   * — so the direction/type consistency invariant is enforced exactly once, here, rather than
   * re-derived at every call site.
   */
  public async record(
    input: RecordTransactionInput,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument> {
    const requiredDirection = fixedDirectionByType[input.type];
    if (requiredDirection && input.direction !== requiredDirection) {
      throw new BookingFinancialTransactionError(
        "BOOKING_FINANCIAL_TRANSACTION_DIRECTION_MISMATCH",
        400,
        [
          {
            message: `${input.type} must be recorded as ${requiredDirection}, not ${input.direction}`,
            code: "BOOKING_FINANCIAL_TRANSACTION_DIRECTION_MISMATCH",
          },
        ],
      );
    }

    try {
      return await this.transactionRepository.create(input, session);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new BookingFinancialTransactionError(
          "BOOKING_FINANCIAL_TRANSACTION_DUPLICATE_IDEMPOTENCY_KEY",
          409,
        );
      }

      throw error;
    }
  }

  /** Settles a PENDING entry once an external provider (Stripe) confirms or rejects it — the
   * one allowed mutation on an existing row (see the repository's own comment). A thin
   * pass-through kept on the service (not called directly on the repository) so every write
   * path stays behind this one service, matching this module's own "never Mongoose directly"
   * doc comment. */
  public async settleStatus(
    id: Types.ObjectId | string,
    status: Extract<BookingFinancialTransactionDocument["status"], "SUCCEEDED" | "FAILED">,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return this.transactionRepository.updateStatus(id, status, session);
  }

  /** See BookingFinancialTransactionRepository.settleFailedAsWaived's own comment. */
  public async settleFailedAsWaived(
    id: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return this.transactionRepository.settleFailedAsWaived(id, session);
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return this.transactionRepository.findByIdempotencyKey(idempotencyKey);
  }

  public async listForBooking(
    bookingId: Types.ObjectId | string,
  ): Promise<BookingFinancialTransactionDocument[]> {
    return this.transactionRepository.listByBookingId(bookingId);
  }

  /**
   * Batch 6.5 — THE one place that answers "how much did this Booking's customer already pay
   * online, and what's the provider reference for it" — regardless of WHO economically owns
   * that money. A Booking's upfront deposit is ledgered as exactly one of PLATFORM_FEE (first
   * booking — Bookly's own activation revenue) or DEPOSIT (returning booking — a Business-owned
   * prepayment); every caller that needs "the amount already collected" for netting/refund
   * purposes (cancellation-fee netting, no-show-fee netting, business-cancellation refund) must
   * look for EITHER type, never PLATFORM_FEE alone — that was the exact bug this batch corrects
   * (a returning customer's real deposit was invisible to every one of those callers). Centralized
   * here once rather than duplicated per caller (see BookingLifecycleService/
   * NoShowResolutionService, which both called this pattern independently before).
   */
  public async findSucceededUpfrontPayment(
    bookingId: Types.ObjectId | string,
  ): Promise<BookingFinancialTransactionDocument | undefined> {
    const entries = await this.transactionRepository.listByBookingId(bookingId);
    return entries.find(
      (entry) =>
        (entry.type === "PLATFORM_FEE" || entry.type === "DEPOSIT") && entry.status === "SUCCEEDED",
    );
  }

  /** A future payout/reporting batch's read path — always a bounded [from, to) range, never
   * an unbounded business-wide dump (same lesson as BookingService.requireBoundedRange). */
  public async listForBusiness(
    input: ListForBusinessInput,
  ): Promise<BookingFinancialTransactionDocument[]> {
    this.requireBoundedRange(input.from, input.to);

    const listInput: ListByBusinessIdInput = {
      businessId: input.businessId,
      from: input.from,
      to: input.to,
      ...(input.type ? { type: input.type } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };

    return this.transactionRepository.listByBusinessId(listInput);
  }

  /** Batch 7 (Finance) — bounded-period sums/counts grouped by (type, status). See
   * FinanceService for how the Business Finance module turns these generic buckets into its own
   * revenue/payout DTOs; kept generic here (not Finance-specific) per rule #19: reusable
   * aggregation primitives a future Super Admin module can call too. */
  public async aggregateForBusiness(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    from: Date;
    to: Date;
  }): Promise<FinancialTransactionAggregateBucket[]> {
    this.requireBoundedRange(input.from, input.to);
    return this.transactionRepository.aggregateByTypeAndStatus(input);
  }

  /** Batch 7 (Finance) — the deliberately unbounded "all time" counterpart (see the repository
   * method's own comment on why this is safe: one reduced `$group`, never a raw dump). */
  public async sumAllTimeForBusiness(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    status: BookingFinancialTransactionDocument["status"];
  }): Promise<number> {
    return this.transactionRepository.sumAllTimeByTypeAndStatus(input);
  }

  /** Batch 7 (Finance) — the transaction-breakdown table's paginated read. */
  public async listFeeTransactionsPage(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    from: Date;
    to: Date;
    page: number;
    limit: number;
  }): Promise<{ rows: BookingFinancialTransactionDocument[]; total: number }> {
    this.requireBoundedRange(input.from, input.to);
    return this.transactionRepository.listFeeTransactionsPage(input);
  }

  /** Batch 8 (Business Payout) — re-reads the exact set a payout is about to claim, INSIDE the
   * caller's transaction (session required, not optional, on purpose — see
   * BusinessPayoutService.executePayout, the only intended caller). */
  public async findUnclaimedForPayout(
    businessId: Types.ObjectId | string,
    types: BookingFinancialTransactionType[],
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument[]> {
    return this.transactionRepository.findUnclaimedForPayout(businessId, types, session);
  }

  /** Batch 8 (Business Payout) — see the repository method's own comment on the concurrency
   * guarantee this provides. */
  public async claimForPayout(
    ids: Array<Types.ObjectId | string>,
    payoutId: Types.ObjectId,
    session: ClientSession,
  ): Promise<number> {
    return this.transactionRepository.claimForPayout(ids, payoutId, session);
  }

  /** Batch 8 — the shared ownership-aware aggregation primitive (rule #17/#19). See
   * BookingFinancialTransactionRepository.aggregateBusinessOwnedBySource's own comment for the
   * exact contract; this is a thin pass-through kept on the service so every read stays behind
   * it, matching this module's own "never Mongoose directly" convention. */
  public async aggregateOwnedBySource(input: {
    businessId?: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    unclaimedOnly: boolean;
    from?: Date;
    to?: Date;
    groupByBusiness?: boolean;
  }): Promise<OwnershipAggregateBucket[]> {
    if (!input.unclaimedOnly) {
      if (!input.from || !input.to) {
        throw new BookingFinancialTransactionError(
          "BOOKING_FINANCIAL_TRANSACTION_RANGE_REQUIRED",
          400,
        );
      }
      this.requireBoundedRange(input.from, input.to);
    }
    return this.transactionRepository.aggregateBusinessOwnedBySource(input);
  }

  /** Batch 8 (Super Admin Finance) — the deliberately unbounded, all-time counterpart to
   * `aggregateOwnedBySource` (matches SuperAdminFinanceBanner's own "All time · platform-wide"
   * framing, same precedent as `sumAllTimeByTypeAndStatus`). Never period-bounded — safe for
   * the same reason every other all-time aggregate here is: one reduced `$group`, never a raw
   * dump. */
  public async aggregateAllTimeOwnedBySource(input: {
    types: BookingFinancialTransactionType[];
  }): Promise<OwnershipAggregateBucket[]> {
    return this.transactionRepository.aggregateBusinessOwnedBySource({
      types: input.types,
      unclaimedOnly: false,
    });
  }

  /** Batch 8 (Super Admin Finance) — the platform-wide paginated transaction read. */
  public async listGlobalPage(input: {
    types?: BookingFinancialTransactionType[];
    from: Date;
    to: Date;
    page: number;
    limit: number;
  }): Promise<{ rows: BookingFinancialTransactionDocument[]; total: number }> {
    this.requireBoundedRange(input.from, input.to);
    return this.transactionRepository.listGlobalPage(input);
  }

  private requireBoundedRange(from: Date, to: Date): void {
    if (from >= to) {
      throw new BookingFinancialTransactionError(
        "BOOKING_FINANCIAL_TRANSACTION_RANGE_REQUIRED",
        400,
      );
    }

    const rangeMs = to.getTime() - from.getTime();
    if (rangeMs > MAX_BUSINESS_LEDGER_RANGE_DAYS * oneDayMs) {
      throw new BookingFinancialTransactionError(
        "BOOKING_FINANCIAL_TRANSACTION_RANGE_TOO_WIDE",
        400,
        [
          {
            message: `The date range must not exceed ${MAX_BUSINESS_LEDGER_RANGE_DAYS} days`,
            code: "BOOKING_FINANCIAL_TRANSACTION_RANGE_TOO_WIDE",
          },
        ],
      );
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
