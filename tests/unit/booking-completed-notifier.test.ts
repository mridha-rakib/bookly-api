import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCompletedNotifier } from "../../src/modules/notification/booking-completed.notifier.js";
import { buildBusiness, buildCompletedBooking } from "./stage-c-fixtures.js";

/** MAILING STAGE C — Trigger 5 notifier (Part AE items 3, 4, 5, 51). */

const makeOutbox = () => {
  const enqueue = vi.fn().mockResolvedValue({ created: true, record: {} });
  return { service: { enqueue } as unknown as EmailOutboxService, spy: enqueue };
};

describe("BookingCompletedNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("3/4 enqueues exactly one BOOKING_COMPLETED to the customer snapshot email", async () => {
    const outbox = makeOutbox();
    const business = buildBusiness();
    const booking = buildCompletedBooking({ businessId: business._id });

    await new BookingCompletedNotifier(outbox.service).notifyBookingCompleted(booking, business);

    expect(outbox.spy).toHaveBeenCalledTimes(1);
    const call = outbox.spy.mock.calls[0]?.[0];
    expect(call.eventKey).toBe(`BOOKING_COMPLETED:${String(booking._id)}`);
    expect(call.templateKey).toBe("BOOKING_COMPLETED");
    expect(call.recipient).toBe("dana@example.com");
    expect(call.payload.invoice.bookingReference).toBe("BK-7F3K9QZC");
    expect(call.payload.invoice.financial.settlementStatus).toBe("FULL");
    expect(call.payload.customerBookingUrlPath).toBe(
      `/customer/bookings/view?id=${String(booking._id)}`,
    );
  });

  it("omits the CTA path when the customer is not a linked user", async () => {
    const outbox = makeOutbox();
    const booking = buildCompletedBooking({
      customer: {
        businessClientId: new Types.ObjectId(),
        contact: {
          firstName: "Dana",
          normalizedEmail: "dana@example.com",
          phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
        },
      } as never,
    });
    await new BookingCompletedNotifier(outbox.service).notifyBookingCompleted(
      booking,
      buildBusiness(),
    );
    expect(outbox.spy.mock.calls[0]?.[0].payload.customerBookingUrlPath).toBeUndefined();
  });

  it("5/51 a blank recipient is skipped; an enqueue error is swallowed", async () => {
    const outbox = makeOutbox();
    const booking = buildCompletedBooking({
      customer: {
        businessClientId: new Types.ObjectId(),
        contact: {
          firstName: "X",
          normalizedEmail: "   ",
          phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
        },
      } as never,
    });
    await expect(
      new BookingCompletedNotifier(outbox.service).notifyBookingCompleted(booking, buildBusiness()),
    ).resolves.toBeUndefined();
    expect(outbox.spy).not.toHaveBeenCalled();

    const throwing = { enqueue: vi.fn().mockRejectedValue(new Error("db")) } as never;
    await expect(
      new BookingCompletedNotifier(throwing).notifyBookingCompleted(
        buildCompletedBooking(),
        buildBusiness(),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not expose payment-method / Stripe / internal-note fields", async () => {
    const outbox = makeOutbox();
    await new BookingCompletedNotifier(outbox.service).notifyBookingCompleted(
      buildCompletedBooking({ notes: "INTERNAL: customer was late" } as never),
      buildBusiness(),
    );
    const json = JSON.stringify(outbox.spy.mock.calls[0]?.[0]).toLowerCase();
    for (const forbidden of [
      "paymentmethod",
      "pm_",
      "cus_",
      "pi_",
      "internal:",
      "card",
      "stripe",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
