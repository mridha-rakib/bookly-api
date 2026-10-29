import { isDeepStrictEqual } from "node:util";
import type { ClientSession } from "mongoose";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { batchConflict } from "./package-batch-contract.js";
import {
  type CalendarJournal,
  calendarJournalSchema,
  grantCalendarJournalWrite,
} from "./package-calendar-contract.js";

/** A per-Booking extension of the existing delivery tasks, not another queue or scheduler. */
export class PackageCalendarRepository {
  async read(bookingId: string, businessId: string) {
    return BookingModel.findOne({ _id: bookingId, businessId })
      .select("+packageCalendarDelivery")
      .read("primary")
      .maxTimeMS(2000)
      .lean<BookingDocument>();
  }

  async compareAndSet(
    booking: BookingDocument,
    previous: CalendarJournal | undefined,
    input: CalendarJournal,
    options: { session?: ClientSession; persistEventId?: boolean; rebind?: boolean } = {},
  ) {
    await verifyPackageBatchActivation();
    const next = calendarJournalSchema.parse(input);
    if (
      next.bookingId !== String(booking._id) ||
      next.businessId !== String(booking.businessId) ||
      next.destination.businessId !== next.businessId ||
      (previous &&
        options.rebind &&
        (previous.destination.accountId !== next.destination.accountId ||
          previous.destination.accountEmail !== next.destination.accountEmail ||
          previous.destination.calendarId !== next.destination.calendarId)) ||
      (previous &&
        (previous.eventId !== next.eventId ||
          (!options.rebind && !isDeepStrictEqual(previous.destination, next.destination))))
    )
      throw batchConflict();
    const query = BookingModel.updateOne(
      {
        _id: booking._id,
        businessId: booking.businessId,
        "customer.customerUserId": booking.customer.customerUserId,
        "customer.businessClientId": booking.customer.businessClientId,
        status: booking.status,
        schedule: booking.schedule,
        reference: booking.reference,
        eventHistory: booking.eventHistory,
        rescheduleHistory: booking.rescheduleHistory,
        serviceLines: booking.serviceLines,
        googleCalendarEventId: booking.googleCalendarEventId ?? { $exists: false },
        packageCalendarDelivery: previous ?? { $exists: false },
      },
      {
        $set: {
          packageCalendarDelivery: next,
          ...(options.persistEventId ? { googleCalendarEventId: next.eventId } : {}),
        },
      },
      options.session ? { session: options.session } : { writeConcern: { w: "majority" } },
    );
    grantCalendarJournalWrite(query);
    return (await query).matchedCount === 1;
  }
}
