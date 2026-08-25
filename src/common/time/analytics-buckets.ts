/** Batch 12 — every UTC calendar month whose start falls within [from, to), inclusive of the
 * boundary months even if `to` cuts them short. Shared by every monthly-bucketed analytics
 * series (Booking/Business/Customer created-over-time) so a sparse Mongo result never reaches a
 * chart as anything but zero-filled. */
export const zeroFilledMonths = (from: Date, to: Date): Array<{ year: number; month: number }> => {
  const months: Array<{ year: number; month: number }> = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
};
