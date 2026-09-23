import type { ScheduleInterval } from "./staff-schedule.types.js";

const hhmmPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a canonical 24-hour "HH:mm" string (zero-padded, 00:00–23:59). */
export const isValidCanonicalTime = (value: string): boolean => hhmmPattern.test(value);

/**
 * Canonical "HH:mm" → minutes since midnight. Used for start/end comparisons instead of
 * string/lexicographic comparison, which would also happen to work for zero-padded HH:mm
 * but is less obviously correct at a glance — this is the explicit, intention-revealing form.
 * Throws for a non-canonical value; callers must validate with {@link isValidCanonicalTime}
 * first (schema validation already guarantees this in practice).
 */
export const minutesSinceMidnight = (hhmm: string): number => {
  const match = hhmmPattern.exec(hhmm);

  if (!match) {
    throw new Error(`Invalid canonical time: ${hhmm}`);
  }

  const [, hours, minutes] = match as unknown as [string, string, string];
  return Number(hours) * 60 + Number(minutes);
};

/**
 * The inverse of {@link minutesSinceMidnight}: minutes since midnight (0–1439) → canonical
 * "HH:mm". Added for the Availability Engine's AUTO-mode slot generation (booking.interval
 * stepping produces minute offsets that need to become canonical times for
 * {@link "../../common/time/business-clock.js".businessLocalToUtc}) — kept here rather than in
 * that module so all canonical-time <-> minutes conversion stays in one place, matching this
 * project's "no duplicate time math" convention.
 */
export const minutesToCanonicalTime = (minutes: number): string => {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new Error(`Invalid minutes since midnight: ${minutes}`);
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
};

/**
 * Canonical "HH:mm" (24-hour) → 12-hour display label, e.g. "09:00" -> "9:00 AM",
 * "13:30" -> "1:30 PM", "00:00" -> "12:00 AM", "12:00" -> "12:00 PM".
 */
export const formatCanonicalTime12Hour = (hhmm: string): string => {
  const match = hhmmPattern.exec(hhmm);

  if (!match) {
    throw new Error(`Invalid canonical time: ${hhmm}`);
  }

  const [, hoursRaw, minutes] = match as unknown as [string, string, string];
  const hours24 = Number(hoursRaw);
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${minutes} ${period}`;
};

/**
 * 12-hour display input (hour 1–12, minute 0–59, AM/PM) → canonical "HH:mm". This is the
 * inverse of {@link formatCanonicalTime12Hour}, used when a client sends a human-entered
 * time. Throws for an out-of-range hour/minute.
 */
export const parseTo12HourCanonical = (
  hour12: number,
  minute: number,
  period: "AM" | "PM",
): string => {
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) {
    throw new Error(`Invalid 12-hour hour: ${hour12}`);
  }

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid minute: ${minute}`);
  }

  const hours24 = period === "AM" ? hour12 % 12 : (hour12 % 12) + 12;
  return `${String(hours24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/**
 * Server-authoritative normalization for one weekday's `intervals[]` — NEVER trusts
 * client-side sorting/merging as final. Assumes each interval has already passed canonical
 * HH:mm validation and start < end (schema's job); this function:
 *   1. sorts ascending by startTime,
 *   2. rejects any pair that overlaps (share any minute) — the schema layer surfaces this as
 *      a validation error rather than silently resolving it,
 *   3. merges exactly-contiguous pairs (A.endTime === B.startTime) into one interval, so
 *      "09:00-13:00" + "13:00-17:00" persists as a single "09:00-17:00" interval.
 * Throws (as a plain Error; callers translate to their own error type) on overlap so this
 * can be reused by both the Zod schema's superRefine and the service-layer defense-in-depth
 * pass, matching this module's "no duplicate time math" convention.
 */
export const normalizeScheduleIntervals = (intervals: ScheduleInterval[]): ScheduleInterval[] => {
  const sorted = [...intervals].sort(
    (a, b) => minutesSinceMidnight(a.startTime) - minutesSinceMidnight(b.startTime),
  );

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) {
      continue;
    }
    if (minutesSinceMidnight(curr.startTime) < minutesSinceMidnight(prev.endTime)) {
      throw new Error(
        `Overlapping intervals: ${prev.startTime}-${prev.endTime} and ${curr.startTime}-${curr.endTime}`,
      );
    }
  }

  const merged: ScheduleInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.endTime === interval.startTime) {
      last.endTime = interval.endTime;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
};

/** True if any pair of intervals in the (already-sorted-or-not) list overlaps — share any
 * minute of the day. Used by schema validation to report the specific conflicting pair. */
export const intervalsOverlap = (a: ScheduleInterval, b: ScheduleInterval): boolean =>
  minutesSinceMidnight(a.startTime) < minutesSinceMidnight(b.endTime) &&
  minutesSinceMidnight(b.startTime) < minutesSinceMidnight(a.endTime);
