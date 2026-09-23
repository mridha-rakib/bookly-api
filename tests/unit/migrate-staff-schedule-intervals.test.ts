import { describe, expect, it } from "vitest";

import {
  isAlreadyMigratedDay,
  migrateScheduleDays,
} from "../../scripts/migrate-staff-schedule-intervals.js";

describe("migrate-staff-schedule-intervals — pure transform", () => {
  describe("isAlreadyMigratedDay", () => {
    it("recognizes the new shape", () => {
      expect(
        isAlreadyMigratedDay({
          dayOfWeek: "MONDAY",
          intervals: [{ startTime: "09:00", endTime: "17:00" }],
        }),
      ).toBe(true);
    });

    it("recognizes an empty-intervals new-shape day", () => {
      expect(isAlreadyMigratedDay({ dayOfWeek: "MONDAY", intervals: [] })).toBe(true);
    });

    it("recognizes the legacy shape as NOT migrated", () => {
      expect(
        isAlreadyMigratedDay({ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }),
      ).toBe(false);
    });
  });

  describe("migrateScheduleDays", () => {
    it("is lossless: each legacy shift becomes exactly one interval for the same weekday", () => {
      const result = migrateScheduleDays([
        { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" },
      ]);

      expect(result).toEqual([
        { dayOfWeek: "MONDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "10:00", endTime: "18:00" }] },
      ]);
    });

    it("is idempotent: migrating an already-migrated array returns it unchanged", () => {
      const alreadyMigrated = [
        { dayOfWeek: "MONDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
      ];

      expect(migrateScheduleDays(alreadyMigrated)).toEqual(alreadyMigrated);
      // Running it twice more changes nothing further.
      expect(migrateScheduleDays(migrateScheduleDays(alreadyMigrated))).toEqual(alreadyMigrated);
    });

    it("passes through a day with an already-empty intervals array unchanged", () => {
      expect(migrateScheduleDays([{ dayOfWeek: "MONDAY", intervals: [] }])).toEqual([
        { dayOfWeek: "MONDAY", intervals: [] },
      ]);
    });

    it("handles a mixed array (some legacy, some already migrated) in one pass", () => {
      const result = migrateScheduleDays([
        { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "08:00", endTime: "12:00" }] },
      ]);

      expect(result).toEqual([
        { dayOfWeek: "MONDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "08:00", endTime: "12:00" }] },
      ]);
    });

    it("throws on an unrecognized shape (neither legacy nor new)", () => {
      expect(() => migrateScheduleDays([{ dayOfWeek: "MONDAY" }])).toThrow();
    });

    it("returns an empty array for an empty input", () => {
      expect(migrateScheduleDays([])).toEqual([]);
    });
  });
});
