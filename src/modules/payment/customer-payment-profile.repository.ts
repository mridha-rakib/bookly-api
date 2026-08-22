import type { ClientSession, Types } from "mongoose";

import {
  type CustomerPaymentProfileDocument,
  CustomerPaymentProfileModel,
} from "./customer-payment-profile.model.js";

export type UpsertPaymentMethodInput = {
  userId: Types.ObjectId | string;
  defaultPaymentMethodId: string;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: number;
  cardExpYear: number;
};

export class CustomerPaymentProfileRepository {
  public async findByUserId(
    userId: Types.ObjectId | string,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOne({ userId }).exec();
  }

  /** Idempotent create-if-missing — the resolve-or-create entry point every payment touchpoint
   * calls first. A concurrent double-create race resolves via the unique `{userId}` index. */
  public async createIfMissing(
    userId: Types.ObjectId | string,
    stripeCustomerId: string,
    session?: ClientSession,
  ): Promise<CustomerPaymentProfileDocument> {
    return CustomerPaymentProfileModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, stripeCustomerId } },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      },
    ).orFail();
  }

  public async savePaymentMethod(
    input: UpsertPaymentMethodInput,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          defaultPaymentMethodId: input.defaultPaymentMethodId,
          cardBrand: input.cardBrand,
          cardLast4: input.cardLast4,
          cardExpMonth: input.cardExpMonth,
          cardExpYear: input.cardExpYear,
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOne({ stripeCustomerId }).exec();
  }
}
