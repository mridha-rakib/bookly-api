import { DateTime } from "luxon";
import type { DayOfWeek } from "../../modules/staff/staff-schedule.types.js";
import { daysOfWeek } from "../../modules/staff/staff-schedule.types.js";
import {
  isValidCanonicalTime,
  minutesSinceMidnight,
} from "../../modules/staff/staff-schedule.utils.js";

/**
 * DST-safe local<->UTC conversion for a Business's own IANA time zone
 * (Business.timezone) — the piece `common/time/timezone.ts` explicitly deferred ("that is
 * Phase 2 availability-engine work"). Luxon is the one dependency added for this batch (none
 * existed before): Node's `Intl` alone can validate a zone identifier (see timezone.ts) but
 * has no ergonomic "give me the UTC instant for this business-local wall-clock time,
 * DST-aware" primitive, and hand-rolling that with raw `Intl.DateTimeFormat` offset-probing is
 * a well-known correctness trap (silently wrong around a DST transition) — exactly the class
 * of bug this module exists to rule out. Every other time concept in this codebase (canonical
 * "HH:mm" parsing/formatting, minutesSinceMidnight) still goes through
 * staff-schedule.utils.ts — this module only adds the local<->UTC boundary crossing.
 *
 * DST policy (explicit, not incidental):
 *  - Spring-forward gap (a local wall-clock time that never occurs, e.g. 02:30 during a
 *    02:00->03:00 jump): luxon's default `fromObject` resolves this by advancing to the
 *    equivalent point after the jump (matches the Zone's own convention, verified by test).
 *    We keep luxon's default rather than rejecting the input — an availability slot generated
 *    for a skipped local time is a business/opening-hours-configuration edge case, not
 *    something the engine should hard-fail on.
 *  - Fall-back duplicate local time (a local wall-clock time that occurs twice, e.g. 01:30
 *    during a 02:00->01:00 repeat): luxon's default resolves to the FIRST occurrence (the
 *    pre-transition offset). Explicit and tested — never left to chance.
 */

export type BusinessLocalDate = {
  /** Canonical "YYYY-MM-DD", business-local calendar date. */
  dateStr: string;
  dayOfWeek: DayOfWeek;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const requireValidDateStr = (dateStr: string): void => {
  if (!isoDatePattern.test(dateStr)) {
    throw new Error(`Invalid canonical date: ${dateStr}`);
  }
};

/**
 * Business-local "YYYY-MM-DD" + canonical "HH:mm" -> absolute UTC instant, in the given IANA
 * zone. This is the one function every slot-generation/reservation boundary crossing must go
 * through — never ad hoc `new Date(...)` string concatenation, which silently assumes the
 * server's own timezone.
 */
export const businessLocalToUtc = (timezone: string, dateStr: string, hhmm: string): Date => {
  requireValidDateStr(dateStr);

  if (!isValidCanonicalTime(hhmm)) {
    throw new Error(`Invalid canonical time: ${hhmm}`);
  }

  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const minutes = minutesSinceMidnight(hhmm);

  const dt = DateTime.fromObject(
    { year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 },
    { zone: timezone },
  );

  if (!dt.isValid) {
    throw new Error(`Cannot resolve ${dateStr} ${hhmm} in zone ${timezone}: ${dt.invalidReason}`);
  }

  return dt.toUTC().toJSDate();
};

/** The inverse: an absolute UTC instant -> the business-local calendar date + weekday it falls
 * on, in the given IANA zone. This is what "determine weekday in Business.timezone" means in
 * practice — never `date.getDay()` (server-timezone-dependent) and never UTC weekday. */
export const utcToBusinessLocalDate = (timezone: string, instant: Date): BusinessLocalDate => {
  const dt = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timezone);

  if (!dt.isValid) {
    throw new Error(
      `Cannot resolve ${instant.toISOString()} in zone ${timezone}: ${dt.invalidReason}`,
    );
  }

  const dateStr = dt.toFormat("yyyy-MM-dd");
  // Luxon's weekday is 1 (Monday) - 7 (Sunday) — matches daysOfWeek's own Monday-first order.
  const dayOfWeek = daysOfWeek[dt.weekday - 1];

  if (!dayOfWeek) {
    throw new Error(`Unexpected luxon weekday ${dt.weekday} for ${instant.toISOString()}`);
  }

  return { dateStr, dayOfWeek };
};

/** The business-local canonical "HH:mm" clock time an absolute UTC instant falls on, in the
 * given IANA zone — used to compare an occupied interval's end against a business-local
 * opening-hours boundary expressed in "HH:mm". */
export const utcToBusinessLocalTime = (timezone: string, instant: Date): string => {
  const dt = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timezone);

  if (!dt.isValid) {
    throw new Error(
      `Cannot resolve ${instant.toISOString()} in zone ${timezone}: ${dt.invalidReason}`,
    );
  }

  return dt.toFormat("HH:mm");
};

/** The weekday a "YYYY-MM-DD" calendar date string falls on — pure calendar arithmetic, no
 * timezone conversion needed (a date string is already a business-local calendar date by the
 * time it reaches this function; see AvailabilityService). */
export const dayOfWeekForDate = (dateStr: string): DayOfWeek => {
  requireValidDateStr(dateStr);
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = DateTime.fromObject({ year, month, day });
  const dayOfWeek = daysOfWeek[dt.weekday - 1];

  if (!dayOfWeek) {
    throw new Error(`Unexpected luxon weekday ${dt.weekday} for ${dateStr}`);
  }

  return dayOfWeek;
};

/** Adds whole calendar days to a "YYYY-MM-DD" string, in no particular zone (pure calendar
 * arithmetic — used to walk a requested date range one business-local day at a time). */
export const addCalendarDays = (dateStr: string, days: number): string => {
  requireValidDateStr(dateStr);
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  return DateTime.fromObject({ year, month, day }).plus({ days }).toFormat("yyyy-MM-dd");
};

/** Inclusive list of "YYYY-MM-DD" calendar dates from `fromDateStr` to `toDateStr`. Bounded by
 * the caller (see AvailabilityService's own range guard) — never called with an unbounded
 * span. */
export const enumerateCalendarDates = (fromDateStr: string, toDateStr: string): string[] => {
  requireValidDateStr(fromDateStr);
  requireValidDateStr(toDateStr);

  const dates: string[] = [];
  let cursor = fromDateStr;

  while (cursor <= toDateStr) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }

  return dates;
};
