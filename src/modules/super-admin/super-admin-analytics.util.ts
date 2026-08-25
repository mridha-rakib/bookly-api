/** Batch 12 — the ONE place every period-bounded Analytics service resolves an optional
 * `{fromDate?, toDate?}` query into a concrete `[from, to)` window: a rolling 365-day window
 * ending now when the caller didn't specify one (see super-admin.schema.ts's own doc comment —
 * a query-boundary default, never a fabricated data value). */
export const resolveAnalyticsPeriod = (query: {
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
}): { from: Date; to: Date } => {
  if (query.fromDate && query.toDate) {
    return { from: query.fromDate, to: query.toDate };
  }
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
  return { from, to };
};
