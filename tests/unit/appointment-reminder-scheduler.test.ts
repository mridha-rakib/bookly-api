import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppointmentReminderRepository } from "../../src/modules/appointment-reminder/appointment-reminder.repository.js";
import { AppointmentReminderScheduler } from "../../src/modules/appointment-reminder/appointment-reminder-scheduler.js";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";

const makeBooking = (overrides: Partial<BookingDocument> = {}): BookingDocument => {
  const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  return {
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    status: "UPCOMING",
    customer: { customerUserId: new Types.ObjectId(), contact: {} },
    schedule: {
      startAt,
      endAt: new Date(startAt.getTime() + 3_600_000),
      timezone: "Europe/Nicosia",
    },
    ...overrides,
  } as unknown as BookingDocument;
};

const makeRepo = () => {
  const schedule = vi.fn().mockImplementation(async ({ scheduleStartAt, now }) => {
    const dueAt = new Date(scheduleStartAt.getTime() - 24 * 60 * 60 * 1000);
    const isLate = dueAt.getTime() <= now.getTime();
    return {
      created: true,
      record: {
        _id: new Types.ObjectId(),
        dueAt,
        status: isLate ? "SKIPPED" : "PENDING",
      },
    };
  });
  const retireActiveForBooking = vi.fn().mockResolvedValue(1);
  return {
    repo: { schedule, retireActiveForBooking } as unknown as AppointmentReminderRepository,
    schedule,
    retireActiveForBooking,
  };
};

describe("AppointmentReminderScheduler", () => {
  let repo: ReturnType<typeof makeRepo>;
  let scheduler: AppointmentReminderScheduler;

  beforeEach(() => {
    repo = makeRepo();
    scheduler = new AppointmentReminderScheduler(repo.repo);
  });

  it("onBookingCreated schedules a reminder for a linked-customer UPCOMING booking >24h away", async () => {
    const booking = makeBooking();
    await scheduler.onBookingCreated(booking);

    expect(repo.schedule).toHaveBeenCalledTimes(1);
    expect(repo.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "REMINDER_24H",
        bookingId: booking._id,
        businessId: booking.businessId,
        customerUserId: booking.customer.customerUserId,
        scheduleStartAt: booking.schedule.startAt,
      }),
    );
  });

  it("onBookingCreated does NOT schedule for a walk-in booking (no linked customer account)", async () => {
    await scheduler.onBookingCreated(makeBooking({ customer: { contact: {} } as never }));
    expect(repo.schedule).not.toHaveBeenCalled();
  });

  it("onBookingCreated does NOT schedule for a non-UPCOMING booking", async () => {
    await scheduler.onBookingCreated(makeBooking({ status: "COMPLETED" }));
    expect(repo.schedule).not.toHaveBeenCalled();
  });

  it("onBookingCreated inside the 24h window records a SKIPPED row, never a firing reminder", async () => {
    const startAt = new Date(Date.now() + 60 * 60 * 1000); // 1h away
    const booking = makeBooking({
      schedule: {
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        timezone: "Europe/Nicosia",
      } as never,
    });
    await scheduler.onBookingCreated(booking);
    const result = await repo.schedule.mock.results[0]?.value;
    expect(result.record.status).toBe("SKIPPED");
  });

  it("onBookingRescheduled retires the old schedule version and schedules the new one", async () => {
    const booking = makeBooking();
    await scheduler.onBookingRescheduled(booking);

    expect(repo.retireActiveForBooking).toHaveBeenCalledWith(
      booking._id,
      "SUPERSEDED_BY_RESCHEDULE",
      expect.objectContaining({ exceptDedupeKey: expect.stringContaining(String(booking._id)) }),
    );
    expect(repo.schedule).toHaveBeenCalledTimes(1);
  });

  it("onBookingRetired retires every active reminder for the booking with the given reason", async () => {
    const booking = makeBooking({ status: "CANCELLED_BY_CUSTOMER" });
    await scheduler.onBookingRetired(booking, "BOOKING_CANCELLED_BY_CUSTOMER");
    expect(repo.retireActiveForBooking).toHaveBeenCalledWith(
      booking._id,
      "BOOKING_CANCELLED_BY_CUSTOMER",
      expect.objectContaining({ now: expect.any(Date) }),
    );
  });

  it("never throws — a repository failure is swallowed and logged, so the booking is unaffected", async () => {
    repo.schedule.mockRejectedValueOnce(new Error("db down"));
    await expect(scheduler.onBookingCreated(makeBooking())).resolves.toBeUndefined();
  });
});
