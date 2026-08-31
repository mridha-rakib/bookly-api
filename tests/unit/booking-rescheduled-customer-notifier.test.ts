import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import { BookingRescheduledCustomerNotifier } from "../../src/modules/notification/booking-rescheduled-customer.notifier.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/**
 * CUSTOMER RESCHEDULE CONFIRMATION EMAIL — notifier unit coverage. Mandatory transactional:
 * fires for a customer AND an Owner/Supervisor reschedule, is never gated by a reminder
 * preference, reads the old/new times from the last append-only history entry, and keys the
 * EmailOutbox row on the reschedule ordinal so a retry is one logical email and the next real
 * reschedule is its own.
 */

const makeOutbox = () => {
  const enqueue = vi.fn().mockResolvedValue({ created: true, record: {} });
  return { service: { enqueue } as unknown as EmailOutboxService, spy: enqueue };
};

type Actor = "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR";

const rescheduleEntry = (opts: {
  actorRole?: Actor;
  previousStart: string;
  newStart: string;
  newEnd?: string;
}) => ({
  actorUserId: new Types.ObjectId(),
  actorRole: opts.actorRole ?? ("CUSTOMER" as Actor),
  previousStart: new Date(opts.previousStart),
  previousEnd: new Date(opts.previousStart),
  newStart: new Date(opts.newStart),
  newEnd: new Date(opts.newEnd ?? opts.newStart),
  countedTowardCustomerQuota: (opts.actorRole ?? "CUSTOMER") === "CUSTOMER",
  createdAt: new Date(),
});

const bookingWithHistory = (
  entries: ReturnType<typeof rescheduleEntry>[],
  overrides: Partial<BookingDocument> = {},
): BookingDocument =>
  buildBooking({
    schedule: {
      timezone: "Europe/Nicosia",
      startAt: entries.at(-1)?.newStart ?? new Date("2026-09-08T13:30:00.000Z"),
      endAt: entries.at(-1)?.newEnd ?? new Date("2026-09-08T14:15:00.000Z"),
    },
    rescheduleHistory: entries,
    ...overrides,
  } as never);

describe("BookingRescheduledCustomerNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has exactly one constructor dependency (the outbox seam) — no policy / user / repo", () => {
    expect(BookingRescheduledCustomerNotifier.length).toBe(1);
  });

  it("1 enqueues for a CUSTOMER reschedule — ordinal eventKey, dedicated template, snapshot recipient", async () => {
    const outbox = makeOutbox();
    const booking = bookingWithHistory([
      rescheduleEntry({
        actorRole: "CUSTOMER",
        previousStart: "2026-09-05T09:00:00.000Z",
        newStart: "2026-09-08T13:30:00.000Z",
        newEnd: "2026-09-08T14:15:00.000Z",
      }),
    ]);

    await new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
      booking,
      buildBusiness({ name: "Soho Vintage Barbers" }),
    );

    expect(outbox.spy).toHaveBeenCalledTimes(1);
    const call = outbox.spy.mock.calls[0]?.[0];
    expect(call.eventKey).toBe(`BOOKING_RESCHEDULED:${String(booking._id)}:1`);
    expect(call.templateKey).toBe("BOOKING_RESCHEDULED_CUSTOMER");
    expect(call.recipient).toBe("dana@example.com");
    expect(call.payload.rescheduledByBusiness).toBe(false);
    expect(call.payload.businessName).toBe("Soho Vintage Barbers");
    expect(call.payload.bookingReference).toBe("BK-7F3K9QZC");
  });

  it("2 enqueues for an Owner AND a Supervisor reschedule, flagged rescheduledByBusiness", async () => {
    for (const actorRole of ["BUSINESS_OWNER", "SUPERVISOR"] as const) {
      const outbox = makeOutbox();
      const booking = bookingWithHistory([
        rescheduleEntry({
          actorRole,
          previousStart: "2026-09-05T09:00:00.000Z",
          newStart: "2026-09-08T13:30:00.000Z",
        }),
      ]);

      await new BookingRescheduledCustomerNotifier(
        outbox.service,
      ).notifyBookingRescheduledToCustomer(booking, buildBusiness());

      expect(outbox.spy).toHaveBeenCalledTimes(1);
      expect(outbox.spy.mock.calls[0]?.[0].payload.rescheduledByBusiness).toBe(true);
      expect(outbox.spy.mock.calls[0]?.[0].templateKey).toBe("BOOKING_RESCHEDULED_CUSTOMER");
    }
  });

  it("3/4 recipient is the normalized booking contact snapshot email, never a User lookup", async () => {
    const outbox = makeOutbox();
    const booking = bookingWithHistory(
      [
        rescheduleEntry({
          previousStart: "2026-09-05T09:00:00.000Z",
          newStart: "2026-09-08T13:30:00.000Z",
        }),
      ],
      {
        customer: {
          businessClientId: new Types.ObjectId(),
          customerUserId: new Types.ObjectId(),
          contact: {
            firstName: "Dana",
            lastName: "Klein",
            normalizedEmail: "  DANA@Example.COM  ",
            phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
          },
        } as never,
      },
    );

    await new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
      booking,
      buildBusiness(),
    );

    expect(outbox.spy.mock.calls[0]?.[0].recipient).toBe("dana@example.com");
  });

  it("5 eventKey is the reschedule ordinal — a second genuine reschedule is :2", async () => {
    const outbox = makeOutbox();
    const booking = bookingWithHistory([
      rescheduleEntry({
        previousStart: "2026-09-05T09:00:00.000Z",
        newStart: "2026-09-08T13:30:00.000Z",
      }),
      rescheduleEntry({
        previousStart: "2026-09-08T13:30:00.000Z",
        newStart: "2026-09-10T16:00:00.000Z",
      }),
    ]);

    await new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
      booking,
      buildBusiness(),
    );

    expect(outbox.spy.mock.calls[0]?.[0].eventKey).toBe(
      `BOOKING_RESCHEDULED:${String(booking._id)}:2`,
    );
  });

  it("7/8/9/10 frozen payload carries both times formatted in Booking.schedule.timezone + duration", async () => {
    const outbox = makeOutbox();
    // 09:00Z previous, 13:30Z new; Europe/Nicosia is UTC+3 in September.
    const booking = bookingWithHistory([
      rescheduleEntry({
        previousStart: "2026-09-05T09:00:00.000Z",
        newStart: "2026-09-08T13:30:00.000Z",
        newEnd: "2026-09-08T14:15:00.000Z",
      }),
    ]);

    await new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
      booking,
      buildBusiness(),
    );

    const payload = outbox.spy.mock.calls[0]?.[0].payload;
    expect(payload.previousTime).toBe("12:00");
    expect(payload.newTime).toBe("16:30");
    expect(payload.venueTimezone).toBe("Europe/Nicosia");
    expect(payload.durationMin).toBe(45);
    expect(payload.previousDate).toContain("September");
  });

  it("12 a same-time (no-op) reschedule enqueues nothing", async () => {
    const outbox = makeOutbox();
    const sameInstant = "2026-09-05T09:00:00.000Z";
    const booking = bookingWithHistory([
      rescheduleEntry({ previousStart: sameInstant, newStart: sameInstant }),
    ]);

    await new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
      booking,
      buildBusiness(),
    );

    expect(outbox.spy).not.toHaveBeenCalled();
  });

  it("13 a booking with no reschedule history entry is a safe no-op", async () => {
    const outbox = makeOutbox();
    await expect(
      new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
        buildBooking({ rescheduleHistory: [] } as never),
        buildBusiness(),
      ),
    ).resolves.toBeUndefined();
    expect(outbox.spy).not.toHaveBeenCalled();
  });

  it("14 an unusable recipient is warned + skipped, never enqueued, never thrown", async () => {
    const outbox = makeOutbox();
    const booking = bookingWithHistory(
      [
        rescheduleEntry({
          previousStart: "2026-09-05T09:00:00.000Z",
          newStart: "2026-09-08T13:30:00.000Z",
        }),
      ],
      {
        customer: {
          businessClientId: new Types.ObjectId(),
          contact: {
            firstName: "Dana",
            normalizedEmail: "   ",
            phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
          },
        } as never,
      },
    );

    await expect(
      new BookingRescheduledCustomerNotifier(outbox.service).notifyBookingRescheduledToCustomer(
        booking,
        buildBusiness(),
      ),
    ).resolves.toBeUndefined();
    expect(outbox.spy).not.toHaveBeenCalled();
  });

  it("an enqueue failure is swallowed (never undoes the committed reschedule)", async () => {
    const notifier = new BookingRescheduledCustomerNotifier({
      enqueue: vi.fn().mockRejectedValue(new Error("outbox down")),
    } as never);
    const booking = bookingWithHistory([
      rescheduleEntry({
        previousStart: "2026-09-05T09:00:00.000Z",
        newStart: "2026-09-08T13:30:00.000Z",
      }),
    ]);

    await expect(
      notifier.notifyBookingRescheduledToCustomer(booking, buildBusiness()),
    ).resolves.toBeUndefined();
  });

  it("15 a duplicate invocation re-derives the SAME deterministic eventKey (outbox dedupe compatible)", async () => {
    const outbox = makeOutbox();
    const booking = bookingWithHistory([
      rescheduleEntry({
        previousStart: "2026-09-05T09:00:00.000Z",
        newStart: "2026-09-08T13:30:00.000Z",
      }),
    ]);
    const notifier = new BookingRescheduledCustomerNotifier(outbox.service);

    await notifier.notifyBookingRescheduledToCustomer(booking, buildBusiness());
    await notifier.notifyBookingRescheduledToCustomer(booking, buildBusiness());

    expect(outbox.spy).toHaveBeenCalledTimes(2);
    expect(outbox.spy.mock.calls[0]?.[0].eventKey).toBe(outbox.spy.mock.calls[1]?.[0].eventKey);
    expect(outbox.spy.mock.calls[0]?.[0].eventKey).toBe(
      `BOOKING_RESCHEDULED:${String(booking._id)}:1`,
    );
  });
});
