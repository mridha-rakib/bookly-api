import { type ClientSession, Types } from "mongoose";
import { zeroFilledMonths } from "../../common/time/analytics-buckets.js";
import {
  type BookingDocument,
  type BookingEventHistoryEntry,
  BookingModel,
  type BookingRescheduleEntry,
} from "./booking.model.js";
import { type BookingSource, type BookingStatus, bookingStatuses } from "./booking.types.js";

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
  /** Batch 16 — Book Again needs only genuinely fulfilled BOOKLY_MANAGED history (never a
   * Business Owner's MANUAL entry on the Customer's behalf) alongside `status:["COMPLETED"]`.
   * Optional and additive — every existing caller that omits it is unaffected. */
  source?: BookingSource[] | undefined;
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

/** Dashboard Overview's "Today's schedule" safety bound — see
 * `findScheduleForBusinessOnDate`'s own comment. */
const MAX_DASHBOARD_SCHEDULE_ROWS = 200;

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

  /**
   * Dashboard Overview (business-scoped, unlike the platform-wide `aggregateX` methods further
   * down which back Super Admin's own Analytics) — a single Business's own bookings whose
   * `schedule.startAt` falls in one Business-local calendar day, optionally further scoped to
   * one responsible Staff member (STAFF's own scoped-down Overview — see
   * DashboardOverviewService). Served by the existing `{businessId, schedule.startAt}` index;
   * bounded by `MAX_DASHBOARD_SCHEDULE_ROWS` — a single Business's single-day booking volume
   * never legitimately approaches that, so this is a safety bound, not a real pagination need
   * (matches this repository's own "bounded, never an unlimited dump" convention).
   */
  public async findScheduleForBusinessOnDate(
    businessId: Types.ObjectId | string,
    dayStart: Date,
    dayEnd: Date,
    staffMembershipId?: Types.ObjectId | string,
  ): Promise<BookingDocument[]> {
    const query: Record<string, unknown> = {
      businessId,
      "schedule.startAt": { $gte: dayStart, $lt: dayEnd },
    };
    if (staffMembershipId) {
      query["serviceLines.responsibleStaffMembershipId"] = staffMembershipId;
    }

    return BookingModel.find(query)
      .sort({ "schedule.startAt": 1 })
      .limit(MAX_DASHBOARD_SCHEDULE_ROWS)
      .exec();
  }

  /** Dashboard Overview's "No-shows this month" count — the SAME `NO_SHOW_CHARGED`/
   * `NO_SHOW_WAIVED` classification `aggregateBusinessBookingStats` already uses for its own
   * (platform-wide) `noShowCount`, reused here rather than re-invented, just business-scoped and
   * bounded to the requested [from, to) window over `schedule.startAt` (the appointment's own
   * date — matches this method's sibling `findScheduleForBusinessOnDate` above, not the ledger's
   * `createdAt`, which is a different, unrelated date axis). `NO_SHOW_CANCELLED` is deliberately
   * excluded, matching `aggregateBusinessBookingStats`'s own precedent. */
  public async countNoShowsForBusinessInRange(
    businessId: Types.ObjectId | string,
    from: Date,
    to: Date,
  ): Promise<number> {
    return BookingModel.countDocuments({
      businessId,
      status: { $in: ["NO_SHOW_CHARGED", "NO_SHOW_WAIVED"] },
      "schedule.startAt": { $gte: from, $lt: to },
    }).exec();
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

  /** Batch 11 — Super Admin global Bookings list: `businessId` is OPTIONAL here (unlike
   * `listForBusiness`, where it's mandatory) — omitted means every Business, matching the
   * explicit cross-business Super Admin surface this batch's own instructions require rather
   * than reusing the Business-scoped endpoint with its authorization bypassed. `q` is a
   * best-effort case-insensitive match against the Booking's own denormalized customer-contact
   * snapshot and reference — never a $lookup/join, never an unbounded scan (pagination always
   * applies). Reuses `buildListQuery`/`runPaginatedQuery` — same eventHistory/rescheduleHistory
   * projection-out and pagination bounds as every other list method here. */
  public async listForSuperAdmin(
    filter: BookingListFilter & {
      businessId?: Types.ObjectId | string | undefined;
      q?: string | undefined;
    },
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    const query = this.buildListQuery({
      ...filter,
      ...(filter.businessId ? { businessId: filter.businessId } : {}),
    });

    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      query["$or"] = [
        { reference: pattern },
        { "customer.contact.firstName": pattern },
        { "customer.contact.lastName": pattern },
        { "customer.contact.normalizedEmail": pattern },
      ];
    }

    return this.runPaginatedQuery(query, pagination);
  }

  /** Batch 11 — Super Admin Business list's "bookings" count column: ONE reduced `$group` for
   * every Business on the current page, never N individual `countDocuments` calls. */
  public async countByBusinessIds(
    businessIds: Array<Types.ObjectId | string>,
  ): Promise<Map<string, number>> {
    if (businessIds.length === 0) {
      return new Map();
    }

    const objectIds = businessIds.map((id) => new Types.ObjectId(id));
    const rows = await BookingModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { businessId: { $in: objectIds } } },
      { $group: { _id: "$businessId", count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map((row) => [String(row._id), row.count]));
  }

  /** Batch 11 — Super Admin dashboard's platform-wide booking-status counts, ONE reduced
   * `$group` over the whole collection (bounded by nothing since it's a small, fixed-cardinality
   * group-by, never a per-document scan result set). */
  public async countAllByStatus(): Promise<Record<BookingStatus, number>> {
    const rows = await BookingModel.aggregate<{ _id: BookingStatus; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();

    const counts = Object.fromEntries(bookingStatuses.map((status) => [status, 0])) as Record<
      BookingStatus,
      number
    >;
    for (const row of rows) {
      counts[row._id] = row.count;
    }
    return counts;
  }

  /** Batch 12 — Super Admin Booking Analytics: same shape as `countAllByStatus`, bounded to a
   * `createdAt` period. Booking-creation metrics use `createdAt`, never `schedule.startAt` (see
   * the module's own doc comment distinguishing "when a booking record was made" from "when the
   * appointment happens"). */
  public async countByStatusInRange(
    from: Date,
    to: Date,
    businessId?: Types.ObjectId | string,
  ): Promise<Record<BookingStatus, number>> {
    const match: Record<string, unknown> = { createdAt: { $gte: from, $lt: to } };
    if (businessId) {
      match["businessId"] = businessId;
    }
    const rows = await BookingModel.aggregate<{ _id: BookingStatus; count: number }>([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();

    const counts = Object.fromEntries(bookingStatuses.map((status) => [status, 0])) as Record<
      BookingStatus,
      number
    >;
    for (const row of rows) {
      counts[row._id] = row.count;
    }
    return counts;
  }

  /** Batch 12 — monthly time-series of bookings created within [from, to), UTC-month-bucketed.
   * Always returns a fully zero-filled bucket per month in range (never a sparse series a chart
   * would have to reinterpret). */
  public async countCreatedByMonth(
    from: Date,
    to: Date,
  ): Promise<Array<{ year: number; month: number; count: number }>> {
    const rows = await BookingModel.aggregate<{
      _id: { year: number; month: number };
      count: number;
    }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    const countByKey = new Map(rows.map((row) => [`${row._id.year}-${row._id.month}`, row.count]));
    return zeroFilledMonths(from, to).map(({ year, month }) => ({
      year,
      month,
      count: countByKey.get(`${year}-${month}`) ?? 0,
    }));
  }

  /** Batch 12 — the SAME Manual/New/Returning classification `lib/bookings/format.ts`'s
   * `bookingClientBadge` already uses on the frontend (source==="MANUAL" -> Manual; else
   * platformFeeCents>0 -> New, else Returning) — computed server-side here so Booking Analytics
   * never needs to re-derive it per row. */
  public async aggregateClientTypeSplit(
    from: Date,
    to: Date,
  ): Promise<{ manual: number; newBooking: number; returning: number }> {
    const rows = await BookingModel.aggregate<{
      _id: "MANUAL" | "NEW" | "RETURNING";
      count: number;
    }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$source", "MANUAL"] },
              "MANUAL",
              { $cond: [{ $gt: ["$financials.platformFeeCents", 0] }, "NEW", "RETURNING"] },
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    const counts = { manual: 0, newBooking: 0, returning: 0 };
    for (const row of rows) {
      if (row._id === "MANUAL") counts.manual = row.count;
      else if (row._id === "NEW") counts.newBooking = row.count;
      else counts.returning = row.count;
    }
    return counts;
  }

  /** Batch 12 — Premises (AT_BUSINESS_LOCATION) vs Mobile (TRAVEL_TO_CUSTOMER) split, from the
   * Booking's own `fulfilment.mode` snapshot (never re-derived from the Business's CURRENT
   * `visitType`, which could have changed since the booking was made). */
  public async aggregateFulfilmentSplit(
    from: Date,
    to: Date,
  ): Promise<{ premises: number; mobile: number }> {
    const rows = await BookingModel.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: "$fulfilment.mode", count: { $sum: 1 } } },
    ]).exec();

    const counts = { premises: 0, mobile: 0 };
    for (const row of rows) {
      if (row._id === "AT_BUSINESS_LOCATION") counts.premises = row.count;
      else if (row._id === "TRAVEL_TO_CUSTOMER") counts.mobile = row.count;
    }
    return counts;
  }

  /** Batch 12 — per-Business booking stats for the whole period in ONE aggregation pass (Top
   * Businesses by booking count, no-show rate, return rate all read from this same result rather
   * than three separate collection scans). Not paginated: bounded by the number of distinct
   * Businesses with at least one booking in the period, which this platform's real scale keeps
   * small — the service layer sorts/slices for whichever "Top N by X" view is needed. */
  public async aggregateBusinessBookingStats(
    from: Date,
    to: Date,
    businessId?: Types.ObjectId | string,
  ): Promise<
    Array<{
      businessId: string;
      totalCount: number;
      completedCount: number;
      noShowCount: number;
      manualCount: number;
      newCount: number;
      returningCount: number;
    }>
  > {
    const match: Record<string, unknown> = { createdAt: { $gte: from, $lt: to } };
    if (businessId) {
      match["businessId"] = businessId;
    }
    const rows = await BookingModel.aggregate<{
      _id: Types.ObjectId;
      totalCount: number;
      completedCount: number;
      noShowCount: number;
      manualCount: number;
      newCount: number;
      returningCount: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: "$businessId",
          totalCount: { $sum: 1 },
          completedCount: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
          noShowCount: {
            $sum: {
              $cond: [{ $in: ["$status", ["NO_SHOW_CHARGED", "NO_SHOW_WAIVED"]] }, 1, 0],
            },
          },
          manualCount: { $sum: { $cond: [{ $eq: ["$source", "MANUAL"] }, 1, 0] } },
          newCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$source", "MANUAL"] },
                    { $gt: ["$financials.platformFeeCents", 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          returningCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$source", "MANUAL"] },
                    { $lte: ["$financials.platformFeeCents", 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).exec();

    return rows.map((row) => ({
      businessId: String(row._id),
      totalCount: row.totalCount,
      completedCount: row.completedCount,
      noShowCount: row.noShowCount,
      manualCount: row.manualCount,
      newCount: row.newCount,
      returningCount: row.returningCount,
    }));
  }

  /** Batch 12 — Top Services by booking count. Groups by the real, immutable `serviceId` and
   * reads the NAME from each line's own persisted `serviceSnapshot.name` (never a live Service
   * lookup) — an archived/deleted Service still resolves correctly since the name traveled with
   * the Booking at creation time. */
  public async aggregateTopServices(
    from: Date,
    to: Date,
    limit: number,
    businessId?: Types.ObjectId | string,
  ): Promise<Array<{ serviceId: string; name: string; businessId: string; count: number }>> {
    const match: Record<string, unknown> = { createdAt: { $gte: from, $lt: to } };
    if (businessId) {
      match["businessId"] = businessId;
    }
    const rows = await BookingModel.aggregate<{
      _id: Types.ObjectId;
      name: string;
      businessId: Types.ObjectId;
      count: number;
    }>([
      { $match: match },
      { $unwind: "$serviceLines" },
      {
        $group: {
          _id: "$serviceLines.serviceId",
          name: { $first: "$serviceLines.serviceSnapshot.name" },
          businessId: { $first: "$businessId" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]).exec();

    return rows.map((row) => ({
      serviceId: String(row._id),
      name: row.name,
      businessId: String(row.businessId),
      count: row.count,
    }));
  }

  /** Batch 12 — global (platform-wide, never per-Business) Customer activity for the Customer
   * Analytics funnel: how many distinct platform Users have EVER completed a real booking
   * (`customer.customerUserId` is only ever set for a linked Customer account — see the sparse
   * index's own comment), and how many of those have more than one. Deliberately all-time, not
   * period-bounded — "has this Customer ever booked" is not a question a date range can answer
   * without silently changing its meaning. */
  public async aggregateCustomerActivity(): Promise<{
    activatedCount: number;
    retainedCount: number;
  }> {
    const rows = await BookingModel.aggregate<{ activatedCount: number; retainedCount: number }>([
      { $match: { "customer.customerUserId": { $exists: true } } },
      { $group: { _id: "$customer.customerUserId", bookingCount: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          activatedCount: { $sum: 1 },
          retainedCount: { $sum: { $cond: [{ $gte: ["$bookingCount", 2] }, 1, 0] } },
        },
      },
    ]).exec();

    return {
      activatedCount: rows[0]?.activatedCount ?? 0,
      retainedCount: rows[0]?.retainedCount ?? 0,
    };
  }

  /** Batch — Business Dashboard "Analytics" tab's Busiest Days heatmap: real, per-Business
   * booking counts grouped by the LOCAL day-of-week the appointment actually happens on
   * (`schedule.startAt`, matching this repository's own "appointment-time" vs "creation-time"
   * distinction — see `countCreatedByMonth`'s own doc comment for the inverse case), bucketed
   * in the Business's own IANA timezone via Mongo's native `timezone` aggregation option (the
   * SAME DST-safe boundary-crossing concern `common/time/business-clock.ts` exists to rule out
   * everywhere else — done here in the aggregation itself since Mongo's `$dayOfWeek` already
   * supports it natively, rather than pulling raw documents into Node to re-derive it).
   * Returns Mongo's own `$dayOfWeek` convention (1=Sunday ... 7=Saturday); the service layer
   * re-maps this to the Monday-first order every other weekday vocabulary in this codebase uses
   * (`common/time/business-clock.ts`'s `daysOfWeek`). */
  public async aggregateBookingCountsByWeekday(
    businessId: Types.ObjectId | string,
    from: Date,
    to: Date,
    timezone: string,
  ): Promise<Array<{ mongoDayOfWeek: number; count: number }>> {
    const rows = await BookingModel.aggregate<{ _id: number; count: number }>([
      { $match: { businessId, "schedule.startAt": { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dayOfWeek: { date: "$schedule.startAt", timezone } },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    return rows.map((row) => ({ mongoDayOfWeek: row._id, count: row.count }));
  }

  private buildListQuery(
    input: { businessId?: Types.ObjectId | string | undefined } & Record<string, unknown> &
      BookingListFilter,
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
    if (input.source && input.source.length > 0) {
      query["source"] = { $in: input.source };
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
