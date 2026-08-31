import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { StaffAccessNotifier } from "../../../src/modules/notification/staff-access.notifier.js";
import { StaffBookingNotifier } from "../../../src/modules/notification/staff-booking.notifier.js";
import { buildBooking } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * IMPORTANT STAFF EMAIL NOTIFICATIONS → EmailOutbox integration. Every staff notification is
 * async through the real Stage-A outbox: PENDING rows, deterministic dedupe keys, and a retried
 * domain operation never producing a second row. Also proves NON-assigned staff get nothing.
 */

const staffPort = (userIdByMembershipId: Record<string, string>) => ({
  findManyByIdsForBusiness: async (_businessId: unknown, ids: Array<string | Types.ObjectId>) =>
    ids
      .map((id) => {
        const userId = userIdByMembershipId[String(id)];
        return userId ? { _id: String(id), userId } : null;
      })
      .filter((m): m is { _id: string; userId: string } => m !== null),
});

const userPort = (emailByUserId: Record<string, string>) => ({
  findManyByIds: async (ids: Array<string | Types.ObjectId>) =>
    ids
      .map((id) => {
        const email = emailByUserId[String(id)];
        return email ? { _id: String(id), normalizedEmail: email } : null;
      })
      .filter((u): u is { _id: string; normalizedEmail: string } => u !== null),
  findProfilesByUserIds: async (ids: string[]) =>
    ids.map((id) => ({ userId: id, firstName: "Sam", lastName: "Cutter" })),
});

const twoStaffBooking = () => {
  const m1 = new Types.ObjectId();
  const m2 = new Types.ObjectId();
  const booking = buildBooking({
    serviceLines: [
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
        pricingInput: {},
        responsibleStaffMembershipId: m1,
        staffSnapshot: { firstName: "Sam" },
        addons: [],
        amountCents: 3000,
        reservationId: new Types.ObjectId(),
      },
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Colour", pricingMode: "FIXED", durationMin: 60 },
        pricingInput: {},
        responsibleStaffMembershipId: m2,
        staffSnapshot: { firstName: "Riley" },
        addons: [],
        amountCents: 6000,
        reservationId: new Types.ObjectId(),
      },
    ],
  } as never);
  return { booking, m1: String(m1), m2: String(m2) };
};

