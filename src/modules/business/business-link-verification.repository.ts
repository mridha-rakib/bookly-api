import type { ClientSession, Types } from "mongoose";

import {
  type BusinessLinkVerificationDocument,
  BusinessLinkVerificationModel,
} from "./business-link-verification.model.js";

export type CreateBusinessLinkVerificationInput = {
  requesterUserId: Types.ObjectId;
  targetUserId: Types.ObjectId;
  targetBusinessId: Types.ObjectId;
  normalizedEmail: string;
  otpHash: string;
  otpExpiresAt: Date;
  sentAt: Date;
};

export class BusinessLinkVerificationRepository {
  public async create(
    input: CreateBusinessLinkVerificationInput,
  ): Promise<BusinessLinkVerificationDocument> {
    return BusinessLinkVerificationModel.create({
      ...input,
      attempts: 0,
      resendTimestamps: [input.sentAt],
    });
  }

  public async findByIdForRequester(
    id: string,
    requesterUserId: Types.ObjectId | string,
  ): Promise<BusinessLinkVerificationDocument | null> {
    return BusinessLinkVerificationModel.findOne({ _id: id, requesterUserId })
      .select("+otpHash")
      .exec();
  }

  public async save(
    verification: BusinessLinkVerificationDocument,
  ): Promise<BusinessLinkVerificationDocument> {
    return verification.save();
  }

  public async markConsumed(id: Types.ObjectId, session?: ClientSession): Promise<void> {
    await BusinessLinkVerificationModel.updateOne(
      { _id: id },
      { $set: { consumedAt: new Date() }, $unset: { otpHash: "" } },
      session ? { session } : undefined,
    );
  }
}
