import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  classifyOrdinaryCalendarIncident,
  describeOrdinaryCalendarSync,
} from "../../src/modules/booking/ordinary-calendar-incident.js";
import type { OrdinaryCalendarJournalDocument } from "../../src/modules/booking/ordinary-calendar-journal.model.js";

const now = new Date("2030-01-01T12:00:00Z");
const windowMs = 120_000;
const row = (overrides: Partial<OrdinaryCalendarJournalDocument> = {}) =>
  ({
    _id: new Types.ObjectId(),
    bookingId: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    mode: "AUTHORITATIVE",
    state: "PENDING",
    createIssued: false,
    latest: { sequence: 2, desired: { kind: "PRESENT" } },
    ...overrides,
  }) as unknown as OrdinaryCalendarJournalDocument;
const issued = (ageMs: number) => ({
  id: "req-1",
  kind: "INSERT" as const,
  sequence: 2,
  revision: "r",
  issuedAt: new Date(now.getTime() - ageMs),
  settled: false,
  providerStarted: true,
});

describe("ordinary Calendar incident classification", () => {
  it("maps every journal state that needs attention to one durable category", () => {
    const cases: Array<[Partial<OrdinaryCalendarJournalDocument>, string | null, boolean?]> = [
      [{ state: "UNKNOWN_OUTCOME", request: issued(0) }, "PROVIDER_OUTCOME_UNKNOWN", true],
      [{ state: "REQUEST_ISSUED", request: issued(windowMs - 1) }, null],
      [
        { state: "REQUEST_ISSUED", request: issued(windowMs) },
        "REQUEST_STUCK_BEYOND_OBSERVATION_WINDOW",
        false,
      ],
      [{ state: "RETRYABLE_FAILURE" }, null],
      [{ state: "RETRYABLE_FAILURE", retryableFailures: 3 }, "PROVIDER_RETRYING", false],
      [
        { state: "BLOCKED_AUTHORITY", reason: "CALENDAR_NOT_CONNECTED_AT_CREATION" },
        "CALENDAR_NOT_CONNECTED",
        true,
      ],
      [
        { state: "BLOCKED_AUTHORITY", reason: "CONNECTION_GENERATION_OR_DESTINATION_CHANGED" },
        "CONNECTION_OR_DESTINATION_MISMATCH",
        true,
      ],
      [
        { state: "BLOCKED_AUTHORITY", reason: "CALENDAR_DISCONNECTED" },
        "CONNECTION_OR_DESTINATION_MISMATCH",
        true,
      ],
      [
        { state: "BLOCKED_AUTHORITY", reason: "BOOKING_JOURNAL_REVISION_MISMATCH" },
        "BOOKING_AUTHORITY_CHECK_FAILED",
        true,
      ],
      [
        { state: "PERMANENT_FAILURE", reason: "LEGACY_EVENT_LINK_PRESENT" },
        "BOOKING_AUTHORITY_CHECK_FAILED",
        true,
      ],
      [
        { state: "PERMANENT_FAILURE", reason: "EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED" },
        "PROVIDER_PERMANENT_FAILURE",
        true,
      ],
      [{ state: "CONFIRMED" }, null],
      [{ state: "PENDING" }, null],
      [{ mode: "SHADOW", state: "UNKNOWN_OUTCOME" }, null],
    ];
    for (const [overrides, category, recoveryRequired] of cases) {
      const incident = classifyOrdinaryCalendarIncident(row(overrides), now, windowMs);
      expect(incident?.category ?? null).toBe(category);
      if (incident) expect(incident.recoveryRequired).toBe(recoveryRequired);
    }
  });

  it("only reports SYNCED after a confirmation of the latest sequence", () => {
    expect(
      describeOrdinaryCalendarSync(row({ state: "CONFIRMED", confirmedSequence: 2 }), now, windowMs)
        .status,
    ).toBe("SYNCED");
    expect(
      describeOrdinaryCalendarSync(row({ state: "CONFIRMED", confirmedSequence: 1 }), now, windowMs)
        .status,
    ).toBe("SYNC_PENDING");
    expect(
      describeOrdinaryCalendarSync(
        row({ state: "BLOCKED_AUTHORITY", reason: "CALENDAR_NOT_CONNECTED_AT_CREATION" }),
        now,
        windowMs,
      ).status,
    ).toBe("NOT_CONNECTED");
    expect(describeOrdinaryCalendarSync(null, now, windowMs)).toEqual({
      ownership: "LEGACY",
      status: "LEGACY_UNTRACKED",
      recoveryRequired: false,
    });
    expect(describeOrdinaryCalendarSync(row({ mode: "SHADOW" }), now, windowMs).ownership).toBe(
      "LEGACY",
    );
  });
});
