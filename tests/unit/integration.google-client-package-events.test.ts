import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../../src/modules/integration/integration.errors.js";
import {
  deleteGoogleCalendarEventConditionally,
  getGoogleCalendarEvent,
  insertGoogleCalendarEventWithId,
  patchGoogleCalendarEventSchedule,
  resolveGoogleCalendarDestination,
} from "../../src/modules/integration/integration.google-client.js";

/**
 * P2C — raw Google helpers for deterministic-id package events. Stubbed fetch only; no network.
 */

type FetchCall = { url: string; init: RequestInit };

const installFetch = (status: number, body: unknown = {}) => {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }),
  );
  return calls;
};

const EVENT = {
  summary: "Bookly — BK-1",
  description: "Booking BK-1 · Package session · Cut",
  startAt: new Date("2030-08-20T09:00:00.000Z"),
  endAt: new Date("2030-08-20T10:00:00.000Z"),
  timezone: "Europe/Nicosia",
};
const MARKER = { booklyBookingId: "a".repeat(24), booklyBusinessId: "b".repeat(24) };
const ID = `b${"0123456789abcdef01234567"}`;

describe("insertGoogleCalendarEventWithId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the caller-chosen id, private marker and schedule; never attendees", async () => {
    const calls = installFetch(200);
    expect(await insertGoogleCalendarEventWithId("tok", "primary", ID, EVENT, MARKER)).toBe(
      "CREATED",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.id).toBe(ID);
    expect(body.extendedProperties).toEqual({ private: MARKER });
    expect(body.start).toEqual({
      dateTime: "2030-08-20T09:00:00.000Z",
      timeZone: "Europe/Nicosia",
    });
    for (const forbidden of ["attendees", "conferenceData", "location"])
      expect(body).not.toHaveProperty(forbidden);
  });

  it("409 is ALREADY_EXISTS and requires the consumer to verify by read-back", async () => {
    installFetch(409);
    expect(await insertGoogleCalendarEventWithId("tok", "primary", ID, EVENT, MARKER)).toBe(
      "ALREADY_EXISTS",
    );
  });

  it("other failures raise the coarse IntegrationError with a single attempt", async () => {
    const calls = installFetch(500);
    await expect(
      insertGoogleCalendarEventWithId("tok", "primary", ID, EVENT, MARKER),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(1);
  });

  it("rejects an id Google would not accept before any request", async () => {
    const calls = installFetch(200);
    for (const bad of ["abc", "Bxyz12345", "b-123456", "w12345"])
      await expect(
        insertGoogleCalendarEventWithId("tok", "primary", bad, EVENT, MARKER),
      ).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(0);
  });
});

describe("getGoogleCalendarEvent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs the encoded event path and parses status, times and the marker", async () => {
    const calls = installFetch(200, {
      status: "confirmed",
      start: { dateTime: "2030-08-20T12:00:00+03:00" },
      end: { dateTime: "2030-08-20T13:00:00+03:00" },
      extendedProperties: { private: { ...MARKER, other: "x" } },
      attendees: [{ email: "never-read@example.test" }],
    });
    const result = await getGoogleCalendarEvent("tok", "primary", ID);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${ID}`,
    );
    expect(result).toEqual({
      outcome: "FOUND",
      status: "confirmed",
      startAt: new Date("2030-08-20T09:00:00.000Z"),
      endAt: new Date("2030-08-20T10:00:00.000Z"),
      marker: MARKER,
    });
  });

  it("deleted events stay visible as status cancelled", async () => {
    installFetch(200, { status: "cancelled" });
    expect(await getGoogleCalendarEvent("tok", "primary", ID)).toEqual({
      outcome: "FOUND",
      status: "cancelled",
      startAt: null,
      endAt: null,
      marker: {},
    });
  });

  it("404 and 410 are NOT_FOUND; other failures throw", async () => {
    for (const status of [404, 410]) {
      installFetch(status);
      expect(await getGoogleCalendarEvent("tok", "primary", ID)).toEqual({ outcome: "NOT_FOUND" });
    }
    installFetch(503);
    await expect(getGoogleCalendarEvent("tok", "primary", ID)).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});

describe("durable package destination and conditional provider writes", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("resolves the account-relative alias to a concrete destination", async () => {
    const calls = installFetch(200, { id: "owner@example.test" });
    expect(await resolveGoogleCalendarDestination("tok", "primary")).toBe("owner@example.test");
    expect(calls[0]?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary");
    installFetch(200, { id: "primary" });
    await expect(resolveGoogleCalendarDestination("tok", "primary")).rejects.toThrow();
  });
  it("GET retains the ETag used to condition the next mutation", async () => {
    installFetch(200, { status: "confirmed", etag: '"version-1"' });
    expect(await getGoogleCalendarEvent("tok", "primary", ID)).toMatchObject({
      etag: '"version-1"',
    });
  });
  it("conditional PATCH sends only schedule plus If-Match and exposes 412", async () => {
    const calls = installFetch(412);
    expect(
      await patchGoogleCalendarEventSchedule("tok", "calendar/id", ID, EVENT, { etag: '"v1"' }),
    ).toBe("PRECONDITION_FAILED");
    expect(calls[0]?.init.headers).toMatchObject({ "If-Match": '"v1"' });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(JSON.parse(String(calls[0]?.init.body))).sort()).toEqual(["end", "start"]);
  });
  it("conditional DELETE preserves the observed ETag and handles already-absent events", async () => {
    const calls = installFetch(412);
    expect(await deleteGoogleCalendarEventConditionally("tok", "calendar", ID, '"v1"')).toBe(
      "PRECONDITION_FAILED",
    );
    expect(calls[0]?.init.headers).toMatchObject({ "If-Match": '"v1"' });
    installFetch(410);
    expect(await deleteGoogleCalendarEventConditionally("tok", "calendar", ID, '"v1"')).toBe(
      "DELETED",
    );
  });
  it("5xx writes remain unknown while definite rejection retains its failure category", async () => {
    installFetch(503);
    await expect(
      insertGoogleCalendarEventWithId("tok", "calendar", ID, EVENT, MARKER),
    ).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME", definitiveNoEffect: false });
    installFetch(429);
    await expect(
      insertGoogleCalendarEventWithId("tok", "calendar", ID, EVENT, MARKER),
    ).rejects.toMatchObject({ kind: "RETRYABLE_FAILURE", definitiveNoEffect: true });
    installFetch(400);
    await expect(
      insertGoogleCalendarEventWithId("tok", "calendar", ID, EVENT, MARKER),
    ).rejects.toMatchObject({ kind: "PERMANENT_FAILURE", definitiveNoEffect: true });
  });
});
