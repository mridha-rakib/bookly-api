import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import {
  BookingCreatedNotifier,
  type BookingNotificationUserPort,
} from "../../src/modules/notification/booking-created.notifier.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/** MAILING STAGE B — Triggers 2/3/4 notifier (Part T items 7,8,13,14,15,16,17,19,20,21,22,23). */

type EnqueueCall = {
  eventKey: string;
  templateKey: string;
  recipient: string;
  payload: Record<string, unknown>;
};

const createdByLabelOf = (call: EnqueueCall | undefined): unknown =>
  (call?.payload as { createdByLabel?: unknown } | undefined)?.createdByLabel;

const makeNotifier = (
  users: Partial<BookingNotificationUserPort> = {},
): { notifier: BookingCreatedNotifier; calls: EnqueueCall[] } => {
  const calls: EnqueueCall[] = [];
  const enqueue = vi.fn(async (input: EnqueueCall) => {
    calls.push(input);
    return { created: true, record: {} };
  });
  const port: BookingNotificationUserPort = {
    findManyByIds: users.findManyByIds ?? (async () => []),
    findProfilesByUserIds: users.findProfilesByUserIds ?? (async () => []),
  };
  const notifier = new BookingCreatedNotifier(
    { enqueue } as unknown as Pick<EmailOutboxService, "enqueue">,
    port,
  );
  return { notifier, calls };
};

describe("BookingCreatedNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("7/8 CUSTOMER-created booking → customer confirmation + owner notification", async () => {
    const business = buildBusiness();
    const booking = buildBooking({
      businessId: business._id,
      createdBy: { actorUserId: new Types.ObjectId(), actorRole: "CUSTOMER" },
    });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);

    const eventKey = `BOOKING_CREATED:${String(booking._id)}`;
    expect(calls).toEqual([
      expect.objectContaining({
        eventKey,
        templateKey: "BOOKING_CUSTOMER_CONFIRMED",
        recipient: "dana@example.com",
      }),
      expect.objectContaining({
        eventKey,
        templateKey: "BOOKING_OWNER_NEW_BOOKING",
        recipient: "owner@example.com",
      }),
    ]);
  });

  it("11/21 payload amounts come from the persisted booking snapshot", async () => {
    const business = buildBusiness();
    const booking = buildBooking({ businessId: business._id });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);

    const payload = calls[0]?.payload as {
      reference: string;
      money: { totalFormatted: string; paidNowFormatted: string; balanceDueFormatted: string };
    };
    expect(payload.reference).toBe("BK-7F3K9QZC");
    expect(payload.money.totalFormatted).toBe("€35.00");
    expect(payload.money.paidNowFormatted).toBe("€7.00");
    expect(payload.money.balanceDueFormatted).toBe("€28.00");
  });

  it("13/14/16 BUSINESS_OWNER-created booking → client email + one owner 'Booking created'", async () => {
    const business = buildBusiness();
    const booking = buildBooking({
      businessId: business._id,
      source: "MANUAL",
      createdBy: { actorUserId: business.ownerUserId, actorRole: "BUSINESS_OWNER" },
    });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);

    expect(calls.map((c) => c.templateKey)).toEqual([
      "BOOKING_FOR_CLIENT_CONFIRMED",
      "BOOKING_STAFF_CREATED_NOTIFICATION",
    ]);
    expect(calls[0]?.recipient).toBe("dana@example.com");
    expect(calls[1]?.recipient).toBe("owner@example.com");
    expect(createdByLabelOf(calls[1])).toBe("You created a booking");
  });

  it("17/18/19/20 SUPERVISOR-created booking → client + supervisor + owner, distinct labels", async () => {
    const business = buildBusiness();
    const supervisorUserId = new Types.ObjectId();
    const booking = buildBooking({
      businessId: business._id,
      source: "MANUAL",
      createdBy: { actorUserId: supervisorUserId, actorRole: "SUPERVISOR" },
    });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async (ids) => {
        expect(ids).toEqual([String(business.ownerUserId), String(supervisorUserId)]);
        return [
          { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
          { _id: supervisorUserId, normalizedEmail: "super@example.com" },
        ];
      },
      findProfilesByUserIds: async () => [
        { userId: supervisorUserId, firstName: "Val", lastName: "Sup" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);

    expect(calls.map((c) => `${c.templateKey}:${c.recipient}`)).toEqual([
      "BOOKING_FOR_CLIENT_CONFIRMED:dana@example.com",
      "BOOKING_STAFF_CREATED_NOTIFICATION:owner@example.com",
      "BOOKING_STAFF_CREATED_NOTIFICATION:super@example.com",
    ]);
    expect(createdByLabelOf(calls[1])).toBe("Val Sup created a booking");
    expect(createdByLabelOf(calls[2])).toBe("You created a booking");
  });

  it("21 supervisor whose email equals the owner's is not sent a duplicate business-side mail", async () => {
    const business = buildBusiness();
    const supervisorUserId = new Types.ObjectId();
    const booking = buildBooking({
      businessId: business._id,
      source: "MANUAL",
      createdBy: { actorUserId: supervisorUserId, actorRole: "SUPERVISOR" },
    });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "shared@example.com" },
        { _id: supervisorUserId, normalizedEmail: "Shared@example.com" },
      ],
      findProfilesByUserIds: async () => [
        { userId: supervisorUserId, firstName: "Val", lastName: "Sup" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);

    const staffMails = calls.filter((c) => c.templateKey === "BOOKING_STAFF_CREATED_NOTIFICATION");
    expect(staffMails).toHaveLength(1);
    expect(staffMails[0]?.recipient).toBe("shared@example.com");
  });

  it("19 supervisor email that cannot be resolved is skipped (client + owner still sent)", async () => {
    const business = buildBusiness();
    const supervisorUserId = new Types.ObjectId();
    const booking = buildBooking({
      businessId: business._id,
      source: "MANUAL",
      createdBy: { actorUserId: supervisorUserId, actorRole: "SUPERVISOR" },
    });
    const { notifier, calls } = makeNotifier({
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
      findProfilesByUserIds: async () => [],
    });

    await notifier.notifyBookingCreated(booking, business);

    expect(calls.map((c) => c.templateKey)).toEqual([
      "BOOKING_FOR_CLIENT_CONFIRMED",
      "BOOKING_STAFF_CREATED_NOTIFICATION",
    ]);
    expect(calls[1]?.recipient).toBe("owner@example.com");
  });

  it("24 an internal error is swallowed — the booking is unaffected", async () => {
    const business = buildBusiness();
    const booking = buildBooking({ businessId: business._id });
    const notifier = new BookingCreatedNotifier(
      { enqueue: vi.fn().mockRejectedValue(new Error("boom")) } as never,
      {
        findManyByIds: async () => {
          throw new Error("db down");
        },
        findProfilesByUserIds: async () => [],
      },
    );
    await expect(notifier.notifyBookingCreated(booking, business)).resolves.toBeUndefined();
  });
});
