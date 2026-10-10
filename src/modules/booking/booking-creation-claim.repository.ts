import type { Types } from "mongoose";

import { BookingError } from "./booking.errors.js";
import {
  type BookingCreationClaimDocument,
  BookingCreationClaimModel,
} from "./booking-creation-claim.model.js";
import { type FinancialContractV2, findFinancialContractMismatch } from "./financial-contract.js";

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

  /**
   * P1 — records the Financial Contract V2 exactly once (set-if-absent CAS). A later call for the
   * same logical operation must describe identical money terms; any immutable-field difference
   * fails closed with BOOKING_FINANCIAL_CONTRACT_CONFLICT rather than mutating the contract (e.g.
   * a FIRST operation silently becoming RETURNING across a 3DS retry). Also fails closed when
   * the claim itself no longer exists (it was released as a definitive pre-money failure).
   */
  public async recordFinancialContract(
    idempotencyKey: string,
    contract: FinancialContractV2,
  ): Promise<FinancialContractV2> {
    if (contract.idempotencyKey !== idempotencyKey) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    const recorded = await BookingCreationClaimModel.findOneAndUpdate(
      {
        idempotencyKey,
        bookingId: contract.bookingId,
        financialContract: { $exists: false },
      },
      { $set: { financialContract: contract } },
      { returnDocument: "after", runValidators: true },
    ).exec();
    if (recorded?.financialContract) return recorded.financialContract;

    const existing = await BookingCreationClaimModel.findOne({ idempotencyKey }).exec();
    if (!existing?.financialContract || !existing.bookingId.equals(contract.bookingId)) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    if (findFinancialContractMismatch(existing.financialContract, contract)) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    return existing.financialContract;
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
