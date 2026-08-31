import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationError } from "../../src/modules/integration/integration.errors.js";
import { patchGoogleCalendarEventSchedule } from "../../src/modules/integration/integration.google-client.js";

/**
 * GOOGLE CALENDAR RESCHEDULE SYNC — raw provider PATCH helper. Proves it sends an HTTP PATCH
 * carrying ONLY start/end (so Owner-added Meet links / attendees / reminders survive), encodes
 * path identifiers, treats 404/410 as a soft "event gone" outcome, and otherwise raises the
 * existing coarse IntegrationError with no retry loop.
 */

type FetchCall = { url: string; init: RequestInit };

const installFetch = (impl: (call: FetchCall) => { status: number }) => {
  const calls: FetchCall[] = [];
  const fake = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status } = impl({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fake);
  return { calls, fake };
};

const SCHEDULE = {
  startAt: new Date("2026-09-08T13:30:00.000Z"),
  endAt: new Date("2026-09-08T14:15:00.000Z"),
  timezone: "Europe/Nicosia",
};

describe("patchGoogleCalendarEventSchedule", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends an HTTP PATCH to the calendarId + eventId path, with identifiers encoded", async () => {
    const { calls } = installFetch(() => ({ status: 200 }));

    await patchGoogleCalendarEventSchedule("tok", "primary", "evt/123?x", SCHEDULE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt%2F123%3Fx",
    );
    expect(calls[0]?.url).toContain("/calendars/primary/events/");
  });

  it("body carries ONLY start/end (dateTime + timeZone), nothing else", async () => {
    const { calls } = installFetch(() => ({ status: 200 }));

    await patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(Object.keys(body).sort()).toEqual(["end", "start"]);
    expect(body.start).toEqual({
      dateTime: "2026-09-08T13:30:00.000Z",
      timeZone: "Europe/Nicosia",
    });
    expect(body.end).toEqual({
      dateTime: "2026-09-08T14:15:00.000Z",
      timeZone: "Europe/Nicosia",
    });
    for (const forbidden of [
      "summary",
      "description",
      "attendees",
      "location",
      "conferenceData",
      "reminders",
      "extendedProperties",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("returns 'UPDATED' on a 2xx", async () => {
    installFetch(() => ({ status: 200 }));
    await expect(
      patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE),
    ).resolves.toBe("UPDATED");
  });

  it("treats 404 as a soft 'EVENT_NOT_FOUND' (no throw, no recreate)", async () => {
    installFetch(() => ({ status: 404 }));
    await expect(
      patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE),
    ).resolves.toBe("EVENT_NOT_FOUND");
  });

  it("treats 410 as a soft 'EVENT_NOT_FOUND'", async () => {
    installFetch(() => ({ status: 410 }));
    await expect(
      patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE),
    ).resolves.toBe("EVENT_NOT_FOUND");
  });

  it("throws the existing IntegrationError on any other non-OK, with no retry loop", async () => {
    const { calls } = installFetch(() => ({ status: 500 }));
    await expect(
      patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(1); // single attempt
  });

  it("401/403 also raise IntegrationError (coarse model, single attempt)", async () => {
    for (const status of [401, 403, 429]) {
      const { calls } = installFetch(() => ({ status }));
      await expect(
        patchGoogleCalendarEventSchedule("tok", "primary", "evt1", SCHEDULE),
      ).rejects.toBeInstanceOf(IntegrationError);
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});
