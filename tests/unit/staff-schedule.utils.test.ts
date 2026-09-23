import { describe, expect, it } from "vitest";

import {
  formatCanonicalTime12Hour,
  intervalsOverlap,
  isValidCanonicalTime,
  minutesSinceMidnight,
  normalizeScheduleIntervals,
  parseTo12HourCanonical,
} from "../../src/modules/staff/staff-schedule.utils.js";

describe("staff-schedule.utils", () => {
  describe("isValidCanonicalTime", () => {
    it("accepts zero-padded 24-hour HH:mm", () => {
      expect(isValidCanonicalTime("00:00")).toBe(true);
      expect(isValidCanonicalTime("09:00")).toBe(true);
      expect(isValidCanonicalTime("23:59")).toBe(true);
    });

    it("rejects malformed values", () => {
      expect(isValidCanonicalTime("9:00")).toBe(false); // not zero-padded
      expect(isValidCanonicalTime("24:00")).toBe(false);
      expect(isValidCanonicalTime("12:60")).toBe(false);
      expect(isValidCanonicalTime("9:00 AM")).toBe(false);
      expect(isValidCanonicalTime("noon")).toBe(false);
      expect(isValidCanonicalTime("")).toBe(false);
    });
  });

  describe("minutesSinceMidnight", () => {
    it("computes minutes correctly for start/end comparison", () => {
      expect(minutesSinceMidnight("00:00")).toBe(0);
      expect(minutesSinceMidnight("09:00")).toBe(540);
      expect(minutesSinceMidnight("17:30")).toBe(1050);
      expect(minutesSinceMidnight("23:59")).toBe(1439);
    });

    it("throws for an invalid value", () => {
      expect(() => minutesSinceMidnight("25:00")).toThrow();
    });
  });

  describe("formatCanonicalTime12Hour", () => {
    it("converts canonical 24-hour to 12-hour AM/PM display", () => {
      expect(formatCanonicalTime12Hour("09:00")).toBe("9:00 AM");
      expect(formatCanonicalTime12Hour("13:30")).toBe("1:30 PM");
      expect(formatCanonicalTime12Hour("00:00")).toBe("12:00 AM");
      expect(formatCanonicalTime12Hour("12:00")).toBe("12:00 PM");
      expect(formatCanonicalTime12Hour("23:45")).toBe("11:45 PM");
    });

    it("never returns a raw 24-hour value", () => {
      const label = formatCanonicalTime12Hour("17:00");
      expect(label).not.toMatch(/^17:/);
      expect(label).toMatch(/AM|PM/);
    });
  });

  describe("parseTo12HourCanonical", () => {
    it("is the exact inverse of formatCanonicalTime12Hour", () => {
      const cases: Array<[string, number, number, "AM" | "PM"]> = [
        ["09:00", 9, 0, "AM"],
        ["13:30", 1, 30, "PM"],
        ["00:00", 12, 0, "AM"],
        ["12:00", 12, 0, "PM"],
        ["23:45", 11, 45, "PM"],
      ];

      for (const [canonical, hour12, minute, period] of cases) {
        expect(parseTo12HourCanonical(hour12, minute, period)).toBe(canonical);
        expect(formatCanonicalTime12Hour(canonical)).toBe(
          `${hour12}:${String(minute).padStart(2, "0")} ${period}`,
        );
      }
    });

    it("rejects an out-of-range hour or minute", () => {
      expect(() => parseTo12HourCanonical(0, 0, "AM")).toThrow();
      expect(() => parseTo12HourCanonical(13, 0, "AM")).toThrow();
      expect(() => parseTo12HourCanonical(9, 60, "AM")).toThrow();
      expect(() => parseTo12HourCanonical(9, -1, "AM")).toThrow();
    });
  });

  describe("intervalsOverlap", () => {
    it("detects any shared minute as an overlap", () => {
      expect(
        intervalsOverlap(
          { startTime: "09:00", endTime: "13:00" },
          { startTime: "12:00", endTime: "17:00" },
        ),
      ).toBe(true);
      expect(
        intervalsOverlap(
          { startTime: "09:00", endTime: "13:00" },
          { startTime: "13:00", endTime: "17:00" },
        ),
      ).toBe(false); // exactly-contiguous is not an overlap
      expect(
        intervalsOverlap(
          { startTime: "09:00", endTime: "13:00" },
          { startTime: "14:00", endTime: "17:00" },
        ),
      ).toBe(false);
    });
  });

  describe("normalizeScheduleIntervals", () => {
    it("sorts intervals ascending by start time", () => {
      const result = normalizeScheduleIntervals([
        { startTime: "14:00", endTime: "17:00" },
        { startTime: "09:00", endTime: "13:00" },
      ]);
      expect(result).toEqual([
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "14:00", endTime: "17:00" },
      ]);
    });

    it("merges exactly-contiguous intervals into one", () => {
      const result = normalizeScheduleIntervals([
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "13:00", endTime: "17:00" },
      ]);
      expect(result).toEqual([{ startTime: "09:00", endTime: "17:00" }]);
    });

    it("leaves genuinely separate (gap) intervals apart — a break is preserved, not merged", () => {
      const result = normalizeScheduleIntervals([
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "14:00", endTime: "17:00" },
      ]);
      expect(result).toEqual([
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "14:00", endTime: "17:00" },
      ]);
    });

    it("throws on overlapping intervals rather than silently resolving them", () => {
      expect(() =>
        normalizeScheduleIntervals([
          { startTime: "09:00", endTime: "13:00" },
          { startTime: "12:00", endTime: "17:00" },
        ]),
      ).toThrow();
    });

    it("is idempotent — normalizing an already-normalized list returns the same result", () => {
      const once = normalizeScheduleIntervals([
        { startTime: "09:00", endTime: "13:00" },
        { startTime: "14:00", endTime: "17:00" },
      ]);
      const twice = normalizeScheduleIntervals(once);
      expect(twice).toEqual(once);
    });

    it("returns an empty array for an empty input (no hours configured)", () => {
      expect(normalizeScheduleIntervals([])).toEqual([]);
    });
  });
});
