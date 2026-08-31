import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BookingDocument } from "../../../src/modules/booking/booking.model.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingRescheduledCustomerNotifier } from "../../../src/modules/notification/booking-rescheduled-customer.notifier.js";
import { buildBooking, buildBusiness } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * CUSTOMER RESCHEDULE CONFIRMATION EMAIL → EmailOutbox integration. Proves the notifier goes
 * through the real Stage-A outbox: one PENDING row per logical reschedule, the deterministic
 * ordinal `eventKey`, a retried dispatch of the SAME reschedule producing no second row (real
 * unique-index dedupe), and the next genuine reschedule getting its own row.
 */

const entry = (
  fromIso: string,
  toIso: string,
  actorRole: "CUSTOMER" | "BUSINESS_OWNER" = "CUSTOMER",
) => ({
  actorUserId: new Types.ObjectId(),
  actorRole,
  previousStart: new Date(fromIso),
  previousEnd: new Date(fromIso),
  newStart: new Date(toIso),
  newEnd: new Date(new Date(toIso).getTime() + 45 * 60_000),
  countedTowardCustomerQuota: actorRole === "CUSTOMER",
  createdAt: new Date(),
});

const bookingAt = (id: Types.ObjectId, history: ReturnType<typeof entry>[]): BookingDocument =>
  buildBooking({
    _id: id,
    schedule: {
      timezone: "Europe/Nicosia",
      startAt: history.at(-1)?.newStart ?? new Date("2026-09-08T13:30:00.000Z"),
      endAt: history.at(-1)?.newEnd ?? new Date("2026-09-08T14:15:00.000Z"),
    },
    rescheduleHistory: history,
  } as never);

describe("Customer reschedule confirmation → EmailOutbox integration", () => {
  let notifier: BookingRescheduledCustomerNotifier;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    notifier = new BookingRescheduledCustomerNotifier(
      new EmailOutboxService(new EmailOutboxRepository()),
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("enqueues exactly one PENDING row with the ordinal eventKey and dedicated template", async () => {
    const booking = bookingAt(new Types.ObjectId(), [
      entry("2026-09-05T09:00:00.000Z", "2026-09-08T13:30:00.000Z"),
    ]);

    await notifier.notifyBookingRescheduledToCustomer(booking, buildBusiness({ name: "Soho" }));

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.templateKey).toBe("BOOKING_RESCHEDULED_CUSTOMER");
    expect(rows[0]?.eventKey).toBe(`BOOKING_RESCHEDULED:${String(booking._id)}:1`);
    expect(rows[0]?.recipient).toBe("dana@example.com");
  });

  it("a retried dispatch of the SAME reschedule is one row; a later distinct reschedule is its own", async () => {
    const id = new Types.ObjectId();

    const afterFirst = bookingAt(id, [
      entry("2026-09-05T09:00:00.000Z", "2026-09-08T13:30:00.000Z"),
    ]);
    await notifier.notifyBookingRescheduledToCustomer(afterFirst, buildBusiness());
    await notifier.notifyBookingRescheduledToCustomer(afterFirst, buildBusiness()); // retry

    const afterSecond = bookingAt(id, [
      entry("2026-09-05T09:00:00.000Z", "2026-09-08T13:30:00.000Z"),
      entry("2026-09-08T13:30:00.000Z", "2026-09-10T16:00:00.000Z"),
    ]);
    await notifier.notifyBookingRescheduledToCustomer(afterSecond, buildBusiness());

    const rows = await EmailOutboxModel.find({}).sort({ createdAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eventKey)).toEqual([
      `BOOKING_RESCHEDULED:${String(id)}:1`,
      `BOOKING_RESCHEDULED:${String(id)}:2`,
    ]);
    expect(rows.every((r) => r.templateKey === "BOOKING_RESCHEDULED_CUSTOMER")).toBe(true);
  });

  it("the persisted row carries no payment / token / OTP data", async () => {
    const booking = bookingAt(new Types.ObjectId(), [
      entry("2026-09-05T09:00:00.000Z", "2026-09-08T13:30:00.000Z", "BUSINESS_OWNER"),
    ]);
    await notifier.notifyBookingRescheduledToCustomer(booking, buildBusiness());

    const json = JSON.stringify(await EmailOutboxModel.find({}).lean()).toLowerCase();
    for (const forbidden of ["deposit", "balancedue", "otp", "token", "secret", "reservationid"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
