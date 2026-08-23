import type { ClientSession, Types } from "mongoose";

import {
  type BookingDocument,
  type BookingEventHistoryEntry,
  BookingModel,
  type BookingRescheduleEntry,
} from "./booking.model.js";
import type { BookingStatus } from "./booking.types.js";

/**
 * `_id` is optional-but-honored: BookingCreationService pre-generates it (`new Types.ObjectId()`)
 * so the SAME id can be pinned to the idempotency claim (see booking-creation-claim.model.ts)
 * before the Booking document itself is written inside the same transaction — Mongoose/MongoDB
 * both accept an explicit `_id` on insert exactly like an implicit one.
 */
export type CreateBookingInput = Omit<BookingDocument, "_id" | "createdAt" | "updatedAt"> & {
  _id?: Types.ObjectId;
};

export type BookingListFilter = {
  status?: BookingStatus[] | undefined;
  staffMembershipId?: Types.ObjectId | string | undefined;
  businessClientId?: Types.ObjectId | string | undefined;
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
};

export type BookingListPagination = {
  page: number;
  limit: number;
  /** 1 = soonest-first (ascending), -1 = most-recent-first (descending). Default -1. */
  sortDirection?: 1 | -1 | undefined;
};

export type BookingListResult = {
  bookings: BookingDocument[];
  total: number;
};

/**
 * Deliberately minimal in this phase: create + the read paths needed to prove the schema and
 * its indexes behave correctly (see the corresponding integration test). List/filter/pagination
 * endpoints that a real Booking UI needs (All Bookings, Calendar range, Client history, My
 * Bookings) are Phase 2/3 work once availability/creation are real — adding them now against
 * data no creation flow can yet populate would be speculative.
 */
export class BookingRepository {
  public async create(
    input: CreateBookingInput,
    session?: ClientSession,
  ): Promise<BookingDocument> {
    return new BookingModel(input).save(session ? { session } : undefined);
  }

  public async findById(
    businessId: Types.ObjectId | string,
    bookingId: Types.ObjectId | string,
  ): Promise<BookingDocument | null> {
    return BookingModel.findOne({ _id: bookingId, businessId }).exec();
  }

  public async findByReference(reference: string): Promise<BookingDocument | null> {
    return BookingModel.findOne({ reference: reference.toUpperCase() }).exec();
  }

  /** Batch 7 (Finance) — the one batched-lookup path a transaction-breakdown read needs: given a
   * page of ledger entries, resolve every referenced Booking's reference/customer/financials in
   * ONE query, never per-row (see FinanceService's own comment on why this exists). Scoped by
   * businessId exactly like `findById`, so a ledger row from another Business can never leak a
   * Booking document through this path. */
  public async findManyByIds(
    businessId: Types.ObjectId | string,
    bookingIds: Array<Types.ObjectId | string>,
  ): Promise<BookingDocument[]> {
    if (bookingIds.length === 0) {
      return [];
    }
    return BookingModel.find({ _id: { $in: bookingIds }, businessId }).exec();
  }

  /** Batch 8 (Super Admin Finance) — cross-business batched lookup, the same "no actor scoping,
   * never an HTTP caller directly" contract as `findByIdOnly` above extended to a batch: a
   * platform-wide transaction log legitimately spans many Businesses, so a single-Business-
   * scoped `findManyByIds` cannot serve it. Only ever called from FinanceService, itself gated
   * SUPER_ADMIN-only at the route level (see super-admin.route.ts). */
  public async findManyByIdsCrossBusiness(
    bookingIds: Array<Types.ObjectId | string>,
  ): Promise<BookingDocument[]> {
    if (bookingIds.length === 0) {
      return [];
    }
    return BookingModel.find({ _id: { $in: bookingIds } }).exec();
  }

  /** Cross-business, no actor scoping — used ONLY by the no-show worker (never a controller: an
   * HTTP caller must always go through `findById`/`findByIdForCustomer`'s ownership scoping).
   * The worker itself finds candidate ids via `findManyOverdueNoShows` below; this is the
   * single-document re-fetch it uses to re-verify current state right before acting. */
  public async findByIdOnly(bookingId: Types.ObjectId | string): Promise<BookingDocument | null> {
    return BookingModel.findOne({ _id: bookingId }).exec();
  }

  /** The no-show worker's own bounded, index-backed query — relies entirely on the existing
   * `{status, noShowDeadlineAt}` partial index (see booking.model.ts) added in Batch 1
   * specifically for this. Never scans the full collection: `status: "PENDING"` plus the
   * partial index's own filter (`noShowDeadlineAt` exists) together make this a small, targeted
   * lookup even at high Booking volume. Returns only `_id` — the worker re-fetches each full
   * document individually right before acting, so a stale batch read never drives a decision. */
  public async findManyOverdueNoShows(
    now: Date,
    limit: number,
  ): Promise<Array<{ _id: Types.ObjectId }>> {
    return BookingModel.find({ status: "PENDING", noShowDeadlineAt: { $lte: now } }, { _id: 1 })
      .limit(limit)
      .exec();
  }

