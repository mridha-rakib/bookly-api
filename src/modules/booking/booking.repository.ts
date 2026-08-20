import type { ClientSession, Types } from "mongoose";

import { type BookingDocument, BookingModel } from "./booking.model.js";

export type CreateBookingInput = Omit<BookingDocument, "_id" | "createdAt" | "updatedAt">;

/**
 * Deliberately minimal in this phase: create + the read paths needed to prove the schema and
 * its indexes behave correctly (see the corresponding integration test). List/filter/pagination
 * endpoints that a real Booking UI needs (All Bookings, Calendar range, Client history, My
 * Bookings) are Phase 2/3 work once availability/creation are real — adding them now against
 * data no creation flow can yet populate would be speculative.
 */
export class BookingRepository {
  public async create(
    input: CreateBookingInput,
    session?: ClientSession,
  ): Promise<BookingDocument> {
    return new BookingModel(input).save(session ? { session } : undefined);
  }

  public async findById(
    businessId: Types.ObjectId | string,
    bookingId: Types.ObjectId | string,
  ): Promise<BookingDocument | null> {
    return BookingModel.findOne({ _id: bookingId, businessId }).exec();
  }

  public async findByReference(reference: string): Promise<BookingDocument | null> {
    return BookingModel.findOne({ reference: reference.toUpperCase() }).exec();
  }

  /**
   * Proves the `{businessId, "schedule.startAt"}` index shape (the future Calendar/All
   * Bookings query) end to end. Inclusive of both bounds, ascending by start time.
   */
  public async findManyByBusinessIdInRange(
    businessId: Types.ObjectId | string,
    startAt: Date,
    endAt: Date,
  ): Promise<BookingDocument[]> {
    return BookingModel.find({
      businessId,
      "schedule.startAt": { $gte: startAt, $lte: endAt },
    })
      .sort({ "schedule.startAt": 1 })
      .exec();
  }
}
