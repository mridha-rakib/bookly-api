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

export type ReplaceStaleStripeCustomerInput = {
  userId: Types.ObjectId | string;
  staleStripeCustomerId: string;
  replacementStripeCustomerId: string;
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

  /**
   * Repairs a profile whose Stripe Customer no longer exists in the configured account. The
   * stored default payment method belongs to that missing Customer too, so it must never remain
   * selectable after the Customer id changes. The old values are only cleared after Stripe has
   * successfully created the replacement Customer.
   *
   * Matching the stale id makes concurrent repair attempts safe: one wins; a loser reads the
   * winner's current profile instead of overwriting it.
   */
  public async replaceStaleStripeCustomer(
    input: ReplaceStaleStripeCustomerInput,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOneAndUpdate(
      { userId: input.userId, stripeCustomerId: input.staleStripeCustomerId },
      {
        $set: { stripeCustomerId: input.replacementStripeCustomerId },
        $unset: {
          defaultPaymentMethodId: "",
          cardBrand: "",
          cardLast4: "",
          cardExpMonth: "",
          cardExpYear: "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  /** P2.2.5 — removes the saved card from Bookly only if it is still exactly this card (CAS), so
   * a concurrent new card is never cleared. Returns the profile as it was before, or null. */
  public async clearPaymentMethodIfCurrent(
    userId: Types.ObjectId | string,
    paymentMethodId: string,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOneAndUpdate(
      { userId, defaultPaymentMethodId: paymentMethodId },
      {
        $unset: {
          defaultPaymentMethodId: "",
          cardBrand: "",
          cardLast4: "",
          cardExpMonth: "",
          cardExpYear: "",
        },
      },
      { returnDocument: "before" },
    ).exec();
  }

  /** P2.2.5 — puts a card back after a removal that must not proceed, only if no other card was
   * saved meanwhile (CAS on "no default"). */
  public async restorePaymentMethodIfEmpty(
    userId: Types.ObjectId | string,
    previous: Pick<
      CustomerPaymentProfileDocument,
      "defaultPaymentMethodId" | "cardBrand" | "cardLast4" | "cardExpMonth" | "cardExpYear"
    >,
  ): Promise<void> {
    if (!previous.defaultPaymentMethodId) return;
    await CustomerPaymentProfileModel.updateOne(
      { userId, defaultPaymentMethodId: { $exists: false } },
      {
        $set: {
          defaultPaymentMethodId: previous.defaultPaymentMethodId,
          ...(previous.cardBrand ? { cardBrand: previous.cardBrand } : {}),
          ...(previous.cardLast4 ? { cardLast4: previous.cardLast4 } : {}),
          ...(previous.cardExpMonth ? { cardExpMonth: previous.cardExpMonth } : {}),
          ...(previous.cardExpYear ? { cardExpYear: previous.cardExpYear } : {}),
        },
      },
    ).exec();
  }

  public async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<CustomerPaymentProfileDocument | null> {
    return CustomerPaymentProfileModel.findOne({ stripeCustomerId }).exec();
  }

  /**
   * Account-closure cleanup — strip stored payment-instrument references (the payment-method id
   * and card display metadata) from this customer's profile. Deliberately keeps `userId` and
   * `stripeCustomerId`: the Stripe Customer is retained so historical charges/refunds stay
   * reconcilable (financial records are never deleted), and this feature adds no Stripe
   * API/gateway deletion call. Idempotent — a no-op when the row is absent or already stripped.
   */
  public async clearSensitiveReferencesForDeletion(userId: Types.ObjectId | string): Promise<void> {
    await CustomerPaymentProfileModel.updateOne(
      { userId },
      {
        $unset: {
          defaultPaymentMethodId: "",
          cardBrand: "",
          cardLast4: "",
          cardExpMonth: "",
          cardExpYear: "",
        },
      },
    ).exec();
  }
}
