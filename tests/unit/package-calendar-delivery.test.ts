import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import {
  type PackageCalendarDeliveryPort,
  type PackageCalendarDesired,
  packageCalendarEventFor,
  packageCalendarEventId,
  reconcilePackageCalendarEvent,
} from "../../src/modules/booking/package-calendar-delivery.js";
import { fakePackageCalendar } from "../helpers/fake-package-calendar.js";

/**
 * P2C — desired-state reconciliation against the in-memory fake calendar. No network.
 */

const businessId = new Types.ObjectId().toHexString();
const bookingId = new Types.ObjectId();
const eventId = packageCalendarEventId(bookingId);
const marker = { booklyBookingId: bookingId.toHexString(), booklyBusinessId: businessId };
const at = (iso: string) => new Date(iso);
const present = (start = "2030-08-20T09:00:00Z", end = "2030-08-20T10:00:00Z") => ({
  kind: "PRESENT" as const,
  summary: "Bookly — BK-1",
  description: "Booking BK-1 · Package session · Cut",
  startAt: at(start),
  endAt: at(end),
  timezone: "Europe/Nicosia",
});
const stored = (status: string, m: typeof marker | Partial<typeof marker>, start?: string) => ({
  status,
  summary: "x",
  description: "test fixture",
  timezone: "Europe/Nicosia",
  startAt: present(start).startAt,
  endAt: present(start).endAt,
  marker: m,
});
const run = (
  port: PackageCalendarDeliveryPort,
  desired: PackageCalendarDesired = present(),
  recordedEventId?: string,
  allowInsert = true,
) =>
  reconcilePackageCalendarEvent(port, {
    businessId,
    bookingId,
    recordedEventId,
    desired,
    allowInsert,
  });

