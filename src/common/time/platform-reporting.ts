import { DateTime } from "luxon";

import { addCalendarDays, businessLocalToUtc } from "./business-clock.js";

/**
 * P2.2.1 (Owner decision E17) — Super Admin platform reporting (Overview + Analytics) uses the
 * Cyprus calendar. IANA zone, never a fixed offset: Cyprus is UTC+2 in winter and UTC+3 in
 * summer, and its DST changes happen at 03:00/04:00 local, so local midnight always exists.
 *
 * Business-scoped reporting keeps each Business's own `Business.timezone` — this constant is
 * used only by Super Admin platform reporting.
 */
export const PLATFORM_REPORTING_TIMEZONE = "Europe/Nicosia";

/** Platform Finance allows at most 92 Cyprus calendar days. Only midnight-aligned
 * calendar windows may exceed 92 x 24 hours at autumn fallback; other instants retain
 * the elapsed-time cap. Invalid/unbounded windows always fail. */
export const isBoundedPlatformFinanceWindow = (from: Date, to: Date): boolean => {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
    return false;
  const start = DateTime.fromJSDate(from, { zone: PLATFORM_REPORTING_TIMEZONE });
  const end = DateTime.fromJSDate(to, { zone: PLATFORM_REPORTING_TIMEZONE });
  if (start.equals(start.startOf("day")) && end.equals(end.startOf("day")))
    return end.toMillis() <= start.plus({ days: 92 }).toMillis();
  return to.getTime() - from.getTime() <= 92 * 24 * 60 * 60 * 1000;
};

/** First instant of Cyprus calendar date `YYYY-MM-DD`, as a UTC instant. */
export const platformDayStartUtc = (dateStr: string): Date =>
  businessLocalToUtc(PLATFORM_REPORTING_TIMEZONE, dateStr, "00:00");

/** Exclusive end of an inclusive Cyprus calendar date: the first instant of the next day. */
export const platformDayEndExclusiveUtc = (dateStr: string): Date =>
  businessLocalToUtc(PLATFORM_REPORTING_TIMEZONE, addCalendarDays(dateStr, 1), "00:00");

/** First instant of the Cyprus calendar month containing `instant`, shifted by `monthOffset`. */
export const platformMonthStartUtc = (instant: Date, monthOffset = 0): Date =>
  DateTime.fromJSDate(instant, { zone: "utc" })
    .setZone(PLATFORM_REPORTING_TIMEZONE)
    .startOf("month")
    .plus({ months: monthOffset })
    .toUTC()
    .toJSDate();

/** A Cyprus calendar date (`YYYY-MM-DD`) rather than an exact ISO instant. */
export const isPlatformCalendarDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Lower bound of a Super Admin reporting range: a Cyprus date starts at Cyprus midnight; an
 * exact ISO instant (legacy form) is used as given. */
export const platformRangeFrom = (value: string): Date =>
  isPlatformCalendarDate(value) ? platformDayStartUtc(value) : new Date(value);

/** Exclusive upper bound: an inclusive Cyprus end date ends at the next Cyprus midnight; an
 * exact ISO instant (legacy form) is used as given. */
export const platformRangeTo = (value: string): Date =>
  isPlatformCalendarDate(value) ? platformDayEndExclusiveUtc(value) : new Date(value);
