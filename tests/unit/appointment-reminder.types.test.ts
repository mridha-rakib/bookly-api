import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_REMINDER_OFFSET_MINUTES,
  buildAppointmentReminderDedupeKey,
  computeAppointmentReminderDueAt,
} from "../../src/modules/appointment-reminder/appointment-reminder.types.js";

const H = 60 * 60 * 1000;

describe("appointment reminder identity + due time", () => {
  it("dueAt is exactly startAt minus 24 hours (absolute instant arithmetic)", () => {
    const start = new Date("2026-09-10T09:00:00.000Z");
    expect(computeAppointmentReminderDueAt(start, "REMINDER_24H").toISOString()).toBe(
      "2026-09-09T09:00:00.000Z",
    );
    expect(APPOINTMENT_REMINDER_OFFSET_MINUTES.REMINDER_24H).toBe(1440);
    expect(start.getTime() - computeAppointmentReminderDueAt(start, "REMINDER_24H").getTime()).toBe(
      24 * H,
    );
  });

  it("dueAt math is unaffected by DST — it never touches a timezone", () => {
    // A start straddling a EU spring-forward date; the offset is still exactly 24h of real time.
    const start = new Date("2026-03-29T10:30:00.000Z");
    const due = computeAppointmentReminderDueAt(start, "REMINDER_24H");
    expect(start.getTime() - due.getTime()).toBe(24 * H);
  });

  it("dedupeKey is deterministic per (booking, schedule instant) and changes when the start moves", () => {
    const bookingId = "650000000000000000000001";
    const start = new Date("2026-09-10T09:00:00.000Z");
    const rescheduled = new Date("2026-09-11T09:00:00.000Z");

    expect(buildAppointmentReminderDedupeKey("REMINDER_24H", bookingId, start)).toBe(
      `APPOINTMENT_REMINDER_24H:${bookingId}:${start.getTime()}`,
    );
    // same inputs → identical key (idempotent scheduling)
    expect(buildAppointmentReminderDedupeKey("REMINDER_24H", bookingId, start)).toBe(
      buildAppointmentReminderDedupeKey("REMINDER_24H", bookingId, start),
    );
    // a reschedule → a distinct logical identity
    expect(buildAppointmentReminderDedupeKey("REMINDER_24H", bookingId, rescheduled)).not.toBe(
      buildAppointmentReminderDedupeKey("REMINDER_24H", bookingId, start),
    );
  });
});
