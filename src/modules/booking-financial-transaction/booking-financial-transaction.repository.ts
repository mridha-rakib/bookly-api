import type { ClientSession, Types } from "mongoose";

import {
  type BookingFinancialTransactionDocument,
  BookingFinancialTransactionModel,
} from "./booking-financial-transaction.model.js";
import type {
  BookingFinancialTransactionStatus,
  BookingFinancialTransactionType,
} from "./booking-financial-transaction.types.js";

/** One (type, status) bucket's total — the shape every `$group` aggregation below reduces to.
 * Never a raw document array: Batch 7 (Finance) reporting must never fetch-then-reduce-in-Node
 * (see this repository's own "bounded, never an unlimited dump" convention, extended here to
 * "aggregate in Mongo, never in Node"). */
export type FinancialTransactionAggregateBucket = {
  type: BookingFinancialTransactionType;
  status: BookingFinancialTransactionStatus;
  totalCents: number;
  count: number;
};

export type CreateBookingFinancialTransactionInput = Omit<
  BookingFinancialTransactionDocument,
  "_id" | "createdAt" | "updatedAt"
>;

/** Bounded the same way BookingRepository's range query is bounded (see booking.repository.ts /
 * booking.service.ts requireBoundedRange) — never an unlimited business-wide ledger read. */
const MAX_BUSINESS_LEDGER_RANGE_DAYS = 92;
const MAX_BUSINESS_LEDGER_PAGE_SIZE = 200;

export type ListByBusinessIdInput = {
  businessId: Types.ObjectId | string;
  type?: BookingFinancialTransactionDocument["type"] | undefined;
  from: Date;
  to: Date;
  limit?: number | undefined;
};

