/**
 * Pure display formatters for email templates and email payload builders. No business logic,
 * no money arithmetic — `formatMoney` divides by 100 for display only; every amount handed to
 * it is already a trusted persisted integer-cents value.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
};

/** `1234, "EUR"` -> `"€12.34"`. Display formatting only — never used to derive an amount. */
export const formatMoney = (cents: number, currency: string): string => {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const whole = Math.trunc(Math.abs(cents) / 100);
  const frac = String(Math.abs(cents) % 100).padStart(2, "0");
  const sign = cents < 0 ? "-" : "";
  return `${sign}${symbol}${whole}.${frac}`;
};

export const formatDateInTimezone = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);

export const formatTimeInTimezone = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

/** Whole minutes between two instants — a duration, not a currency value. */
export const durationMinutesBetween = (start: Date, end: Date): number =>
  Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
