import { describe, expect, it } from "vitest";

import {
  createStaffBodySchema,
  createStaffTimeOffBodySchema,
  putStaffScheduleBodySchema,
  updateStaffBodySchema,
} from "../../src/modules/staff/staff.schema.js";

describe("staff.schema", () => {
  describe("createStaffBodySchema", () => {
    const base = { name: "Vivi M", email: "vivi@example.com" };

    it("accepts SUPERVISOR and STAFF", () => {
      expect(createStaffBodySchema.safeParse({ ...base, role: "SUPERVISOR" }).success).toBe(true);
      expect(createStaffBodySchema.safeParse({ ...base, role: "STAFF" }).success).toBe(true);
    });

    it("rejects BUSINESS_OWNER, SUPER_ADMIN, and CUSTOMER outright", () => {
      for (const role of ["BUSINESS_OWNER", "SUPER_ADMIN", "CUSTOMER", "ADMIN", "OWNER"]) {
        expect(createStaffBodySchema.safeParse({ ...base, role }).success).toBe(false);
      }
    });

    it("rejects mass-assigned/injected fields via .strict()", () => {
      const result = createStaffBodySchema.safeParse({
        ...base,
        role: "STAFF",
        userId: "000000000000000000000000",
        createdByUserId: "000000000000000000000000",
        employmentActive: false,
        status: "SUSPENDED",
      });
      expect(result.success).toBe(false);
    });

    it("accepts an optional phone and rejects an empty name/invalid email", () => {
      expect(createStaffBodySchema.safeParse({ ...base, role: "STAFF" }).success).toBe(true);
      expect(
        createStaffBodySchema.safeParse({ ...base, role: "STAFF", phone: "+357 99 111222" })
          .success,
      ).toBe(true);
      expect(createStaffBodySchema.safeParse({ ...base, name: "", role: "STAFF" }).success).toBe(
        false,
      );
      expect(
        createStaffBodySchema.safeParse({ ...base, email: "not-an-email", role: "STAFF" }).success,
      ).toBe(false);
    });
  });

  describe("updateStaffBodySchema", () => {
    it("rejects role escalation to BUSINESS_OWNER/SUPER_ADMIN on update", () => {
      expect(updateStaffBodySchema.safeParse({ role: "BUSINESS_OWNER" }).success).toBe(false);
      expect(updateStaffBodySchema.safeParse({ role: "SUPER_ADMIN" }).success).toBe(false);
      expect(updateStaffBodySchema.safeParse({ role: "SUPERVISOR" }).success).toBe(true);
    });

    it("requires at least one field", () => {
      expect(updateStaffBodySchema.safeParse({}).success).toBe(false);
    });

    it("allows employmentActive as an independent boolean field", () => {
      expect(updateStaffBodySchema.safeParse({ employmentActive: false }).success).toBe(true);
    });

    it("rejects a businessId field (Business transfer is unsupported in Phase 1)", () => {
      const result = updateStaffBodySchema.safeParse({
        name: "New Name",
        businessId: "000000000000000000000000",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("putStaffScheduleBodySchema", () => {
    it("accepts different hours per day, and zero-to-seven day entries", () => {
      expect(putStaffScheduleBodySchema.safeParse({ days: [] }).success).toBe(true);
      expect(
        putStaffScheduleBodySchema.safeParse({
          days: [
            { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
            { dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" },
            { dayOfWeek: "WEDNESDAY", startTime: "08:30", endTime: "16:00" },
          ],
        }).success,
      ).toBe(true);
    });

    it("rejects a second interval for the same day (one shift per day)", () => {
      const result = putStaffScheduleBodySchema.safeParse({
        days: [
          { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "13:00" },
          { dayOfWeek: "MONDAY", startTime: "15:00", endTime: "19:00" },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects start >= end", () => {
      expect(
        putStaffScheduleBodySchema.safeParse({
          days: [{ dayOfWeek: "MONDAY", startTime: "17:00", endTime: "09:00" }],
        }).success,
      ).toBe(false);
      expect(
        putStaffScheduleBodySchema.safeParse({
          days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "09:00" }],
        }).success,
      ).toBe(false);
    });

    it("rejects malformed / non-canonical time values", () => {
      for (const badTime of ["9:00 AM", "9:00", "25:00", "09:60", "noon", ""]) {
        expect(
          putStaffScheduleBodySchema.safeParse({
            days: [{ dayOfWeek: "MONDAY", startTime: badTime, endTime: "17:00" }],
          }).success,
        ).toBe(false);
      }
    });

    it("rejects an invalid day of week", () => {
      expect(
        putStaffScheduleBodySchema.safeParse({
          days: [{ dayOfWeek: "FUNDAY", startTime: "09:00", endTime: "17:00" }],
        }).success,
      ).toBe(false);
    });

    it("caps at 7 days", () => {
      const eightDays = Array.from({ length: 8 }, () => ({
        dayOfWeek: "MONDAY",
        startTime: "09:00",
        endTime: "17:00",
      }));
      expect(putStaffScheduleBodySchema.safeParse({ days: eightDays }).success).toBe(false);
    });
  });

  describe("createStaffTimeOffBodySchema", () => {
    it("accepts a single-day entry (no endDate)", () => {
      const result = createStaffTimeOffBodySchema.safeParse({
        type: "ANNUAL_HOLIDAY",
        startDate: "2026-06-05",
      });
      expect(result.success).toBe(true);
    });

    it("accepts an inclusive date range", () => {
      const result = createStaffTimeOffBodySchema.safeParse({
        type: "SICK_LEAVE",
        startDate: "2026-06-02",
        endDate: "2026-06-06",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a reversed range (endDate before startDate)", () => {
      const result = createStaffTimeOffBodySchema.safeParse({
        type: "ANNUAL_HOLIDAY",
        startDate: "2026-06-06",
        endDate: "2026-06-02",
      });
      expect(result.success).toBe(false);
    });

    it("preserves only the two existing leave types", () => {
      expect(
        createStaffTimeOffBodySchema.safeParse({
          type: "ANNUAL_HOLIDAY",
          startDate: "2026-06-05",
        }).success,
      ).toBe(true);
      expect(
        createStaffTimeOffBodySchema.safeParse({
          type: "SICK_LEAVE",
          startDate: "2026-06-05",
        }).success,
      ).toBe(true);
      expect(
        createStaffTimeOffBodySchema.safeParse({
          type: "UNPAID_LEAVE",
          startDate: "2026-06-05",
        }).success,
      ).toBe(false);
    });

    it("rejects malformed dates", () => {
      for (const badDate of ["06/05/2026", "2026-13-01", "not-a-date", ""]) {
        expect(
          createStaffTimeOffBodySchema.safeParse({
            type: "ANNUAL_HOLIDAY",
            startDate: badDate,
          }).success,
        ).toBe(false);
      }
    });
  });
});
