import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import {
  isOrdinaryCalendarBooking,
  type OrdinaryCalendarObservation,
  ordinaryCalendarDesired,
  ordinaryCalendarEventId,
  ordinaryCalendarRevision,
  planOrdinaryCalendarStep,
} from "../../src/modules/booking/ordinary-calendar-journal.js";
import type { OrdinaryCalendarJournalDocument } from "../../src/modules/booking/ordinary-calendar-journal.model.js";
import {
  ordinaryCalendarAuthoritativeModeAvailable,
  verifyOrdinaryCalendarDeliveryAuthority,
} from "../../src/modules/booking/ordinary-calendar-journal-authority.js";
import { packageCalendarEventId } from "../../src/modules/booking/package-calendar-delivery.js";
import { buildBooking } from "./stage-b-fixtures.js";

// P4B-2A — the pure ordinary Calendar contract. Persistence and transactions are covered on a
// replica set in tests/integration/database/ordinary-calendar-journal.integration.test.ts.

const startAt = new Date("2026-09-05T09:00:00.000Z");
const endAt = new Date("2026-09-05T09:45:00.000Z");
const bookingId = new Types.ObjectId();
const businessId = new Types.ObjectId();

const journal = (overrides: Partial<OrdinaryCalendarJournalDocument> = {}) =>
  ({
    bookingId,
    businessId,
    mode: "AUTHORITATIVE",
    eventIdentity: { kind: "ALLOCATED", eventId: ordinaryCalendarEventId(bookingId) },
    destination: {
      integrationId: new Types.ObjectId(),
      generation: "gen-1",
      accountId: "acct-1",
      accountEmail: "owner@example.com",
      configuredCalendarId: "primary",
    },
    latest: {
      sequence: 1,
      revision: "a".repeat(64),
      source: "CREATED",
      bookingStatus: "UPCOMING",
      eventVersion: 0,
      rescheduleVersion: 0,
      recordedAt: new Date(),
      desired: {
        kind: "PRESENT",
        summary: "s",
        description: "d",
        startAt,
        endAt,
        timezone: "Europe/Nicosia",
      },
    },
    state: "DISPATCH_PREPARED",
    createIssued: false,
    ...overrides,
  }) as OrdinaryCalendarJournalDocument;

const found = (
  overrides: Partial<Extract<OrdinaryCalendarObservation, { outcome: "FOUND" }>> = {},
) =>
  ({
    outcome: "FOUND",
    status: "confirmed",
    startAt,
    endAt,
    etag: '"etag-1"',
    marker: { booklyBookingId: String(bookingId), booklyBusinessId: String(businessId) },
    ...overrides,
  }) as OrdinaryCalendarObservation;

const issued = (
  sequence: number,
  kind: "INSERT" | "PATCH" | "DELETE" = "INSERT",
  settled = false,
) => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind,
  sequence,
  revision: "r".repeat(64),
  issuedAt: new Date(),
  settled,
  providerStarted: true,
});

