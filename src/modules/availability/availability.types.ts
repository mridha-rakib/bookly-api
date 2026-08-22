/**
 * Bounded so a request can never trigger unbounded per-minute slot generation across a huge
 * span — a deliberately tighter cap than Booking's MAX_BOOKING_RANGE_DAYS (366, a read of
 * already-scheduled Bookings), since this endpoint does real generation work per day in the
 * range, not just an indexed read. ~2 months is generous for any realistic "Time step" UI
 * (day/week/month view) while keeping worst-case work bounded.
 */
export const MAX_AVAILABILITY_RANGE_DAYS = 62;

/** Sentinel staff selection matching the existing frontend's "no-preference"/"Assign
 * automatically to any professional" concept (confirmed via ProfessionalsStep.tsx) — never
 * invented, this batch just gives the backend a matching vocabulary. */
export const ANY_STAFF = "ANY" as const;
