import type { ClientSession, Types } from "mongoose";
import { PromoCodeModel } from "./promo.model.js";
import type { PromoFundingOwner, PromoType } from "./promo.types.js";
import { type PromoRedemptionDocument, PromoRedemptionModel } from "./promo-redemption.model.js";
import { PromoUserUsageModel } from "./promo-user-usage.model.js";

export type CreatePromoRedemptionInput = {
  promoId: Types.ObjectId;
  codeSnapshot: string;
  typeSnapshot: PromoType;
  valueSnapshot: number;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  promoEligibleBaseCents?: number | undefined;
  depositBeforePromoCents: number;
  promoDiscountCents: number;
  customerChargeNowCents: number;
  fundingOwner: PromoFundingOwner;
  isFirstBooking: boolean;
  userUsageCounted?: boolean | undefined;
};

export class PromoRedemptionRepository {
  public async restoreBusinessCancellation(
    input: {
      bookingId: Types.ObjectId;
      businessId: Types.ObjectId;
      customerUserId: Types.ObjectId;
      actorUserId: Types.ObjectId;
    },
    session: ClientSession,
  ): Promise<void> {
    const redemption = await PromoRedemptionModel.findOneAndUpdate(
      {
        bookingId: input.bookingId,
        businessId: input.businessId,
        customerUserId: input.customerUserId,
        usageRestoredAt: { $exists: false },
      },
      { $set: { usageRestoredAt: new Date(), usageRestoredByUserId: input.actorUserId } },
      { session, returnDocument: "after" },
    ).exec();
    if (!redemption) return;
    const global = await PromoCodeModel.updateOne(
      { _id: redemption.promoId, redeemedCount: { $gte: 1 } },
      { $inc: { redeemedCount: -1 } },
      { session },
    ).exec();
    let counted = redemption.userUsageCounted;
    if (counted === undefined) {
      const usage = await PromoUserUsageModel.findOne({
        promoId: redemption.promoId,
        customerUserId: redemption.customerUserId,
      }).session(session);
      if (!usage) counted = false;
      else {
        // Historical rows lack the cap snapshot. Only restore when all still-active possible
        // counter contributors are accounted for; mixed ambiguous history fails closed.
        const possible = await PromoRedemptionModel.countDocuments({
          promoId: redemption.promoId,
          customerUserId: redemption.customerUserId,
          usageRestoredAt: { $exists: false },
          userUsageCounted: { $ne: false },
        }).session(session);
        if (usage.count !== possible + 1)
          throw new Error("Historical promo counter attribution is ambiguous");
        counted = true;
      }
    }
    const user = counted
      ? await PromoUserUsageModel.updateOne(
          {
            promoId: redemption.promoId,
            customerUserId: redemption.customerUserId,
            count: { $gte: 1 },
          },
          { $inc: { count: -1 } },
          { session },
        ).exec()
      : undefined;
    if (global.modifiedCount !== 1 || (counted && user?.modifiedCount !== 1)) {
      throw new Error("Promo usage restoration requires consistent positive counters");
    }
  }

  public async create(
    input: CreatePromoRedemptionInput,
    session: ClientSession,
  ): Promise<PromoRedemptionDocument> {
    const [document] = await PromoRedemptionModel.create([{ ...input, redeemedAt: new Date() }], {
      session,
    });
    if (!document) {
      throw new Error("PromoRedemption insert returned no document");
    }
    return document;
  }

  public async findByBookingId(
    bookingId: Types.ObjectId | string,
  ): Promise<PromoRedemptionDocument | null> {
    return PromoRedemptionModel.findOne({ bookingId }).exec();
  }

  /** Batch 13 — Super Admin usage log: newest-first, bounded, one promo at a time. */
  public async listByPromoId(
    promoId: Types.ObjectId | string,
    pagination: { page: number; limit: number },
  ): Promise<{ redemptions: PromoRedemptionDocument[]; total: number }> {
    const filter = { promoId };
    const skip = (pagination.page - 1) * pagination.limit;
    const [redemptions, total] = await Promise.all([
      PromoRedemptionModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      PromoRedemptionModel.countDocuments(filter).exec(),
    ]);
    return { redemptions, total };
  }

  /** Batch 13 — Super Admin Finance "Discounted money" card: one reduced sum of every
   * Bookly-funded promo discount actually applied within a period, never a raw dump. Bounded by
   * `redeemedAt` (when the discount actually happened), matching every other period-bounded
   * Finance read in this codebase. P2 — Business-funded redemptions are not Bookly's cost, so
   * only BOOKLY-funded (legacy) rows count toward this Bookly-funded figure. */
  public async sumDiscountInRange(
    from: Date,
    to: Date,
  ): Promise<{ totalCents: number; count: number }> {
    const result = await PromoRedemptionModel.aggregate<{ totalCents: number; count: number }>([
      { $match: { redeemedAt: { $gte: from, $lt: to }, fundingOwner: "BOOKLY" } },
      {
        $group: {
          _id: null,
          totalCents: { $sum: "$promoDiscountCents" },
          count: { $sum: 1 },
        },
      },
    ]).exec();
    return { totalCents: result[0]?.totalCents ?? 0, count: result[0]?.count ?? 0 };
  }

  public async countByPromoId(promoId: Types.ObjectId | string): Promise<number> {
    return PromoRedemptionModel.countDocuments({ promoId }).exec();
  }
}
