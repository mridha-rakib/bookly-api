import type { ClientSession, Types } from "mongoose";

import { type LinkedAccountDocument, LinkedAccountModel } from "./linked-account.model.js";
import type { LinkedAccountProvider } from "./linked-account.types.js";

export type CreateLinkedAccountInput = {
  userId: Types.ObjectId;
  provider: LinkedAccountProvider;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  linkedAt: Date;
};

/**
 * Database access only — no domain rules. Collision detection, password checks and the
 * last-credential guard all live in LinkedAccountService.
 */
export class LinkedAccountRepository {
  public async findByProviderAccount(
    provider: LinkedAccountProvider,
    providerAccountId: string,
  ): Promise<LinkedAccountDocument | null> {
    return LinkedAccountModel.findOne({ provider, providerAccountId }).exec();
  }

  public async findByUserAndProvider(
    userId: Types.ObjectId | string,
    provider: LinkedAccountProvider,
  ): Promise<LinkedAccountDocument | null> {
    return LinkedAccountModel.findOne({ userId, provider }).exec();
  }

  public async findByUserId(userId: Types.ObjectId | string): Promise<LinkedAccountDocument[]> {
    return LinkedAccountModel.find({ userId }).sort({ linkedAt: 1 }).exec();
  }

  /** `session` lets the Customer Google-signup path create the User, UserProfile and this row in
   * one transaction. Without it, behaviour is identical to the previous `Model.create(input)`. */
  public async create(
    input: CreateLinkedAccountInput,
    session?: ClientSession,
  ): Promise<LinkedAccountDocument> {
    return new LinkedAccountModel(input).save(session ? { session } : undefined);
  }

  public async deleteByUserAndProvider(
    userId: Types.ObjectId | string,
    provider: LinkedAccountProvider,
  ): Promise<boolean> {
    const result = await LinkedAccountModel.deleteOne({ userId, provider }).exec();

    return result.deletedCount > 0;
  }

  public async deleteAllForUser(userId: Types.ObjectId | string): Promise<void> {
    await LinkedAccountModel.deleteMany({ userId }).exec();
  }
}
