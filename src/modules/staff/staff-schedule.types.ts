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

/** One shift for one day — the confirmed product rule allows at most one per day. */
export type ScheduleDay = {
  dayOfWeek: DayOfWeek;
  /** Canonical 24-hour "HH:mm", e.g. "09:00". Never displayed to users directly. */
  startTime: string;
  endTime: string;
};
