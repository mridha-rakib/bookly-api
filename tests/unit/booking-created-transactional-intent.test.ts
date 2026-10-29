import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import {
  BookingCreatedNotifier,
  type BookingNotificationUserPort,
} from "../../src/modules/notification/booking-created.notifier.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/**
 * F4A Tier 2 — BookingCreatedNotifier.enqueueBookingCreatedInTransaction. Synthetic doubles
 * only; the real transaction behavior is covered in financial-relationship-database
 * integration tests ("F4A-T2 …").
 */

const session = { inTransaction: () => true } as unknown as ClientSession;

const ownerPort = (ownerUserId: unknown): BookingNotificationUserPort => ({
  findManyByIds: async () => [{ _id: ownerUserId, normalizedEmail: "owner@example.com" }],
  findProfilesByUserIds: async () => [],
});

const setup = (users?: BookingNotificationUserPort, enqueueImpl?: () => Promise<unknown>) => {
  const business = buildBusiness();
  const booking = buildBooking({
    businessId: business._id,
    createdBy: { actorUserId: new Types.ObjectId(), actorRole: "CUSTOMER" },
  });
  const enqueue = vi.fn(enqueueImpl ?? (async () => ({ created: true, record: {} })));
  const notifier = new BookingCreatedNotifier(
    { enqueue } as unknown as Pick<EmailOutboxService, "enqueue">,
    users ?? ownerPort(business.ownerUserId),
  );
  return { business, booking, enqueue, notifier };
};

describe("BookingCreatedNotifier.enqueueBookingCreatedInTransaction", () => {
  it("writes the same rows as the legacy path, each with the caller's transaction session", async () => {
    const tx = setup();
    const legacy = setup();

    await tx.notifier.enqueueBookingCreatedInTransaction(tx.booking, tx.business, session);
    await legacy.notifier.notifyBookingCreated(tx.booking, tx.business);

    expect(tx.enqueue.mock.calls.map((call) => call[0])).toEqual(
      legacy.enqueue.mock.calls.map((call) => call[0]),
    );
    expect(tx.enqueue.mock.calls.every((call) => call[1] === session)).toBe(true);
    // Legacy keeps its exact one-argument call.
    expect(legacy.enqueue.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(tx.enqueue.mock.calls[0]?.[0]).toMatchObject({
      eventKey: `BOOKING_CREATED:${String(tx.booking._id)}`,
      templateKey: "BOOKING_CUSTOMER_CONFIRMED",
      recipient: "dana@example.com",
    });
  });

  it("an outbox insert failure propagates so the Booking transaction aborts (O1)", async () => {
    const { booking, business, notifier } = setup(undefined, async () => {
      throw new Error("insert failed");
    });

    await expect(
      notifier.enqueueBookingCreatedInTransaction(booking, business, session),
    ).rejects.toThrow("insert failed");
  });

  it("a User lookup failure skips only business-side recipients and never throws", async () => {
    const { booking, business, enqueue, notifier } = setup({
      findManyByIds: async () => {
        throw new Error("db down");
      },
      findProfilesByUserIds: async () => [],
    });

    await notifier.enqueueBookingCreatedInTransaction(booking, business, session);

    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        templateKey: "BOOKING_CUSTOMER_CONFIRMED",
        recipient: "dana@example.com",
      }),
    ]);
  });

  it("an unusable recipient is skipped rather than aborting the Booking", async () => {
    const { business, enqueue, notifier } = setup();
    const booking = buildBooking({ businessId: business._id });
    booking.customer.contact.normalizedEmail = "   ";

    await notifier.enqueueBookingCreatedInTransaction(booking, business, session);

    expect(
      enqueue.mock.calls.every(
        (call) => (call[0] as { recipient: string }).recipient === "owner@example.com",
      ),
    ).toBe(true);
  });

  it("the legacy entry point still swallows every failure", async () => {
    const { booking, business, notifier } = setup(undefined, async () => {
      throw new Error("insert failed");
    });

    await expect(notifier.notifyBookingCreated(booking, business)).resolves.toBeUndefined();
  });
});