  /** A Customer's own Booking detail read — deliberately scoped by BOTH `_id` and
   * `customer.customerUserId` in the same query (never a fetch-then-compare), so a bookingId
   * belonging to a different Customer is indistinguishable from an unknown id (anti-
   * enumeration, matching every other module's convention). */
  public async findByIdForCustomer(
    bookingId: Types.ObjectId | string,
    customerUserId: Types.ObjectId | string,
  ): Promise<BookingDocument | null> {
    return BookingModel.findOne({
      _id: bookingId,
      "customer.customerUserId": customerUserId,
    }).exec();
  }

  /**
   * The single write primitive every Batch 3 lifecycle operation (complete, both cancellation
   * variants, both reschedule variants) composes from — a CAS `findOneAndUpdate` gated on the
   * Booking's CURRENT status matching one of `expectedStatuses`, so a concurrent second writer
   * racing the same Booking (e.g. cancel-vs-reschedule, repeated-cancel) either loses cleanly
   * (returns null — the caller maps that to a clear "already in a different state" error) or
   * lands on a genuinely still-valid state, never a lost update. `pushEvent` is mandatory in
   * spirit (every mutation is audited — see BookingLifecycleService) but left optional here
   * since this is a plain data-access primitive, not a policy enforcer.
   */
  public async casUpdate(
    businessId: Types.ObjectId | string,
    bookingId: Types.ObjectId | string,
    expectedStatuses: BookingStatus[],
    update: {
      set?: Record<string, unknown>;
      unset?: Record<string, unknown>;
      pushEvent?: BookingEventHistoryEntry;
      pushReschedule?: BookingRescheduleEntry;
      incrementCustomerRescheduleCount?: boolean;
      /** Extra optimistic-concurrency filter clauses (e.g. `{"schedule.startAt": oldStartAt}`
       * for reschedule) — status alone is NOT a sufficient guard for an operation that never
       * changes status (reschedule stays UPCOMING throughout), so a second concurrent identical
       * reschedule request would otherwise also match a plain status-only CAS filter and apply
       * a second, unwanted mutation. See BookingLifecycleService.performReschedule. */
      extraFilter?: Record<string, unknown>;
    },
    session?: ClientSession,
  ): Promise<BookingDocument | null> {
    const push: Record<string, unknown> = {};
    if (update.pushEvent) push["eventHistory"] = update.pushEvent;
    if (update.pushReschedule) push["rescheduleHistory"] = update.pushReschedule;

    const inc: Record<string, unknown> = {};
    if (update.incrementCustomerRescheduleCount) inc["customerRescheduleCount"] = 1;

    return BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        businessId,
        status: { $in: expectedStatuses },
        ...(update.extraFilter ?? {}),
      },
      {
        ...(update.set && Object.keys(update.set).length > 0 ? { $set: update.set } : {}),
        ...(update.unset && Object.keys(update.unset).length > 0 ? { $unset: update.unset } : {}),
        ...(Object.keys(push).length > 0 ? { $push: push } : {}),
        ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
      },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /** Same as `casUpdate`, scoped by `customer.customerUserId` instead of `businessId` — for the
   * Customer-initiated cancel/reschedule operations, which have no Business-management actor. */
  public async casUpdateForCustomer(
    bookingId: Types.ObjectId | string,
    customerUserId: Types.ObjectId | string,
    expectedStatuses: BookingStatus[],
    update: {
      set?: Record<string, unknown>;
      pushEvent?: BookingEventHistoryEntry;
      pushReschedule?: BookingRescheduleEntry;
      incrementCustomerRescheduleCount?: boolean;
      extraFilter?: Record<string, unknown>;
    },
    session?: ClientSession,
  ): Promise<BookingDocument | null> {
    const push: Record<string, unknown> = {};
    if (update.pushEvent) push["eventHistory"] = update.pushEvent;
    if (update.pushReschedule) push["rescheduleHistory"] = update.pushReschedule;

    const inc: Record<string, unknown> = {};
    if (update.incrementCustomerRescheduleCount) inc["customerRescheduleCount"] = 1;

    return BookingModel.findOneAndUpdate(
      {
        _id: bookingId,
        "customer.customerUserId": customerUserId,
        status: { $in: expectedStatuses },
        ...(update.extraFilter ?? {}),
      },
      {
        ...(update.set && Object.keys(update.set).length > 0 ? { $set: update.set } : {}),
        ...(Object.keys(push).length > 0 ? { $push: push } : {}),
        ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
      },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /**
   * Batch 4 — the follow-up write once a cancellation-fee charge or business-cancellation
   * refund has actually resolved (outside the cancellation's own transaction, since the Stripe
   * call itself happens after that transaction commits — see BookingLifecycleService's own
   * comment). Deliberately unconditional on the Booking's current status (a settlement can
   * resolve well after the cancellation itself) — this only ever touches the
   * `cancellationOutcome` subdocument, never `status` or any occupancy-relevant field.
   */
  public async updateCancellationSettlement(
    bookingId: Types.ObjectId | string,
    settlementStatus: "SUCCEEDED" | "FAILED",
    settlementProviderReference: string | undefined,
  ): Promise<BookingDocument | null> {
    return BookingModel.findOneAndUpdate(
      { _id: bookingId },
      {
        $set: {
          "cancellationOutcome.settlementStatus": settlementStatus,
          ...(settlementProviderReference
            ? { "cancellationOutcome.settlementProviderReference": settlementProviderReference }
            : {}),
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  /**
   * Proves the `{businessId, "schedule.startAt"}` index shape (the future Calendar/All
   * Bookings query) end to end. Inclusive of both bounds, ascending by start time. Range
   * width is validated by the caller (see BookingService.requireBoundedRange) — this method
   * does not itself reject a wide range, since a repository is data access only, never domain
   * validation, matching this codebase's layering convention.
   *
   * `excludeHistory` drops `eventHistory`/`rescheduleHistory` from the returned documents —
   * both are unbounded-growth arrays that a Calendar/list view has no use for (only a single
   * Booking's detail view does), so a future high-cardinality range query is never forced to
   * pull them for every row it returns.
   */
  public async findManyByBusinessIdInRange(
    businessId: Types.ObjectId | string,
    startAt: Date,
    endAt: Date,
    options: { excludeHistory?: boolean } = {},
  ): Promise<BookingDocument[]> {
    return BookingModel.find(
      {
        businessId,
        "schedule.startAt": { $gte: startAt, $lte: endAt },
      },
      options.excludeHistory ? { eventHistory: 0, rescheduleHistory: 0 } : undefined,
    )
      .sort({ "schedule.startAt": 1 })
      .exec();
  }

  /** The Calendar range-read (item 15): a narrow, display-only projection — never the full
   * document (no eventHistory/rescheduleHistory/full financials breakdown, no history). Batch
   * 6 adds `source` and the two `financials` totals (a Calendar card shows Manual-vs-Bookly and
   * a price chip — see toBookingCalendarEntryDto) without pulling the rest of `financials`. */
  public async findManyForCalendar(
    businessId: Types.ObjectId | string,
    startAt: Date,
    endAt: Date,
  ): Promise<BookingDocument[]> {
    return BookingModel.find(
      { businessId, "schedule.startAt": { $gte: startAt, $lte: endAt } },
      {
        reference: 1,
        source: 1,
        status: 1,
        schedule: 1,
        "serviceLines.serviceSnapshot.name": 1,
        "serviceLines.staffSnapshot": 1,
        "serviceLines.responsibleStaffMembershipId": 1,
        "customer.contact.firstName": 1,
        "customer.contact.lastName": 1,
        "financials.totalCents": 1,
        "financials.currency": 1,
      },
    )
      .sort({ "schedule.startAt": 1 })
      .exec();
  }

  /** Business-scoped paginated list — All Bookings + status/date/staff/client filters (item
   * 14). `eventHistory`/`rescheduleHistory` are always excluded, matching
   * findManyByBusinessIdInRange's own rationale (a list view never needs them). */
  public async listForBusiness(
    businessId: Types.ObjectId | string,
    filter: BookingListFilter,
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    const query = this.buildListQuery({ businessId, ...filter });
    return this.runPaginatedQuery(query, pagination);
  }

  /** Cross-business Customer list — My Bookings tabs (item 14). Never scoped to a Business;
   * relies on the sparse `{customer.customerUserId, schedule.startAt}` index. */
  public async listForCustomer(
    customerUserId: Types.ObjectId | string,
    filter: Omit<BookingListFilter, "businessClientId">,
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    const query = this.buildListQuery({ "customer.customerUserId": customerUserId, ...filter });
    return this.runPaginatedQuery(query, pagination);
  }

  private buildListQuery(
    input: { businessId?: Types.ObjectId | string } & Record<string, unknown> & BookingListFilter,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {};

    if (input["businessId"]) {
      query["businessId"] = input["businessId"];
    }
    if (input["customer.customerUserId"]) {
      query["customer.customerUserId"] = input["customer.customerUserId"];
    }
    if (input.status && input.status.length > 0) {
      query["status"] = { $in: input.status };
    }
    if (input.staffMembershipId) {
      query["serviceLines.responsibleStaffMembershipId"] = input.staffMembershipId;
    }
    if (input.businessClientId) {
      query["customer.businessClientId"] = input.businessClientId;
    }
    if (input.fromDate || input.toDate) {
      query["schedule.startAt"] = {
        ...(input.fromDate ? { $gte: input.fromDate } : {}),
        ...(input.toDate ? { $lte: input.toDate } : {}),
      };
    }

    return query;
  }

  private async runPaginatedQuery(
    query: Record<string, unknown>,
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    const sortDirection = pagination.sortDirection ?? -1;
    const skip = (pagination.page - 1) * pagination.limit;

    const [bookings, total] = await Promise.all([
      BookingModel.find(query, { eventHistory: 0, rescheduleHistory: 0 })
        .sort({ "schedule.startAt": sortDirection })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      BookingModel.countDocuments(query).exec(),
    ]);

    return { bookings, total };
  }
}
