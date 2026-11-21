import { Types } from "mongoose";

import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingLifecycleService } from "../../src/modules/booking/booking-lifecycle.service.js";

/**
 * Fix #5 fixture support. Since Fix #5, a Booking can only be completed — and a legacy Booking
 * (no category no-show window) marked no-show — from its scheduled start. Most integration
 * fixtures book far-future appointments (availability requires a future start) and then exercise
 * completion/no-show lifecycles that have nothing to do with the time boundary.
 *
 * `startAppointment` makes such an appointment genuinely "started": it moves the Booking's
 * schedule (keeping its duration) so it began one minute before the current clock. It never
 * touches a Booking that has already started.
 */
export const startAppointment = async (bookingId: unknown): Promise<void> => {
  if (
    !(bookingId instanceof Types.ObjectId) &&
    !(typeof bookingId === "string" && Types.ObjectId.isValid(bookingId))
  )
    return;
  const booking = await BookingModel.findById(bookingId, { schedule: 1 }).lean();
  if (!booking) return;
  const now = Date.now();
  const startMs = booking.schedule.startAt.getTime();
  if (startMs <= now) return;
  const startAt = new Date(now - 60_000);
  const endAt = new Date(startAt.getTime() + (booking.schedule.endAt.getTime() - startMs));
  await BookingModel.updateOne(
    { _id: booking._id, "schedule.startAt": booking.schedule.startAt },
    { $set: { "schedule.startAt": startAt, "schedule.endAt": endAt } },
  ).exec();
};

/**
 * Opt-in, per test file (Vitest isolates modules per file): before every `completeBooking`, and
 * before `markNoShow` on a Booking WITHOUT a category no-show window, start the appointment as
 * above. Category-window Bookings are never moved, so their own opening/closing boundaries keep
 * being exercised exactly. The Fix #5 boundary itself is covered by
 * booking-time-boundaries-database.integration.test.ts, which does NOT install this.
 */
export const startScheduledAppointmentsBeforeLifecycleActions = (): void => {
  const prototype = BookingLifecycleService.prototype;
  const complete = prototype.completeBooking;
  const markNoShow = prototype.markNoShow;
  prototype.completeBooking = async function (this: BookingLifecycleService, ...args) {
    await startAppointment(args[3]);
    return complete.apply(this, args);
  };
  prototype.markNoShow = async function (this: BookingLifecycleService, ...args) {
    const id = args[3];
    const booking = Types.ObjectId.isValid(id)
      ? await BookingModel.findById(id, { noShowEligibilitySnapshot: 1 }).lean()
      : null;
    if (booking && !booking.noShowEligibilitySnapshot) await startAppointment(args[3]);
    return markNoShow.apply(this, args);
  };
};
