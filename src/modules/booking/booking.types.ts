/**
 * BOOKLY_MANAGED = Bookly handles scheduling AND the online payment lifecycle (deposit,
 * platform fee, cancellation/no-show charging — all later phases). MANUAL = a Business
 * Owner/Supervisor records an appointment that is financially handled entirely outside Bookly;
 * Bookly only provides scheduling/calendar/history for it (confirmed product rule). This flag
 * is what every future financial code path must branch on before charging anything.
 */
export const bookingSources = ["BOOKLY_MANAGED", "MANUAL"] as const;
export type BookingSource = (typeof bookingSources)[number];

/**
 * Who actually created the Booking — distinct from who the Booking is *for* (see
 * BookingCustomer in booking.model.ts). STAFF is deliberately excluded: no product rule grants
 * Staff booking-creation rights in this phase (confirmed rule W).
 */
export const bookingActorRoles = ["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR"] as const;
export type BookingActorRole = (typeof bookingActorRoles)[number];

/**
 * Canonical lifecycle vocabulary (confirmed rule P/U). Deliberately NOT the inconsistent
 * strings the current mock frontend uses (see audit) — this is the vocabulary Phase 2/3's
 * state-machine work will transition between. Defined now so the Booking root has a real,
 * finite `status` type; the transition rules themselves (who may move which status to which,
 * the 90-minute no-show timer, cancellation-fee computation, etc.) are explicitly NOT
 * implemented in this phase.
 */
export const bookingStatuses = [
  "UPCOMING",
  "COMPLETED",
  "PENDING",
  "NO_SHOW_CHARGED",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
] as const;
export type BookingStatus = (typeof bookingStatuses)[number];

/**
 * A Booking service line's pricing mode. PACKAGE is included here even though
 * Service.pricingMode (services/service.types.ts) excludes it — on Service, "package" is a
 * separate `isPackageDeal` boolean because a Service is either a package or has one of
 * FIXED/HOURLY/PER_PERSON; on a Booking line it is simpler to have one flat discriminant
 * covering all four booked-quantity shapes (confirmed rule I).
 */
export const bookingServiceLinePricingModes = ["FIXED", "HOURLY", "PER_PERSON", "PACKAGE"] as const;
export type BookingServiceLinePricingMode = (typeof bookingServiceLinePricingModes)[number];

/** Booking-level audit-history entry types (confirmed rule P). */
export const bookingEventTypes = ["CREATED", "STATUS_CHANGED", "RESCHEDULED"] as const;
export type BookingEventType = (typeof bookingEventTypes)[number];

/**
 * Explicit currency field from day one (confirmed rule R) — Bookly's current market is Cyprus
 * (EUR only). Adding a second currency later is additive to this array, not a schema
 * restructuring.
 */
export const bookingCurrencies = ["EUR"] as const;
export type BookingCurrency = (typeof bookingCurrencies)[number];

/** Maximum successful CUSTOMER-initiated reschedules per Booking (confirmed rule O). */
export const MAX_CUSTOMER_RESCHEDULE_COUNT = 2;

/** Bookly's first-booking platform fee formula inputs (confirmed rule M). Percentage of the
 * eligible basis, clamped between a floor and a ceiling — not a Business-configurable value. */
export const PLATFORM_FEE_PERCENT = 0.2;
export const PLATFORM_FEE_MIN_CENTS = 500;
export const PLATFORM_FEE_MAX_CENTS = 3500;
