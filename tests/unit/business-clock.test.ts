import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  businessLocalToUtc,
  dayOfWeekForDate,
  enumerateCalendarDates,
  utcToBusinessLocalDate,
  utcToBusinessLocalTime,
} from "../../src/common/time/business-clock.js";

const NICOSIA = "Europe/Nicosia";

describe("businessLocalToUtc", () => {
  it("converts a normal (non-DST-boundary) local time correctly", () => {
    // August: Europe/Nicosia is EEST, UTC+3.
    expect(businessLocalToUtc(NICOSIA, "2026-08-25", "09:00")).toEqual(
      new Date("2026-08-25T06:00:00.000Z"),
    );
  });

  it("spring-forward: a local time inside the skipped hour resolves past the gap (2026-03-29, EU DST start)", () => {
    // 02:00 EET -> 03:00 EEST: local 03:00-03:59 never occurs. 02:30 (before the gap) is
    // still +2; 04:30 (after the gap) is +3. The gap time 03:30 is verified (see this
    // module's own DST-policy doc comment) to resolve to the same instant as 04:30 — i.e.
    // luxon advances a skipped local time forward by the gap size, never silently landing on
    // the wrong side of the transition.
    const beforeGap = businessLocalToUtc(NICOSIA, "2026-03-29", "02:30");
    const inGap = businessLocalToUtc(NICOSIA, "2026-03-29", "03:30");
    const afterGap = businessLocalToUtc(NICOSIA, "2026-03-29", "04:30");

    expect(beforeGap).toEqual(new Date("2026-03-29T00:30:00.000Z"));
    expect(inGap).toEqual(new Date("2026-03-29T01:30:00.000Z"));
    expect(afterGap).toEqual(new Date("2026-03-29T01:30:00.000Z"));
    expect(inGap.getTime()).toBe(afterGap.getTime());
  });

  it("fall-back: a local time inside the repeated hour resolves to the FIRST (pre-transition) occurrence (2026-10-25, EU DST end)", () => {
    // 04:00 EEST -> 03:00 EET: local 03:00-03:59 occurs twice, once at +3 and once at +2.
    // Verified: resolves to the +3 (first/pre-transition) occurrence, matching this module's
    // documented, explicit policy — never left to luxon's default without a test pinning it.
    const ambiguous = businessLocalToUtc(NICOSIA, "2026-10-25", "03:30");
    expect(ambiguous).toEqual(new Date("2026-10-25T00:30:00.000Z"));

    const beforeFallback = businessLocalToUtc(NICOSIA, "2026-10-25", "02:30");
    const afterFallback = businessLocalToUtc(NICOSIA, "2026-10-25", "04:30");
    expect(beforeFallback).toEqual(new Date("2026-10-24T23:30:00.000Z"));
    expect(afterFallback).toEqual(new Date("2026-10-25T02:30:00.000Z"));
  });

  it("a candidate slot spanning the fall-back transition still produces a strictly-increasing, correctly-offset endAt", () => {
    // A 90-minute service starting at 03:00 local on fall-back day: with the documented
    // first-occurrence policy, start=00:00Z; adding 90 real minutes must land at 01:30Z
    // (crossing the actual repeated hour), never silently computed via local-time
    // subtraction (which would be timezone-unsafe).
    const startAt = businessLocalToUtc(NICOSIA, "2026-10-25", "03:00");
    const endAt = new Date(startAt.getTime() + 90 * 60_000);
    expect(startAt).toEqual(new Date("2026-10-25T00:00:00.000Z"));
    expect(endAt).toEqual(new Date("2026-10-25T01:30:00.000Z"));
  });

  it("throws for a non-canonical time or malformed date", () => {
    expect(() => businessLocalToUtc(NICOSIA, "2026-08-25", "9am")).toThrow();
    expect(() => businessLocalToUtc(NICOSIA, "2026/08/25", "09:00")).toThrow();
  });

  it("throws for an unresolvable IANA zone", () => {
    expect(() => businessLocalToUtc("Not/AZone", "2026-08-25", "09:00")).toThrow();
  });
});

describe("utcToBusinessLocalDate / utcToBusinessLocalTime", () => {
  it("round-trips a normal instant back to its business-local date, weekday, and time", () => {
    const instant = new Date("2026-08-25T06:00:00.000Z"); // Tuesday 09:00 in Nicosia
    expect(utcToBusinessLocalDate(NICOSIA, instant)).toEqual({
      dateStr: "2026-08-25",
      dayOfWeek: "TUESDAY",
    });
    expect(utcToBusinessLocalTime(NICOSIA, instant)).toBe("09:00");
  });

  it("correctly rolls the business-local calendar date across a UTC midnight boundary", () => {
    // Just before UTC midnight, but already past local midnight in Nicosia (+3).
    const instant = new Date("2026-08-24T22:30:00.000Z");
    expect(utcToBusinessLocalDate(NICOSIA, instant).dateStr).toBe("2026-08-25");
  });

  it("never uses the server's own timezone — the same instant resolves identically regardless of TZ env", () => {
    const instant = new Date("2026-08-25T06:00:00.000Z");
    const original = process.env["TZ"];
    try {
      process.env["TZ"] = "America/Los_Angeles";
      expect(utcToBusinessLocalDate(NICOSIA, instant)).toEqual({
        dateStr: "2026-08-25",
        dayOfWeek: "TUESDAY",
      });
    } finally {
      process.env["TZ"] = original;
    }
  });
});

describe("dayOfWeekForDate", () => {
  it("resolves the correct weekday for a range of known dates", () => {
    expect(dayOfWeekForDate("2026-08-24")).toBe("MONDAY");
    expect(dayOfWeekForDate("2026-08-25")).toBe("TUESDAY");
    expect(dayOfWeekForDate("2026-08-30")).toBe("SUNDAY");
  });
});

describe("addCalendarDays / enumerateCalendarDates", () => {
  it("adds days across a month boundary", () => {
    expect(addCalendarDays("2026-08-30", 1)).toBe("2026-08-31");
    expect(addCalendarDays("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("adds days across the DST transition without skipping or duplicating a calendar date", () => {
    expect(addCalendarDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addCalendarDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addCalendarDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addCalendarDays("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("enumerates an inclusive range", () => {
    expect(enumerateCalendarDates("2026-08-25", "2026-08-25")).toEqual(["2026-08-25"]);
    expect(enumerateCalendarDates("2026-08-30", "2026-09-02")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});
