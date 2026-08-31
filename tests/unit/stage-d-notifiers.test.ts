import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCancelledNotifier } from "../../src/modules/notification/booking-cancelled.notifier.js";
import { NoShowNotifier } from "../../src/modules/notification/no-show.notifier.js";
import {
  buildBusiness,
  buildCancelledBooking,
  buildNoShowBooking,
  NO_SHOW_CHARGED_AMOUNTS,
} from "./stage-d-fixtures.js";

/** MAILING STAGE D — cancellation + no-show notifiers (Part: cancellation 1,2,6,7,14,15; no-show 18,26,28,30). */

const makeOutbox = () => {
  const enqueue = vi.fn().mockResolvedValue({ created: true, record: {} });
  return { service: { enqueue } as unknown as EmailOutboxService, spy: enqueue };
};

describe("BookingCancelledNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1/2/6/7 enqueues customer + owner rows for both cancelledBy values", async () => {
    for (const cancelledBy of ["CUSTOMER", "BUSINESS"] as const) {
      const outbox = makeOutbox();
      const business = buildBusiness();
      const booking = buildCancelledBooking({}, { businessId: business._id });
      const users = {
        findManyByIds: vi.fn(async () => [
          { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
        ]),
      };

      await new BookingCancelledNotifier(outbox.service, users).notifyBookingCancelled(
        booking,
        business,
        cancelledBy,
      );

      const eventKey = `BOOKING_CANCELLED:${String(booking._id)}`;
      expect(outbox.spy.mock.calls.map((c) => c[0].templateKey).sort()).toEqual([
        "BOOKING_CANCELLED_CUSTOMER",
        "BOOKING_CANCELLED_OWNER",
      ]);
      expect(outbox.spy.mock.calls.every((c) => c[0].eventKey === eventKey)).toBe(true);
      expect(outbox.spy.mock.calls.map((c) => c[0].recipient).sort()).toEqual([
        "dana@example.com",
        "owner@example.com",
      ]);
      // cancelledBy is carried on the shared payload
      expect(outbox.spy.mock.calls[0]?.[0].payload.cancelledBy).toBe(cancelledBy);
    }
  });

  it("15 customer email that equals the owner email is not sent the same template twice", async () => {
    const outbox = makeOutbox();
    const business = buildBusiness();
    const booking = buildCancelledBooking(
      {},
      {
        businessId: business._id,
        customer: {
          businessClientId: business._id,
          contact: {
            firstName: "Dana",
            normalizedEmail: "SAME@example.com",
            phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
          },
        } as never,
      },
    );
    const users = {
      findManyByIds: vi.fn(async () => [
        { _id: business.ownerUserId, normalizedEmail: "same@example.com" },
      ]),
    };

    await new BookingCancelledNotifier(outbox.service, users).notifyBookingCancelled(
      booking,
      business,
      "CUSTOMER",
    );

    // distinct templates, same normalized address -> 2 rows (customer + owner templates differ),
    // but never the SAME template to the SAME address twice.
    const keys = outbox.spy.mock.calls.map((c) => `${c[0].templateKey}:${c[0].recipient}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([
      "BOOKING_CANCELLED_CUSTOMER:same@example.com",
      "BOOKING_CANCELLED_OWNER:same@example.com",
    ]);
  });

  it("3 an internal error is swallowed", async () => {
    const notifier = new BookingCancelledNotifier(
      { enqueue: vi.fn().mockRejectedValue(new Error("x")) } as never,
      { findManyByIds: vi.fn(async () => []) },
    );
    await expect(
      notifier.notifyBookingCancelled(buildCancelledBooking(), buildBusiness(), "CUSTOMER"),
    ).resolves.toBeUndefined();
  });
});

describe("NoShowNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("18/23 CHARGED enqueues the customer email with the domain's own amounts", async () => {
    const outbox = makeOutbox();
    const booking = buildNoShowBooking("NO_SHOW_CHARGED");

    await new NoShowNotifier(outbox.service).notifyNoShowCharged(booking, {
      businessName: "Soho",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });

    expect(outbox.spy).toHaveBeenCalledTimes(1);
    const call = outbox.spy.mock.calls[0]?.[0];
    expect(call.eventKey).toBe(`NO_SHOW_CHARGED:${String(booking._id)}`);
    expect(call.templateKey).toBe("NO_SHOW_CHARGED");
    expect(call.recipient).toBe("dana@example.com");
    expect(call.payload.charged.additionalChargeFormatted).toBe("€4.00");
    expect(call.payload.charged.grossFeeFormatted).toBe("€12.00");
  });

  it("26/28/30 WAIVED and CANCELLED use distinct deterministic event/template keys", async () => {
    const outbox = makeOutbox();
    const b = buildNoShowBooking("NO_SHOW_WAIVED");

    await new NoShowNotifier(outbox.service).notifyNoShowWaived(b, { businessName: "Soho" });
    await new NoShowNotifier(outbox.service).notifyNoShowCancelled(b, { businessName: "Soho" });

    expect(outbox.spy.mock.calls[0]?.[0].eventKey).toBe(`NO_SHOW_WAIVED:${String(b._id)}`);
    expect(outbox.spy.mock.calls[0]?.[0].templateKey).toBe("NO_SHOW_WAIVED");
    expect(outbox.spy.mock.calls[1]?.[0].eventKey).toBe(`NO_SHOW_CANCELLED:${String(b._id)}`);
    expect(outbox.spy.mock.calls[1]?.[0].templateKey).toBe("NO_SHOW_CANCELLED");
  });

  it("no charged/percentage arithmetic in the payload — only formatted strings + outcome", async () => {
    const outbox = makeOutbox();
    await new NoShowNotifier(outbox.service).notifyNoShowWaived(
      buildNoShowBooking("NO_SHOW_WAIVED"),
      { businessName: "Soho" },
    );
    const payload = outbox.spy.mock.calls[0]?.[0].payload;
    expect(payload.charged).toBeUndefined();
    expect(payload.outcome).toBe("WAIVED");
  });
});
