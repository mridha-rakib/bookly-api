/**
 * Canonical day-of-week representation used by StaffSchedule. No existing convention for
 * this exists elsewhere in the repository (Business has no opening-hours model yet), so
 * this establishes one: uppercase English day names, Monday-first (matches the existing
 * Add Staff form's Mon..Sun chip order).
 */
export const daysOfWeek = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type DayOfWeek = (typeof daysOfWeek)[number];

/** One contiguous working interval within a day. Canonical 24-hour "HH:mm", e.g. "09:00".
 * Never displayed to users directly. */
export type ScheduleInterval = {
  startTime: string;
  endTime: string;
};

/** One weekday's working hours — zero or more non-overlapping, sorted, non-contiguous
 * intervals (split shifts). Product rule: a booking's occupied window must fit entirely
 * inside exactly ONE interval; gaps between intervals are unavailable (breaks). Empty
 * `intervals` means "no hours configured yet" — distinct from being in `offDays`. */
export type ScheduleDay = {
  dayOfWeek: DayOfWeek;
  intervals: ScheduleInterval[];
};
