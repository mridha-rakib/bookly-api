import type { ClientSession, Types } from "mongoose";
import { PromoUserUsageModel } from "./promo-user-usage.model.js";

export class PromoUserUsageRepository {
  /** The per-customer usage-cap concurrency guard — see promo-user-usage.model.ts's own doc
   * comment for the two-step ensure-then-CAS-increment design. `undefined` `perUserUsageLimit`
   * means unlimited: skips the counter entirely (nothing to cap). Returns `false` when the
   * per-user cap has already been reached for this Promo+Customer, never throws for that case. */
  public async claim(
    promoId: Types.ObjectId,
    customerUserId: Types.ObjectId,
    perUserUsageLimit: number | undefined,
    session: ClientSession,
  ): Promise<boolean> {
    if (perUserUsageLimit === undefined) {
      return true;
    }

    try {
      await PromoUserUsageModel.updateOne(
        { promoId, customerUserId },
        { $setOnInsert: { promoId, customerUserId, count: 0 } },
        { upsert: true, session },
      ).exec();
    } catch (error) {
      // A concurrent claim already inserted the row first — safe, expected, matches
      // resolveOrCreateCustomerClient's own duplicate-key idiom (client.repository.ts).
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const claimed = await PromoUserUsageModel.findOneAndUpdate(
      { promoId, customerUserId, count: { $lt: perUserUsageLimit } },
      { $inc: { count: 1 } },
      { returnDocument: "after", session },
    ).exec();

    return claimed !== null;
  }

  public async countForCustomer(
    promoId: Types.ObjectId | string,
    customerUserId: Types.ObjectId | string,
  ): Promise<number> {
    const row = await PromoUserUsageModel.findOne({ promoId, customerUserId }).exec();
    return row?.count ?? 0;
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