describe("P2C package calendar reconciliation", () => {
  it("deterministic id is Google base32hex-compatible", () => {
    expect(eventId).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(eventId).toBe(`b${bookingId.toHexString()}`);
  });

  it("creates exactly one marked event and verifies it by read-back", async () => {
    const c = fakePackageCalendar();
    expect(await run(c.port)).toBe("DONE");
    expect(c.live()).toHaveLength(1);
    expect(c.get(businessId, eventId)?.marker).toEqual(marker);
    expect(c.calls).toEqual([`read:${eventId}`, `insert:${eventId}`, `read:${eventId}`]);
  });

  it("replay is a read-only DONE: no second insert", async () => {
    const c = fakePackageCalendar();
    await run(c.port);
    c.calls.length = 0;
    expect(await run(c.port)).toBe("DONE");
    expect(c.calls).toEqual([`read:${eventId}`]);
    expect(c.live()).toHaveLength(1);
  });

  it("an ambiguous insert (applied, response lost) throws; the retry converges on one event", async () => {
    const c = fakePackageCalendar({ loseInsertResponses: 1 });
    await expect(run(c.port)).rejects.toThrow("controlled lost insert response");
    expect(await run(c.port, present(), undefined, false)).toBe("DONE");
    expect(c.live()).toHaveLength(1);
    expect(c.writes()).toEqual([`insert:${eventId}`]);
  });

  it("a missing observation after an unknown create never authorizes another insert", async () => {
    const c = fakePackageCalendar({ loseInsertResponses: 1 });
    await expect(run(c.port)).rejects.toThrow("controlled lost insert response");
    const writes = [...c.writes()];
    c.port.read = async () => ({ outcome: "NOT_FOUND" });
    expect(await run(c.port, present(), undefined, false)).toBe("BLOCKED_UNVERIFIED");
    expect(c.writes()).toEqual(writes);
  });

  it("default reconciliation cannot create, including after tombstone expiry", async () => {
    const c = fakePackageCalendar();
    expect(
      await reconcilePackageCalendarEvent(c.port, {
        businessId,
        bookingId,
        desired: present(),
      }),
    ).toBe("BLOCKED_UNVERIFIED");
    expect(c.writes()).toEqual([]);
    await run(c.port);
    await run(c.port, { kind: "ABSENT" });
    c.events.delete(`${businessId}/${eventId}`);
    c.calls.length = 0;
    expect(await run(c.port, present(), undefined, false)).toBe("BLOCKED_UNVERIFIED");
    expect(c.writes()).toEqual([]);
  });

  it.each(["unknown", "tentative"])(
    "%s provider status is not evidence of confirmed delivery",
    async (status) => {
      const c = fakePackageCalendar();
      c.seed(businessId, eventId, stored(status, marker));
      expect(await run(c.port)).toBe("BLOCKED_UNVERIFIED");
      expect(c.writes()).toEqual([]);
    },
  );

  it("an insert acknowledgement without read-back evidence is RETRY", async () => {
    const c = fakePackageCalendar();
    c.port.insert = async () => "CREATED";
    expect(await run(c.port)).toBe("RETRY");
  });

  it("ALREADY_EXISTS from a concurrent insert still verifies by read-back", async () => {
    const c = fakePackageCalendar();
    const insert = c.port.insert;
    c.port.insert = async (...args) => {
      await insert(...args);
      return "ALREADY_EXISTS";
    };
    expect(await run(c.port)).toBe("DONE");
    expect(c.live()).toHaveLength(1);
  });

  it("a deleted (cancelled) deterministic event is never resurrected", async () => {
    const c = fakePackageCalendar();
    c.seed(businessId, eventId, stored("cancelled", marker));
    expect(await run(c.port)).toBe("BLOCKED_UNVERIFIED");
    expect(c.writes()).toEqual([]);
  });

  it("an unowned or cross-business event at the deterministic id is never modified", async () => {
    for (const foreign of [
      {},
      { ...marker, booklyBusinessId: new Types.ObjectId().toHexString() },
      { ...marker, booklyBookingId: new Types.ObjectId().toHexString() },
    ]) {
      const c = fakePackageCalendar();
      c.seed(businessId, eventId, stored("confirmed", foreign, "2030-01-01T00:00:00Z"));
      expect(await run(c.port)).toBe("BLOCKED_UNVERIFIED");
      expect(await run(c.port, { kind: "ABSENT" })).toBe("BLOCKED_UNVERIFIED");
      expect(c.writes()).toEqual([]);
      expect(c.get(businessId, eventId)?.status).toBe("confirmed");
    }
  });

  it("a recorded event that disappeared is BLOCKED and never recreated", async () => {
    const c = fakePackageCalendar();
    expect(await run(c.port, present(), "ordinaryeventid1")).toBe("BLOCKED_UNVERIFIED");
    expect(c.calls).toEqual(["read:ordinaryeventid1"]);
  });

  it("an unmarked recorded event needs durable destination proof before delivery", async () => {
    const c = fakePackageCalendar();
    c.seed(businessId, "ordinaryeventid1", stored("confirmed", {}));
    expect(await run(c.port, present(), "ordinaryeventid1")).toBe("BLOCKED_UNVERIFIED");
    expect(c.calls).toEqual(["read:ordinaryeventid1"]);
    expect(c.writes()).toEqual([]);
  });

  it("reschedule: PATCHes only the schedule, then verifies the new times", async () => {
    const c = fakePackageCalendar();
    await run(c.port);
    const moved = present("2030-08-21T09:00:00Z", "2030-08-21T10:00:00Z");
    expect(await run(c.port, moved)).toBe("DONE");
    expect(c.get(businessId, eventId)?.startAt).toEqual(moved.startAt);
    expect(c.live()).toHaveLength(1);
  });

  it("a patch that does not land stays RETRY (no false DONE)", async () => {
    const c = fakePackageCalendar();
    await run(c.port);
    c.port.patchSchedule = async () => "UPDATED";
    const moved = present("2030-08-21T09:00:00Z", "2030-08-21T10:00:00Z");
    expect(await run(c.port, moved)).toBe("RETRY");
  });

  it("cancel: removes the owned event and verifies; replay is DONE without another delete", async () => {
    const c = fakePackageCalendar();
    await run(c.port);
    expect(await run(c.port, { kind: "ABSENT" })).toBe("DONE");
    expect(c.get(businessId, eventId)?.status).toBe("cancelled");
    c.calls.length = 0;
    expect(await run(c.port, { kind: "ABSENT" })).toBe("DONE");
    expect(c.calls).toEqual([`read:${eventId}`]);
  });

  it("cancel of a never-created event is DONE with no write", async () => {
    const c = fakePackageCalendar();
    expect(await run(c.port, { kind: "ABSENT" })).toBe("DONE");
    expect(c.calls).toEqual([`read:${eventId}`]);
  });

  it("a remove that does not land stays RETRY", async () => {
    const c = fakePackageCalendar();
    await run(c.port);
    c.port.remove = async () => "DELETED";
    expect(await run(c.port, { kind: "ABSENT" })).toBe("RETRY");
  });

  it("no connected calendar is BLOCKED with no write attempt", async () => {
    const c = fakePackageCalendar({ connected: () => false });
    expect(await run(c.port)).toBe("BLOCKED_UNVERIFIED");
    expect(await run(c.port, { kind: "ABSENT" })).toBe("BLOCKED_UNVERIFIED");
    expect(c.writes()).toEqual([]);
  });

  it("provider failures propagate (the consumer keeps the task RETRY)", async () => {
    const c = fakePackageCalendar();
    c.port.read = async () => {
      throw new Error("controlled provider outage");
    };
    await expect(run(c.port)).rejects.toThrow("controlled provider outage");
  });

  it("event content carries identifiers only, never customer data", () => {
    const event = packageCalendarEventFor({
      reference: "BK-7",
      schedule: {
        startAt: at("2030-08-20T09:00:00Z"),
        endAt: at("2030-08-20T10:00:00Z"),
        timezone: "Europe/Nicosia",
      },
      serviceLines: [{ serviceSnapshot: { name: "Cut" } }, { serviceSnapshot: { name: "Wash" } }],
    });
    expect(event.summary).toBe("Bookly — BK-7");
    expect(event.description).toBe("Booking BK-7 · Package session · Cut, Wash");
    expect(event.timezone).toBe("Europe/Nicosia");
    expect(event.startAt.toISOString()).toBe("2030-08-20T09:00:00.000Z");
    expect(Object.keys(event).sort()).toEqual([
      "description",
      "endAt",
      "startAt",
      "summary",
      "timezone",
    ]);
  });
});
