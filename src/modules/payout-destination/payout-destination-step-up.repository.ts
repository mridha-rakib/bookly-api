import type { Types } from "mongoose";

import {
  type PayoutDestinationStepUpChallengeDocument,
  PayoutDestinationStepUpChallengeModel,
  type PayoutStepUpPurpose,
} from "./payout-destination-step-up.model.js";

type UpsertOtpChallengeInput = {
  otpHash: string;
  otpExpiresAt: Date;
  sentAt: Date;
  resendTimestamps: Date[];
  expiresAt: Date;
};

/**
 * Mirrors ContactChangeChallengeRepository's conventions exactly (select the hashed secret
 * explicitly, upsert the single active slot resetting `attempts`, atomic claim-and-delete), over
 * this module's own `(userId, businessId, purpose)`-keyed collection.
 */
export class PayoutDestinationStepUpRepository {
  public async findActive(
    userId: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
    purpose: PayoutStepUpPurpose,
  ): Promise<PayoutDestinationStepUpChallengeDocument | null> {
    return PayoutDestinationStepUpChallengeModel.findOne({ userId, businessId, purpose })
      .select("+otpHash +authorizationTokenHash")
      .exec();
  }

  /** Overwrites the single active slot for this (user, business, purpose), resetting attempts to
   * 0 and dropping any previously issued authorization proof — "a fresh code invalidates any
   * prior one", the same semantics the registration/contact-change OTP flows use. */
  public async upsertOtpChallenge(
    userId: Types.ObjectId,
    businessId: Types.ObjectId,
    purpose: PayoutStepUpPurpose,
    input: UpsertOtpChallengeInput,
  ): Promise<void> {
    await PayoutDestinationStepUpChallengeModel.updateOne(
      { userId, businessId, purpose },
      {
        $set: { ...input, attempts: 0 },
        $unset: { authorizationTokenHash: "", authorizationExpiresAt: "" },
        $setOnInsert: { userId, businessId, purpose },
      },
      { upsert: true },
    ).exec();
  }

  public async incrementAttempts(id: Types.ObjectId): Promise<void> {
    await PayoutDestinationStepUpChallengeModel.updateOne(
      { _id: id },
      { $inc: { attempts: 1 } },
    ).exec();
  }

  /**
   * PHASE 1 → PHASE 2. Conditional on the OTP still being present, so two concurrent correct-OTP
   * submissions cannot both mint a proof: only the one that finds `otpHash` still set wins, and
   * the loser sees `null`. The OTP fields are cleared in the same write, so a verified code can
   * never be replayed.
   */
  public async promoteToAuthorization(
    id: Types.ObjectId,
    input: { authorizationTokenHash: string; authorizationExpiresAt: Date; expiresAt: Date },
  ): Promise<PayoutDestinationStepUpChallengeDocument | null> {
    return PayoutDestinationStepUpChallengeModel.findOneAndUpdate(
      { _id: id, otpHash: { $exists: true } },
      {
        $set: { ...input, attempts: 0 },
        $unset: { otpHash: "", otpExpiresAt: "" },
      },
      { new: true },
    ).exec();
  }

  /**
   * SINGLE USE. Atomic claim-and-consume of an issued proof: only the caller whose delete
   * succeeds holds a valid authorization, so a replayed token finds nothing (same pattern as
   * ContactChangeChallengeRepository.claimAndDelete). The match is bound to the user, the
   * business, the purpose AND the token hash together — a proof minted for one Business or one
   * purpose can never satisfy another.
   */
  public async consumeAuthorization(input: {
    userId: Types.ObjectId | string;
    businessId: Types.ObjectId | string;
    purpose: PayoutStepUpPurpose;
    authorizationTokenHash: string;
  }): Promise<PayoutDestinationStepUpChallengeDocument | null> {
    return PayoutDestinationStepUpChallengeModel.findOneAndDelete({
      userId: input.userId,
      businessId: input.businessId,
      purpose: input.purpose,
      authorizationTokenHash: input.authorizationTokenHash,
    })
      .select("+authorizationTokenHash")
      .exec();
  }
}
