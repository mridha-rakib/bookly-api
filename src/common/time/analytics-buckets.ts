import { DateTime } from "luxon";

/** Batch 12 — every UTC calendar month whose start falls within [from, to), inclusive of the
 * boundary months even if `to` cuts them short. Shared by every monthly-bucketed analytics
 * series (Booking/Business/Customer created-over-time) so a sparse Mongo result never reaches a
 * chart as anything but zero-filled. */
export const zeroFilledMonths = (
  from: Date,
  to: Date,
  timezone?: string,
): Array<{ year: number; month: number }> => {
  if (timezone) return zoneMonthsInRange(from, to, timezone);
  const months: Array<{ year: number; month: number }> = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
};

/** P2.2.1 — the same zero-filled series in a named IANA zone: every local calendar month that
 * overlaps the half-open window `[from, to)` (so an exclusive `to` at a local month start does not
 * add an empty trailing month). Pair with `$year`/`$month` `{ date, timezone }` grouping. */
const zoneMonthsInRange = (
  from: Date,
  to: Date,
  timezone: string,
): Array<{ year: number; month: number }> => {
  const local = (instant: Date) => DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timezone);
  const months: Array<{ year: number; month: number }> = [];
  let cursor = local(from).startOf("month");
  const last = local(new Date(Math.max(from.getTime(), to.getTime() - 1))).startOf("month");
  while (cursor <= last) {
    months.push({ year: cursor.year, month: cursor.month });
    cursor = cursor.plus({ months: 1 });
  }
  return months;
};
