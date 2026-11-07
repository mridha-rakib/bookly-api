import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { businessLocalToUtc } from "../../src/common/time/business-clock.js";
import {
  availabilityRulesBodySchema,
  changeSlotBlocks,
  permitsAppointment,
  resolveLocalBlock,
  type SlotBlock,
} from "../../src/modules/business-booking-settings/business-availability.rules.js";
import { BusinessBookingSettingsModel } from "../../src/modules/business-booking-settings/business-booking-settings.model.js";

const at = (time: string) => new Date(`2030-01-15T${time}:00Z`);
const block = (start: string, end: string, staffMembershipId?: string): SlotBlock => ({
  startAt: at(start),
  endAt: at(end),
  staffMembershipId,
});
describe("authoritative Business availability rules", () => {
  it("reopens hydrated Mongoose blocks without losing their persisted fields", async () => {
    const saved = new BusinessBookingSettingsModel({
      businessId: new Types.ObjectId(),
      availability: { slotBlocks: [block("09:00", "12:00", "staff")] },
    });
    const reopened = changeSlotBlocks(
      saved.availability?.slotBlocks ?? [],
      [block("10:00", "11:00", "staff")],
      "UNBLOCK",
    );
    expect(reopened).toEqual([block("09:00", "10:00", "staff"), block("11:00", "12:00", "staff")]);
    const next = new BusinessBookingSettingsModel({
      businessId: saved.businessId,
      availability: { slotBlocks: reopened },
    });
    await expect(next.validate()).resolves.toBeUndefined();
    expect(saved.availability?.slotBlocks?.[0]?.endAt).toEqual(at("12:00"));
  });
  it("unions overlapping/duplicate submissions but retains independent scopes", () => {
    const saved = changeSlotBlocks(
      [block("09:00", "10:00", "a")],
      [block("09:30", "11:00", "a"), block("09:30", "11:00", "a"), block("09:00", "10:00")],
      "BLOCK",
    );
    expect(saved).toEqual([block("09:00", "10:00"), block("09:00", "11:00", "a")]);
    expect(changeSlotBlocks(saved, [block("09:30", "11:00", "a")], "BLOCK")).toEqual(saved);
  });
  it("unblocking splits exactly the selected interval, is repeatable and cannot remove another scope", () => {
    const saved = [
      block("09:00", "12:00", "a"),
      block("09:00", "12:00", "b"),
      block("09:00", "12:00"),
    ];
    const reopened = changeSlotBlocks(saved, [block("10:00", "11:00", "a")], "UNBLOCK");
    expect(reopened).toEqual([
      block("09:00", "12:00"),
      block("09:00", "10:00", "a"),
      block("11:00", "12:00", "a"),
      block("09:00", "12:00", "b"),
    ]);
    expect(changeSlotBlocks(reopened, [block("10:00", "11:00", "a")], "UNBLOCK")).toEqual(reopened);
    expect(saved[0]).toEqual(block("09:00", "12:00", "a"));
  });
  it("applies Staff-specific and Business-wide blocks with half-open boundaries including buffer occupancy", () => {
    const rules = { slotBlocks: [block("10:00", "11:00", "a")] };
    expect(permitsAppointment(rules, "UTC", "a", at("09:00"), at("10:00"), at("08:00"))).toBe(true);
    expect(permitsAppointment(rules, "UTC", "a", at("09:30"), at("10:01"), at("08:00"))).toBe(
      false,
    );
    expect(permitsAppointment(rules, "UTC", "b", at("10:00"), at("11:00"), at("08:00"))).toBe(true);
    expect(
      permitsAppointment(
        { slotBlocks: [block("10:00", "11:00")] },
        "UTC",
        "b",
        at("10:00"),
        at("11:00"),
        at("08:00"),
      ),
    ).toBe(false);
  });
  it("enforces the exact server-instant minimum notice boundary", () => {
    const rules = { minimumNoticeMinutes: 60 };
    expect(
      permitsAppointment(rules, "Asia/Dhaka", "a", at("09:00"), at("10:00"), at("08:00")),
    ).toBe(true);
    expect(
      permitsAppointment(
        rules,
        "Asia/Dhaka",
        "a",
        new Date(+at("09:00") - 1),
        at("10:00"),
        at("08:00"),
      ),
    ).toBe(false);
  });
  it("uses calendar months in Business timezone across DST and clamps month-end boundaries", () => {
    const now = new Date("2030-03-15T08:00:00Z");
    const limit = new Date("2030-04-15T07:00:00Z");
    expect(
      permitsAppointment(
        { maximumAdvanceMonths: 1 },
        "Europe/Nicosia",
        "a",
        limit,
        new Date(+limit + 60000),
        now,
      ),
    ).toBe(true);
    expect(
      permitsAppointment(
        { maximumAdvanceMonths: 1 },
        "Europe/Nicosia",
        "a",
        new Date(+limit + 1),
        new Date(+limit + 60000),
        now,
      ),
    ).toBe(false);
    const febEnd = new Date("2030-02-28T08:00:00Z");
    expect(
      permitsAppointment(
        { maximumAdvanceMonths: 1 },
        "UTC",
        "a",
        febEnd,
        new Date(+febEnd + 60000),
        new Date("2030-01-31T08:00:00Z"),
      ),
    ).toBe(true);
  });
  it.each([
    ["2030-03-31", 23],
    ["2030-10-27", 25],
  ] as const)("resolves a full Business-local DST day %s to %s actual hours", (date, hours) => {
    const next = date === "2030-03-31" ? "2030-04-01" : "2030-10-28";
    const range = resolveLocalBlock(
      { startDate: date, startTime: "00:00", endDate: next, endTime: "00:00" },
      "Europe/Nicosia",
    );
    expect((+range.endAt - +range.startAt) / 3600000).toBe(hours);
    const rules = { closedPeriods: [{ startDate: date, endDate: date }] };
    expect(
      permitsAppointment(
        rules,
        "Europe/Nicosia",
        "a",
        range.startAt,
        new Date(+range.startAt + 60000),
        new Date(0),
      ),
    ).toBe(false);
    expect(
      permitsAppointment(
        rules,
        "Europe/Nicosia",
        "a",
        range.endAt,
        new Date(+range.endAt + 60000),
        new Date(0),
      ),
    ).toBe(true);
  });
  it("keeps unconfigured notice/window unrestricted and validates only existing supported units", () => {
    expect(permitsAppointment(undefined, "UTC", "a", at("09:00"), at("10:00"), at("08:00"))).toBe(
      true,
    );
    expect(
      availabilityRulesBodySchema.safeParse({
        minimumNoticeMinutes: null,
        maximumAdvanceMonths: null,
        closedPeriods: [],
      }).success,
    ).toBe(true);
    expect(
      availabilityRulesBodySchema.safeParse({
        minimumNoticeMinutes: 17,
        maximumAdvanceMonths: 5,
        closedPeriods: [],
      }).success,
    ).toBe(false);
    expect(
      availabilityRulesBodySchema.safeParse({
        minimumNoticeMinutes: null,
        maximumAdvanceMonths: null,
        closedPeriods: [{ startDate: "2030-01-16", endDate: "2030-01-15" }],
      }).success,
    ).toBe(false);
    const range = resolveLocalBlock(
      { startDate: "2030-01-15", startTime: "09:00", endDate: "2030-01-15", endTime: "10:00" },
      "Asia/Dhaka",
    );
    expect(range.startAt).toEqual(businessLocalToUtc("Asia/Dhaka", "2030-01-15", "09:00"));
  });
});