export class BookingFinancialTransactionRepository {
  /** The one write path — every entry is append-only from here on (see updateStatus below for
   * the single narrow exception). */
  public async create(
    input: CreateBookingFinancialTransactionInput,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument> {
    return new BookingFinancialTransactionModel(input).save(session ? { session } : undefined);
  }

  /**
   * The one allowed mutation on an existing row: settling a PENDING entry once an external
   * provider confirms or rejects it. Every other field is immutable after creation — a
   * reversal is always a new REFUND/ADJUSTMENT entry, never a rewrite of this one.
   */
  public async updateStatus(
    id: Types.ObjectId | string,
    status: BookingFinancialTransactionStatus,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return BookingFinancialTransactionModel.findOneAndUpdate(
      { _id: id, status: "PENDING" },
      { $set: { status } },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /**
   * The second, narrower allowed mutation (see updateStatus's own comment and
   * booking-financial-transaction.types.ts's WAIVED doc comment): a charge attempt that already
   * definitively FAILED may later be converted to WAIVED when a Business explicitly forgives the
   * obligation, without minting a second ledger row under the same unique idempotencyKey. CAS'd
   * on `status: "FAILED"` so this can never fire against a row any other state is currently in.
   */
  public async settleFailedAsWaived(
    id: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return BookingFinancialTransactionModel.findOneAndUpdate(
      { _id: id, status: "FAILED" },
      { $set: { status: "WAIVED" } },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /** Looks up the single ledger row claiming a given idempotencyKey — used by callers (the
   * no-show worker's charge branch, BookingLifecycleService.waiveFee) after their own INSERT
   * lost a duplicate-key race, to decide what the winning row actually settled as. */
  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BookingFinancialTransactionDocument | null> {
    return BookingFinancialTransactionModel.findOne({ idempotencyKey }).exec();
  }

  /** A Booking's full financial history in creation order — inherently small and bounded
   * (one Booking's own transactions), so no pagination parameter is needed here, unlike the
   * business-wide read below. */
  public async listByBookingId(
    bookingId: Types.ObjectId | string,
  ): Promise<BookingFinancialTransactionDocument[]> {
    return BookingFinancialTransactionModel.find({ bookingId })
      .sort({ createdAt: 1 })
      .limit(MAX_BUSINESS_LEDGER_PAGE_SIZE)
      .exec();
  }

  /** The payout-aggregation read path — always requires a bounded [from, to) range (enforced
   * by the service, not here, matching this codebase's convention of range validation living
   * in the service layer — see BookingService.requireBoundedRange for the identical pattern)
   * and always capped, never an unlimited business-wide dump. */
  public async listByBusinessId(
    input: ListByBusinessIdInput,
  ): Promise<BookingFinancialTransactionDocument[]> {
    return BookingFinancialTransactionModel.find({
      businessId: input.businessId,
      ...(input.type ? { type: input.type } : {}),
      createdAt: { $gte: input.from, $lt: input.to },
    })
      .sort({ createdAt: 1 })
      .limit(Math.min(input.limit ?? MAX_BUSINESS_LEDGER_PAGE_SIZE, MAX_BUSINESS_LEDGER_PAGE_SIZE))
      .exec();
  }

  /** Batch 7 (Finance) — bounded-period aggregation: sums+counts every entry of the given
   * types, grouped by (type, status), within a [from, to) range the SERVICE has already
   * validated against `MAX_BUSINESS_LEDGER_RANGE_DAYS` (same range-validation-lives-in-the-
   * service convention as `listByBusinessId` above). Backed entirely by the existing
   * `{businessId, type, createdAt}` index — the `$match` stage's `businessId`+`type`+`createdAt`
   * triple is exactly that index's key order, so this never scans entries outside the requested
   * types/range. Returns one row per (type, status) actually present — never a padded/zero-
   * filled shape; the caller fills in zero for combinations with no rows. */
  public async aggregateByTypeAndStatus(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    from: Date;
    to: Date;
  }): Promise<FinancialTransactionAggregateBucket[]> {
    return BookingFinancialTransactionModel.aggregate<FinancialTransactionAggregateBucket>([
      {
        $match: {
          businessId: input.businessId,
          type: { $in: input.types },
          createdAt: { $gte: input.from, $lt: input.to },
        },
      },
      {
        $group: {
          _id: { type: "$type", status: "$status" },
          totalCents: { $sum: "$amountCents" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          type: "$_id.type",
          status: "$_id.status",
          totalCents: 1,
          count: 1,
        },
      },
    ]).exec();
  }

  /** Batch 7 (Finance) — the "since you joined" all-time counterpart to the bounded aggregation
   * above (matches the existing Payouts & Finance UI's own "All time · protected earnings"
   * framing — see PayoutsBanner.tsx). Deliberately NOT bounded by date (nothing in this codebase
   * tracks a Business's "join date" as a query start point, and the metric is explicitly
   * all-time by product design) — safe because it is a single reduced `$group`, never a raw
   * document fetch: the `{businessId, type, createdAt}` index still serves the
   * businessId+type-equality prefix of this `$match` efficiently regardless of range. */
  public async sumAllTimeByTypeAndStatus(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    status: BookingFinancialTransactionStatus;
  }): Promise<number> {
    const result = await BookingFinancialTransactionModel.aggregate<{ totalCents: number }>([
      {
        $match: { businessId: input.businessId, type: { $in: input.types }, status: input.status },
      },
      { $group: { _id: null, totalCents: { $sum: "$amountCents" } } },
    ]).exec();
    return result[0]?.totalCents ?? 0;
  }

  /** Batch 7 (Finance) — the transaction-breakdown table's paginated read. Same bounded-range
   * contract as `listByBusinessId` (the service validates `from`/`to` before calling), but with
   * real page/limit pagination (the table can have far more rows over a period than the
   * business-wide ledger view needs) and a `total` count for the UI's pager. */
  public async listFeeTransactionsPage(input: {
    businessId: Types.ObjectId | string;
    types: BookingFinancialTransactionType[];
    from: Date;
    to: Date;
    page: number;
    limit: number;
  }): Promise<{ rows: BookingFinancialTransactionDocument[]; total: number }> {
    const filter = {
      businessId: input.businessId,
      type: { $in: input.types },
      createdAt: { $gte: input.from, $lt: input.to },
    };
    const skip = (input.page - 1) * input.limit;
    const [rows, total] = await Promise.all([
      BookingFinancialTransactionModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .exec(),
      BookingFinancialTransactionModel.countDocuments(filter).exec(),
    ]);
    return { rows, total };
  }
}

export { MAX_BUSINESS_LEDGER_PAGE_SIZE, MAX_BUSINESS_LEDGER_RANGE_DAYS };
