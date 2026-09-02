import type { Types } from "mongoose";
import type { PhoneNumber } from "../user/user.types.js";
import {
  type ContactChangeChallengeDocument,
  ContactChangeChallengeModel,
  type ContactChangePurpose,
} from "./contact-change-challenge.model.js";

type UpsertEmailChallengeInput = {
  newNormalizedEmail: string;
  otpHash: string;
  otpExpiresAt: Date;
  sentAt: Date;
  resendTimestamps: Date[];
  expiresAt: Date;
};

type UpsertPhoneChallengeInput = {
  newPhone: PhoneNumber;
  providerVerificationId?: string | undefined;
  sentAt: Date;
  resendTimestamps: Date[];
  expiresAt: Date;
};

export class ContactChangeChallengeRepository {
  public async findActive(
    userId: Types.ObjectId | string,
    purpose: ContactChangePurpose,
  ): Promise<ContactChangeChallengeDocument | null> {
    return ContactChangeChallengeModel.findOne({ userId, purpose })
      .select("+otpHash +providerVerificationId")
      .exec();
  }

  /** Overwrites the single active EMAIL_CHANGE slot for this user, resetting attempts to 0 —
   * same "fresh code invalidates any prior one" semantics as the registration OTP flow. */
  public async upsertEmailChallenge(
    userId: Types.ObjectId,
    input: UpsertEmailChallengeInput,
  ): Promise<void> {
    await ContactChangeChallengeModel.updateOne(
      { userId, purpose: "EMAIL_CHANGE" },
      {
        $set: { ...input, attempts: 0 },
        $unset: { newPhone: "", providerVerificationId: "" },
        $setOnInsert: { userId, purpose: "EMAIL_CHANGE" },
      },
      { upsert: true },
    );
  }

  public async upsertPhoneChallenge(
    userId: Types.ObjectId,
    input: UpsertPhoneChallengeInput,
  ): Promise<void> {
    await ContactChangeChallengeModel.updateOne(
      { userId, purpose: "PHONE_CHANGE" },
      {
        $set: { ...input, attempts: 0 },
        $unset: { newNormalizedEmail: "", otpHash: "", otpExpiresAt: "" },
        $setOnInsert: { userId, purpose: "PHONE_CHANGE" },
      },
      { upsert: true },
    );
  }

  public async incrementAttempts(id: Types.ObjectId): Promise<void> {
    await ContactChangeChallengeModel.updateOne({ _id: id }, { $inc: { attempts: 1 } });
  }

  /** Atomic claim-and-consume: only the caller that successfully deletes the document "wins" the
   * verification, so two concurrent correct-OTP submissions can never both commit (Batch 18 §24),
   * and a consumed/deleted challenge can never be replayed (§23). */
  public async claimAndDelete(id: Types.ObjectId): Promise<ContactChangeChallengeDocument | null> {
    return ContactChangeChallengeModel.findOneAndDelete({ _id: id }).exec();
  }

  /** Account-closure cleanup — drop any pending email/phone change challenge slots for this
   * user. Idempotent. Returns how many rows were removed. */
  public async deleteAllForUser(userId: Types.ObjectId | string): Promise<number> {
    const result = await ContactChangeChallengeModel.deleteMany({ userId }).exec();
    return result.deletedCount ?? 0;
  }
}
