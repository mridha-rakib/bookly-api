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
      isActive: true,
      emailVerification: { attempts: 0, resendTimestamps: [] },
      phoneVerification: { attempts: 0, resendTimestamps: [] },
    });
  }

  public async createOrReuseActive(
    input: CreateSessionInput,
  ): Promise<RegistrationSessionDocument> {
    await RegistrationSessionModel.updateMany(
      {
        normalizedEmail: input.normalizedEmail,
        portal: input.portal,
        isActive: true,
        expiresAt: { $lte: new Date() },
      },
      { $set: { isActive: false } },
    );

    try {
      return await RegistrationSessionModel.findOneAndUpdate(
        {
          normalizedEmail: input.normalizedEmail,
          portal: input.portal,
          isActive: true,
          expiresAt: { $gt: new Date() },
        },
        {
          $setOnInsert: {
            ...input,
            isActive: true,
            emailVerification: { attempts: 0, resendTimestamps: [] },
            phoneVerification: { attempts: 0, resendTimestamps: [] },
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
        .select(
          "+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId",
        )
        .orFail()
        .exec();
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await this.findActiveByEmailAndPortal(input.normalizedEmail, input.portal);

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  public async findActiveById(
    id: Types.ObjectId | string,
  ): Promise<RegistrationSessionDocument | null> {
    return RegistrationSessionModel.findOne({
      _id: id,
      isActive: true,
      expiresAt: { $gt: new Date() },
    })
      .select("+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId")
      .exec();
  }

  public async findCompletableById(
    id: Types.ObjectId | string,
  ): Promise<RegistrationSessionDocument | null> {
    return RegistrationSessionModel.findOne({
      _id: id,
      $or: [{ currentStep: "COMPLETED" }, { isActive: true, expiresAt: { $gt: new Date() } }],
    })
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
      isActive: true,
      expiresAt: { $gt: new Date() },
      currentStep: { $ne: "COMPLETED" },
    })
      .select("+passwordHash +emailVerification.otpHash +phoneVerification.providerVerificationId")
      .sort({ updatedAt: -1 })
      .exec();
  }

  public async save(session: RegistrationSessionDocument): Promise<RegistrationSessionDocument> {
    return session.save();
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
          isActive: false,
          completedUserId,
          ...(completedBusinessId ? { completedBusinessId } : {}),
        },
        $unset: {
          passwordHash: "",
          "emailVerification.otpHash": "",
          "phoneVerification.providerVerificationId": "",
        },
      },
      session ? { session } : undefined,
    );
  }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === 11000;