describe("Staff notifications → EmailOutbox integration", () => {
  let outbox: EmailOutboxService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    outbox = new EmailOutboxService(new EmailOutboxRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("cancellation: retried dispatch enqueues exactly one PENDING row per DISTINCT assigned staff", async () => {
    const { booking, m1, m2 } = twoStaffBooking();
    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort({ [m1]: "u1", [m2]: "u2" }),
      userPort({ u1: "sam@example.com", u2: "riley@example.com" }),
    );

    await notifier.notifyBookingCancelledToStaff(booking, "Soho", "CUSTOMER");
    await notifier.notifyBookingCancelledToStaff(booking, "Soho", "CUSTOMER");

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.templateKey === "STAFF_BOOKING_CANCELLED")).toBe(true);
    expect(rows.every((r) => r.eventKey === `BOOKING_CANCELLED:${String(booking._id)}`)).toBe(true);
    expect(rows.map((r) => r.recipient).sort()).toEqual(["riley@example.com", "sam@example.com"]);
  });

  it("cancellation: a staff member NOT assigned to the booking receives no row", async () => {
    const { booking, m1, m2 } = twoStaffBooking();
    const notifier = new StaffBookingNotifier(
      outbox,
      // only m1 resolves; m2 (assigned) has no user; an unrelated membership is never queried
      staffPort({ [m1]: "u1" }),
      userPort({ u1: "sam@example.com" }),
    );

    await notifier.notifyBookingCancelledToStaff(booking, "Soho", "CUSTOMER");

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBe("sam@example.com");
    // never an address that wasn't an assigned+resolvable staff member
    const json = JSON.stringify(rows);
    expect(json).not.toContain("riley@example.com");
    expect(json).not.toContain(m2);
  });

  it("reschedule: retried dispatch of the SAME reschedule is one row; a later distinct reschedule is its own row", async () => {
    const membershipId = new Types.ObjectId();
    const base = {
      serviceLines: [
        {
          serviceId: new Types.ObjectId(),
          serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
          pricingInput: {},
          responsibleStaffMembershipId: membershipId,
          staffSnapshot: { firstName: "Sam" },
          addons: [],
          amountCents: 3000,
          reservationId: new Types.ObjectId(),
        },
      ],
    };
    const bookingId = new Types.ObjectId();
    const mkEntry = (fromIso: string, toIso: string) => ({
      actorUserId: new Types.ObjectId(),
      actorRole: "CUSTOMER" as const,
      previousStart: new Date(fromIso),
      previousEnd: new Date(fromIso),
      newStart: new Date(toIso),
      newEnd: new Date(toIso),
      countedTowardCustomerQuota: true,
      createdAt: new Date(),
    });

    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort({ [String(membershipId)]: "u1" }),
      userPort({ u1: "sam@example.com" }),
    );

    const afterFirst = buildBooking({
      _id: bookingId,
      ...base,
      schedule: {
        timezone: "Europe/Nicosia",
        startAt: new Date("2026-09-08T12:00:00.000Z"),
        endAt: new Date("2026-09-08T12:30:00.000Z"),
      },
      rescheduleHistory: [mkEntry("2026-09-05T09:00:00.000Z", "2026-09-08T12:00:00.000Z")],
    } as never);

    await notifier.notifyBookingRescheduledToStaff(afterFirst, "Soho");
    await notifier.notifyBookingRescheduledToStaff(afterFirst, "Soho"); // retry — same history length

    const afterSecond = buildBooking({
      _id: bookingId,
      ...base,
      schedule: {
        timezone: "Europe/Nicosia",
        startAt: new Date("2026-09-10T16:00:00.000Z"),
        endAt: new Date("2026-09-10T16:30:00.000Z"),
      },
      rescheduleHistory: [
        mkEntry("2026-09-05T09:00:00.000Z", "2026-09-08T12:00:00.000Z"),
        mkEntry("2026-09-08T12:00:00.000Z", "2026-09-10T16:00:00.000Z"),
      ],
    } as never);
    await notifier.notifyBookingRescheduledToStaff(afterSecond, "Soho");

    const rows = await EmailOutboxModel.find({}).sort({ createdAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eventKey)).toEqual([
      `BOOKING_SCHEDULE_CHANGED:${String(bookingId)}:1`,
      `BOOKING_SCHEDULE_CHANGED:${String(bookingId)}:2`,
    ]);
    expect(rows.every((r) => r.templateKey === "STAFF_BOOKING_SCHEDULE_CHANGED")).toBe(true);
    expect(rows.every((r) => r.recipient === "sam@example.com")).toBe(true);
  });

  it("staff removal: retried notify is one row; a different membership id is a separate row; no secrets", async () => {
    const membershipA = new Types.ObjectId().toString();
    const membershipB = new Types.ObjectId().toString();
    const notifier = new StaffAccessNotifier(
      outbox,
      userPort({ uA: "alex@example.com", uB: "bo@example.com" }),
    );

    await notifier.notifyStaffRemoved({
      membershipId: membershipA,
      userId: "uA",
      businessName: "Soho",
    });
    await notifier.notifyStaffRemoved({
      membershipId: membershipA,
      userId: "uA",
      businessName: "Soho",
    });
    await notifier.notifyStaffRemoved({
      membershipId: membershipB,
      userId: "uB",
      businessName: "Soho",
    });

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.map((r) => r.eventKey).sort()).toEqual(
      [`STAFF_ACCESS_REMOVED:${membershipA}`, `STAFF_ACCESS_REMOVED:${membershipB}`].sort(),
    );
    const json = JSON.stringify(rows).toLowerCase();
    for (const forbidden of ["password", "otp", "token", "secret"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
