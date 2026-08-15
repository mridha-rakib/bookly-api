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
