import type { Types } from "mongoose";
import { IntegrationError } from "../integration/integration.errors.js";
import type { CalendarTaskReference } from "./package-calendar-contract.js";

/** The production rollout authority remains disabled pending independent approval. */
export class PackageCalendarWriteAuthorityUnavailableError extends Error {
  readonly code = "PACKAGE_CALENDAR_WRITE_AUTHORITY_UNAVAILABLE";
  readonly statusCode = 503;
  constructor() {
    super(
      "Package Calendar production delivery requires independent verification and rollout approval",
    );
    this.name = "PackageCalendarWriteAuthorityUnavailableError";
  }
}

export class PackageCalendarProviderError extends IntegrationError {
  constructor(
    readonly kind:
      | "BLOCKED_AUTHORITY"
      | "RETRYABLE_FAILURE"
      | "PERMANENT_FAILURE"
      | "UNKNOWN_OUTCOME",
    readonly definitiveNoEffect = false,
  ) {
    super("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
    this.name = "PackageCalendarProviderError";
  }
}

/**
 * P2C — desired-state Google Calendar reconciliation for first-class Package Bookings.
 *
 * Shared mapping/port and retained engineering reconciler. The real adapter's `deliver` method
 * routes both unregistered consumers through package-calendar-dispatch.ts and its durable
 * Booking journal. The raw reconciliation path is retained for isolated engineering ports;
 * it does not grant production activation, release decisions or provider send permissions.
 *
 * Identity: an event created here uses the deterministic id `b<bookingId hex>` (Google
 * base32hex-compatible). This is a reconciliation key, not an exactly-once guarantee:
 * Google does not guarantee collision detection at creation, and tombstones can disappear.
 * Only an explicitly authorized first attempt may insert. A retry that cannot observe the
 * original event fails closed. Writes are followed by read-back before reporting DONE.
 */

export type PackageCalendarObservation =
  | { outcome: "NOT_CONNECTED" }
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "FOUND";
      status: string;
      startAt: Date | null;
      endAt: Date | null;
      marker: { booklyBookingId?: string; booklyBusinessId?: string };
      etag?: string;
    };

export type PackageCalendarEvent = {
  summary: string;
  description: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
};

/** Business-scoped; the implementation resolves that Business's own connected calendar. */
export type PackageCalendarDeliveryPort = {
  /** Present on the real adapter: both consumers share the durable Booking journal. */
  deliver?(reference: CalendarTaskReference): Promise<PackageCalendarOutcome | "SKIPPED">;
  read(businessId: string, eventId: string): Promise<PackageCalendarObservation>;
  insert(
    businessId: string,
    eventId: string,
    event: PackageCalendarEvent,
    marker: { booklyBookingId: string; booklyBusinessId: string },
    requestId?: string,
  ): Promise<"CREATED" | "ALREADY_EXISTS" | "NOT_CONNECTED">;
  patchSchedule(
    businessId: string,
    eventId: string,
    schedule: { startAt: Date; endAt: Date; timezone: string },
    ifMatch?: string,
    requestId?: string,
  ): Promise<"UPDATED" | "NOT_FOUND" | "NOT_CONNECTED" | "PRECONDITION_FAILED">;
  remove(
    businessId: string,
    eventId: string,
    ifMatch?: string,
    requestId?: string,
  ): Promise<"DELETED" | "NOT_CONNECTED" | "PRECONDITION_FAILED">;
};

export const packageCalendarEventId = (bookingId: Types.ObjectId): string =>
  `b${bookingId.toHexString()}`;

export const CANCELLED_BOOKING_STATUSES: ReadonlySet<string> = new Set([
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
]);

export type PackageCalendarDesired =
  | ({ kind: "PRESENT" } & PackageCalendarEvent)
  | { kind: "ABSENT" };

export type PackageCalendarOutcome = "DONE" | "RETRY" | "BLOCKED_UNVERIFIED";