describe("ordinary Calendar identity, eligibility and intent", () => {
  it("allocates an event id that can never collide with a First-Class Package event", () => {
    const id = new Types.ObjectId();
    expect(ordinaryCalendarEventId(id)).toBe(`o${id.toHexString()}`);
    expect(ordinaryCalendarEventId(id)).not.toBe(packageCalendarEventId(id));
    expect(ordinaryCalendarEventId(id)).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it("excludes First-Class Package Bookings and keeps ordinary ones", () => {
    const ordinary = buildBooking();
    expect(isOrdinaryCalendarBooking(ordinary)).toBe(true);
    const firstClass = buildBooking();
    firstClass.serviceLines[0]!.pricingInput = { packageItemId: new Types.ObjectId() } as never;
    expect(isOrdinaryCalendarBooking(firstClass)).toBe(false);
    const withContext = buildBooking();
    withContext.serviceLines[0]!.packageContext = {} as never;
    expect(isOrdinaryCalendarBooking(withContext)).toBe(false);
  });

  it("maps UPCOMING to the legacy event content, cancellations to ABSENT, other states to no change", () => {
    const upcoming = buildBooking();
    expect(ordinaryCalendarDesired(upcoming)).toEqual({
      kind: "PRESENT",
      summary: `Bookly — ${upcoming.reference}`,
      description: `Booking ${upcoming.reference} (1 service line(s))`,
      startAt: upcoming.schedule.startAt,
      endAt: upcoming.schedule.endAt,
      timezone: upcoming.schedule.timezone,
    });
    for (const status of ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS", "LATE_CANCELLATION"])
      expect(ordinaryCalendarDesired(buildBooking({ status: status as never }))).toEqual({
        kind: "ABSENT",
      });
    for (const status of ["COMPLETED", "PENDING", "NO_SHOW_WAIVED", "NO_SHOW_CANCELLED"])
      expect(ordinaryCalendarDesired(buildBooking({ status: status as never }))).toBeUndefined();
  });

  it("gives a reschedule a new revision and an identical replay the same revision", () => {
    const booking = buildBooking();
    const desired = ordinaryCalendarDesired(booking)!;
    const first = ordinaryCalendarRevision(booking, desired);
    expect(ordinaryCalendarRevision({ ...booking } as never, desired)).toBe(first);
    const moved = {
      ...booking,
      rescheduleHistory: [{} as never],
      schedule: { ...booking.schedule, startAt: new Date(startAt.getTime() + 3_600_000) },
    } as never;
    expect(ordinaryCalendarRevision(moved, ordinaryCalendarDesired(moved)!)).not.toBe(first);
    expect(first).toHaveLength(64);
  });

  it("keeps the cutover authority default-denied", async () => {
    expect(await ordinaryCalendarAuthoritativeModeAvailable()).toBe(false);
    await expect(verifyOrdinaryCalendarDeliveryAuthority()).rejects.toMatchObject({
      code: "ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE",
      statusCode: 503,
    });
  });
});

describe("planOrdinaryCalendarStep provider-uncertainty contract", () => {
  it("never plans a write for a SHADOW journal owned by the legacy path", () => {
    expect(
      planOrdinaryCalendarStep(
        journal({ mode: "SHADOW", eventIdentity: { kind: "LEGACY_PATH" } }),
        { outcome: "NOT_FOUND" },
        true,
      ),
    ).toEqual({ action: "NONE", reason: "SHADOW_JOURNAL_LEGACY_PATH_OWNS_PROVIDER_WRITES" });
  });

  it("inserts only once: a GET 404 after an issued insert never authorizes another", () => {
    expect(planOrdinaryCalendarStep(journal(), { outcome: "NOT_FOUND" }, true)).toEqual({
      action: "INSERT",
    });
    expect(
      planOrdinaryCalendarStep(journal({ createIssued: true }), { outcome: "NOT_FOUND" }, true),
    ).toMatchObject({
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "MISSING_EVENT_DOES_NOT_AUTHORIZE_RECREATE",
    });
  });

  it("confirms a lost-response insert only by observing the exact owned event", () => {
    const lost = journal({ createIssued: true, state: "REQUEST_ISSUED", request: issued(1) });
    expect(planOrdinaryCalendarStep(lost, found(), true)).toEqual({ action: "CONFIRM" });
    expect(planOrdinaryCalendarStep(lost, { outcome: "NOT_FOUND" }, true)).toMatchObject({
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "UNRESOLVED_REQUEST_REQUIRES_QUIESCENCE_DECISION",
    });
  });

  it("blocks a reschedule or cancellation while an earlier request is unresolved", () => {
    const rescheduled = journal({
      createIssued: true,
      request: issued(1),
      latest: { ...journal().latest, sequence: 2, source: "RESCHEDULED" },
    });
    expect(planOrdinaryCalendarStep(rescheduled, found(), true)).toMatchObject({
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER",
    });
    const cancelled = journal({
      createIssued: true,
      request: issued(2, "PATCH"),
      latest: {
        ...journal().latest,
        sequence: 3,
        source: "CANCELLED",
        desired: { kind: "ABSENT" },
      },
    });
    expect(planOrdinaryCalendarStep(cancelled, { outcome: "NOT_FOUND" }, true)).toMatchObject({
      action: "BLOCK",
      reason: "EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER",
    });
  });

  it("patches and deletes only an owned, confirmed event with an ETag precondition", () => {
    const moved = journal({
      createIssued: true,
      request: issued(1, "INSERT", true),
      latest: { ...journal().latest, sequence: 2, source: "RESCHEDULED" },
    });
    const stale = found({ startAt: new Date(startAt.getTime() - 3_600_000) });
    expect(planOrdinaryCalendarStep(moved, stale, true)).toEqual({
      action: "PATCH",
      etag: '"etag-1"',
    });
    const cancel = journal({
      createIssued: true,
      latest: { ...journal().latest, sequence: 2, desired: { kind: "ABSENT" } },
    });
    expect(planOrdinaryCalendarStep(cancel, found(), true)).toEqual({
      action: "DELETE",
      etag: '"etag-1"',
    });
    for (const observation of [
      found({ etag: undefined as never, startAt: null }),
      found({
        marker: {
          booklyBookingId: String(new Types.ObjectId()),
          booklyBusinessId: String(businessId),
        },
      }),
      found({
        marker: {
          booklyBookingId: String(bookingId),
          booklyBusinessId: String(new Types.ObjectId()),
        },
      }),
      found({ status: "tentative", startAt: null }),
    ])
      expect(planOrdinaryCalendarStep(moved, observation, true)).toMatchObject({
        action: "BLOCK",
        state: "PERMANENT_FAILURE",
      });
  });

  it("treats a cancelled or missing event as the confirmed ABSENT state, never resurrecting it", () => {
    const cancel = journal({ latest: { ...journal().latest, desired: { kind: "ABSENT" } } });
    expect(planOrdinaryCalendarStep(cancel, { outcome: "NOT_FOUND" }, true)).toEqual({
      action: "CONFIRM",
    });
    expect(planOrdinaryCalendarStep(cancel, found({ status: "cancelled" }), true)).toEqual({
      action: "CONFIRM",
    });
    expect(
      planOrdinaryCalendarStep(
        journal({ createIssued: true }),
        found({ status: "cancelled" }),
        true,
      ),
    ).toMatchObject({ action: "BLOCK", state: "PERMANENT_FAILURE" });
  });

  it("blocks on reconnect, destination change, disconnection or a missing destination", () => {
    expect(planOrdinaryCalendarStep(journal(), { outcome: "NOT_FOUND" }, false)).toMatchObject({
      action: "BLOCK",
      state: "BLOCKED_AUTHORITY",
      reason: "CONNECTION_GENERATION_OR_DESTINATION_CHANGED",
    });
    expect(
      planOrdinaryCalendarStep(journal({ destination: undefined }), { outcome: "NOT_FOUND" }, true),
    ).toMatchObject({ action: "BLOCK", state: "BLOCKED_AUTHORITY" });
    expect(planOrdinaryCalendarStep(journal(), { outcome: "NOT_CONNECTED" }, true)).toMatchObject({
      action: "BLOCK",
      state: "BLOCKED_AUTHORITY",
      reason: "CALENDAR_DISCONNECTED",
    });
    expect(
      planOrdinaryCalendarStep(journal({ state: "PERMANENT_FAILURE" }), found(), true),
    ).toMatchObject({ action: "BLOCK", state: "PERMANENT_FAILURE" });
  });
});
