import type { Types } from "mongoose";

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
      return { isNew: false, bookingId: existing.bookingId };
    }
  }

  /** Only ever called when the transactional creation that followed a fresh `claim()` failed —
   * a failed attempt must not permanently occupy this idempotency key (see the model's own
   * comment). Never called for an `isNew: false` result (that claim belongs to a prior,
   * possibly-successful attempt this caller has no right to invalidate). */
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
