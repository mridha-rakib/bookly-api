import type { Types } from "mongoose";

import { BookingError } from "./booking.errors.js";
import {
  type BookingCreationClaimDocument,
  BookingCreationClaimModel,
} from "./booking-creation-claim.model.js";

export type ClaimBookingCreationInput = {
  idempotencyKey: string;
  businessId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  bookingId: Types.ObjectId;
};

export type ClaimBookingCreationResult = {
  isNew: boolean;
  bookingId: Types.ObjectId;
};

export class BookingCreationClaimRepository {
  /** See booking-creation-claim.model.ts for the full idempotency-contract rationale. */
  public async claim(input: ClaimBookingCreationInput): Promise<ClaimBookingCreationResult> {
    try {
      await new BookingCreationClaimModel(input).save();
      return { isNew: true, bookingId: input.bookingId };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      const existing = await BookingCreationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      }).orFail();
      if (
        String(existing.businessId) !== String(input.businessId) ||
        String(existing.actorUserId) !== String(input.actorUserId)
      ) {
        throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
      }
      return { isNew: false, bookingId: existing.bookingId };
    }
  }

  /** Called only for failures that have no durable provider money operation. Charge-bearing
   * failures retain their claim as part of PaymentAttempt resume/compensation correlation. */
  public async release(idempotencyKey: string): Promise<void> {
    await BookingCreationClaimModel.deleteOne({ idempotencyKey }).exec();
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BookingCreationClaimDocument | null> {
    return BookingCreationClaimModel.findOne({ idempotencyKey }).exec();
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
