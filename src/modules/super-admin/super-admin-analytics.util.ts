import type { OwnershipAggregateBucket } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BookingFinancialTransactionType } from "../booking-financial-transaction/booking-financial-transaction.types.js";

/** The earliest instant any Bookly record can plausibly exist — used only as the lower `[from`
 * boundary of an "all time" analytics query (the caller passed neither `fromDate` nor
 * `toDate`). Not a fabricated data value: strictly a query boundary, same spirit as the
 * previous rolling-365-day default it replaces. */
export const ALL_TIME_FROM = new Date("2020-01-01T00:00:00.000Z");

/** BookingFinancialTransactionService.aggregateOwnedBySource enforces a hard
 * `MAX_BUSINESS_LEDGER_RANGE_DAYS` (92) cap. Every *explicit* range wider than this is walked
 * in <=90-day chunks (90, for margin) and merged — identical orchestration to
 * DashboardAnalyticsService's own `LEDGER_CHUNK_DAYS`, never a second aggregation
 * implementation. An "all time" query skips chunking entirely and uses the unbounded
 * `aggregateAllTimeOwnedBySource` primitive instead. */
const LEDGER_CHUNK_DAYS = 90;

/** Rolling month-bucketed trend charts (Booking/Business/Customer "created over time") show at
 * most this many trailing months when the query is "all time" — the stat totals above them stay
 * genuinely all-time, only the bar series is windowed so the chart never renders dozens of
 * mostly-empty months. An explicit `[from, to)` range is always charted in full. */
const ALL_TIME_SERIES_MONTHS = 12;

const oneDayMs = 24 * 60 * 60 * 1000;

export type ResolvedAnalyticsPeriod = {
  from: Date;
  to: Date;
  /** True when the caller supplied neither `fromDate` nor `toDate` — revenue then comes from the
   * unbounded all-time ledger primitive and trend series are windowed to the trailing year. */
  isAllTime: boolean;
};

/** The ONE place every period-bounded Analytics service resolves an optional `{fromDate?,
 * toDate?}` query into a concrete `[from, to)` window. Both present → that exact range. Neither
 * present → an all-time window (`ALL_TIME_FROM` … now). The schema already rejects "one without
 * the other", so a half-open pair never reaches here. */
export const resolveAnalyticsPeriod = (query: {
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
}): ResolvedAnalyticsPeriod => {
  if (query.fromDate && query.toDate) {
    return { from: query.fromDate, to: query.toDate, isAllTime: false };
  }
  return { from: ALL_TIME_FROM, to: new Date(), isAllTime: true };
};

/** The `[from, to)` window a month-bucketed trend series should cover: the full range for an
 * explicit query, or just the trailing `ALL_TIME_SERIES_MONTHS` for an all-time one. */
export const resolveSeriesWindow = (period: ResolvedAnalyticsPeriod): { from: Date; to: Date } => {
  if (!period.isAllTime) {
    return { from: period.from, to: period.to };
  }
  const to = period.to;
  const from = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - (ALL_TIME_SERIES_MONTHS - 1), 1),
  );
  return { from, to };
};

/** Splits `[from, to)` into consecutive <=`LEDGER_CHUNK_DAYS`-day sub-windows. Exported for the
 * services that aggregate ledger money over a user-chosen range wider than the 92-day cap. */
export const chunkRange = (from: Date, to: Date): Array<{ from: Date; to: Date }> => {
  const chunkMs = LEDGER_CHUNK_DAYS * oneDayMs;
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = from;
  while (cursor < to) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, to.getTime()));
    chunks.push({ from: cursor, to: chunkEnd });
    cursor = chunkEnd;
  }
  return chunks.length > 0 ? chunks : [{ from, to }];
};

/** Merges ownership buckets from several chunk aggregations into one set, summing `totalCents`
 * and `count` per `(businessId?, type, sourceType)` — the same identity
 * `aggregateBusinessOwnedBySource` groups on. */
const mergeOwnershipBuckets = (buckets: OwnershipAggregateBucket[]): OwnershipAggregateBucket[] => {
  const merged = new Map<string, OwnershipAggregateBucket>();
  for (const bucket of buckets) {
    const key = `${bucket.businessId ?? ""}|${bucket.type}|${bucket.sourceType ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.totalCents += bucket.totalCents;
      existing.count += bucket.count;
    } else {
      merged.set(key, { ...bucket });
    }
  }
  return [...merged.values()];
};

/**
 * Ownership-aware ledger aggregation for an Analytics period, WITHOUT ever tripping the 92-day
 * `aggregateOwnedBySource` guard:
 *  - all-time → the unbounded `aggregateAllTimeOwnedBySource` primitive (one reduced `$group`,
 *    the same read Super Admin Finance's own all-time banner uses);
 *  - explicit range → `aggregateOwnedBySource` run per <=90-day chunk, merged.
 *
 * Pure orchestration over the SAME shared primitives finance-ownership.ts consumes — no revenue
 * formula is defined or altered here (rule: "never calculate financial ownership independently
 * inside a new Analytics service").
 */
export const aggregateOwnershipForPeriod = async (
  financialTransactionService: BookingFinancialTransactionService,
  input: {
    types: BookingFinancialTransactionType[];
    period: ResolvedAnalyticsPeriod;
    groupByBusiness?: boolean;
  },
): Promise<OwnershipAggregateBucket[]> => {
  const groupByBusiness =
    input.groupByBusiness === undefined ? {} : { groupByBusiness: input.groupByBusiness };

  if (input.period.isAllTime) {
    return financialTransactionService.aggregateAllTimeOwnedBySource({
      types: input.types,
      ...groupByBusiness,
    });
  }

  const chunks = chunkRange(input.period.from, input.period.to);
  const perChunk = await Promise.all(
    chunks.map((chunk) =>
      financialTransactionService.aggregateOwnedBySource({
        types: input.types,
        unclaimedOnly: false,
        from: chunk.from,
        to: chunk.to,
        ...groupByBusiness,
      }),
    ),
  );
  return mergeOwnershipBuckets(perChunk.flat());
};
