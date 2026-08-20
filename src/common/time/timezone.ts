/**
 * IANA time zone validation, shared by any module that persists a Business-local time zone
 * (currently just Business.timezone — see business.model.ts). Deliberately uses the runtime's
 * own ICU/Intl implementation rather than a moment-timezone/luxon-style dependency: Node's
 * `Intl.DateTimeFormat` constructor throws a RangeError for an unrecognized `timeZone` option
 * and is otherwise a no-op, which is a complete, always-up-to-date IANA validity check with
 * zero extra dependencies (the api engines field pins Node >=24, which ships a full ICU build).
 *
 * This module intentionally does NOT perform DST-safe local<->UTC conversion — that is Phase 2
 * availability-engine work. It only answers "is this a real IANA zone identifier".
 */

/** Cyprus is Bookly's current market; every Business defaults here unless explicitly set. */
export const DEFAULT_BUSINESS_TIMEZONE = "Europe/Nicosia";

export const isValidIanaTimeZone = (value: string): boolean => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  try {
    // The constructor eagerly validates `timeZone`; an unknown identifier throws synchronously.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves a Business's effective time zone, defaulting legacy documents that predate this
 * field (added after Business documents already existed in some environments) to
 * {@link DEFAULT_BUSINESS_TIMEZONE} without requiring a destructive backfill migration.
 * Verified (see the Business.timezone integration test) that this Mongoose version applies the
 * schema default even when hydrating a document that genuinely lacks the field in storage, so a
 * plain `findById`/`findOne` already self-heals — but that default-on-hydrate behavior does NOT
 * apply to `.lean()` queries or aggregation pipeline results (both skip Document instantiation
 * entirely and return the raw stored shape), so any code path reading a Business's timezone
 * through one of those must call this helper explicitly rather than assume the field is present.
 */
export const resolveBusinessTimezone = (timezone: string | undefined): string =>
  timezone && isValidIanaTimeZone(timezone) ? timezone : DEFAULT_BUSINESS_TIMEZONE;
