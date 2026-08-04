import type { ClientSession, Types } from "mongoose";

import {
  type RegistrationPortal,
  type RegistrationSessionDocument,
  RegistrationSessionModel,
  type RegistrationStep,
} from "./registration-session.model.js";

type CreateSessionInput = {
  portal: RegistrationPortal;
  intendedRole: "CUSTOMER" | "BUSINESS_OWNER";
  normalizedEmail: string;
  currentStep: RegistrationStep;
  expiresAt: Date;
};

export class RegistrationSessionRepository {
  public async create(input: CreateSessionInput): Promise<RegistrationSessionDocument> {
    return RegistrationSessionModel.create({
      ...input,
      emailVerification: { attempts: 0, resendTimestamps: [] },
      phoneVerification: { attempts: 0, resendTimestamps: [] },
    });
  }

  public async findActiveById(
    id: Types.ObjectId | string,
  ): Promise<RegistrationSessionDocument | null> {
    return RegistrationSessionModel.findOne({ _id: id, expiresAt: { $gt: new Date() } })
      .select("+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId")
      .exec();
  }

  public async findActiveByEmailAndPortal(
    normalizedEmail: string,
    portal: RegistrationPortal,
  ): Promise<RegistrationSessionDocument | null> {
    return RegistrationSessionModel.findOne({
      normalizedEmail,
      portal,
      expiresAt: { $gt: new Date() },
      currentStep: { $ne: "COMPLETED" },
    })
      .select("+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId")
      .sort({ updatedAt: -1 })
      .exec();
  }

  public async save(session: RegistrationSessionDocument): Promise<RegistrationSessionDocument> {
    return (session as unknown as { save(): Promise<RegistrationSessionDocument> }).save();
  }

  public async markCompleted(
    id: Types.ObjectId,
    completedUserId: Types.ObjectId,
    completedBusinessId?: Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    await RegistrationSessionModel.updateOne(
      { _id: id },
      {
        $set: {
          currentStep: "COMPLETED",
          completedUserId,
          ...(completedBusinessId ? { completedBusinessId } : {}),
        },
      },
      { session } as never,
    );
  }
}