export const reconcilePackageCalendarEvent = async (
  port: PackageCalendarDeliveryPort,
  input: {
    businessId: string;
    bookingId: Types.ObjectId;
    /** A recorded link alone is insufficient ownership proof without a durable destination. */
    recordedEventId?: string | undefined;
    /** Only the initial batch task's first claim; never a retry or lifecycle task. */
    allowInsert?: boolean;
    desired: PackageCalendarDesired;
  },
): Promise<PackageCalendarOutcome> => {
  const deterministic = packageCalendarEventId(input.bookingId);
  const eventId = input.recordedEventId ?? deterministic;
  const bookingId = input.bookingId.toHexString();
  // A recorded link may belong to an earlier Google account. Require both private markers;
  // unmarked legacy events need a durable destination binding before migration is safe.
  const owned = (o: Extract<PackageCalendarObservation, { outcome: "FOUND" }>) =>
    o.marker.booklyBookingId === bookingId && o.marker.booklyBusinessId === input.businessId;
  const matchesTimes = (
    o: Extract<PackageCalendarObservation, { outcome: "FOUND" }>,
    d: Extract<PackageCalendarDesired, { kind: "PRESENT" }>,
  ) => o.startAt?.getTime() === d.startAt.getTime() && o.endAt?.getTime() === d.endAt.getTime();

  const first = await port.read(input.businessId, eventId);
  if (first.outcome === "NOT_CONNECTED") return "BLOCKED_UNVERIFIED";

  if (input.desired.kind === "ABSENT") {
    if (first.outcome === "NOT_FOUND" || first.status === "cancelled") return "DONE";
    if (!owned(first)) return "BLOCKED_UNVERIFIED";
    if ((await port.remove(input.businessId, eventId)) === "NOT_CONNECTED")
      return "BLOCKED_UNVERIFIED";
    const after = await port.read(input.businessId, eventId);
    return after.outcome === "NOT_FOUND" ||
      (after.outcome === "FOUND" && after.status === "cancelled")
      ? "DONE"
      : "RETRY";
  }

  const desired = input.desired;
  const verifyPresent = async (): Promise<PackageCalendarOutcome> => {
    const after = await port.read(input.businessId, eventId);
    if (after.outcome === "NOT_CONNECTED") return "BLOCKED_UNVERIFIED";
    if (after.outcome === "NOT_FOUND") return "RETRY";
    if (!owned(after) || after.status !== "confirmed") return "BLOCKED_UNVERIFIED";
    return matchesTimes(after, desired) ? "DONE" : "RETRY";
  };

  if (first.outcome === "FOUND") {
    // A deleted event is never resurrected; an unowned event is never modified.
    if (!owned(first) || first.status !== "confirmed") return "BLOCKED_UNVERIFIED";
    if (matchesTimes(first, desired)) return "DONE";
    const patched = await port.patchSchedule(input.businessId, eventId, desired);
    if (patched !== "UPDATED") return "BLOCKED_UNVERIFIED";
    return verifyPresent();
  }

  // NOT_FOUND. A previously recorded event was deleted externally: never recreate it
  // (same rule as ordinary Booking sync). Only the deterministic id may be created.
  if (input.recordedEventId !== undefined || input.allowInsert !== true)
    return "BLOCKED_UNVERIFIED";
  const inserted = await port.insert(
    input.businessId,
    eventId,
    {
      summary: desired.summary,
      description: desired.description,
      startAt: desired.startAt,
      endAt: desired.endAt,
      timezone: desired.timezone,
    },
    { booklyBookingId: bookingId, booklyBusinessId: input.businessId },
  );
  if (inserted === "NOT_CONNECTED") return "BLOCKED_UNVERIFIED";
  return verifyPresent();
};

/** Event content: same convention as ordinary Booking sync; identifiers only, no customer data. */
export const packageCalendarEventFor = (booking: {
  reference: string;
  schedule: { startAt: Date; endAt: Date; timezone: string };
  serviceLines: Array<{ serviceSnapshot: { name: string } }>;
}): PackageCalendarEvent => ({
  summary: `Bookly — ${booking.reference}`,
  description: `Booking ${booking.reference} · Package session · ${booking.serviceLines
    .map((line) => line.serviceSnapshot.name)
    .join(", ")}`,
  startAt: booking.schedule.startAt,
  endAt: booking.schedule.endAt,
  timezone: booking.schedule.timezone,
});
