import type { ClientSession, Types } from "mongoose";
import type { PromoFundingOwner, PromoType } from "./promo.types.js";
import { type PromoRedemptionDocument, PromoRedemptionModel } from "./promo-redemption.model.js";

export type CreatePromoRedemptionInput = {
  promoId: Types.ObjectId;
  codeSnapshot: string;
  typeSnapshot: PromoType;
  valueSnapshot: number;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  depositBeforePromoCents: number;
  promoDiscountCents: number;
  customerChargeNowCents: number;
  fundingOwner: PromoFundingOwner;
  isFirstBooking: boolean;
};

export class PromoRedemptionRepository {
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
   * Finance read in this codebase. */
  public async sumDiscountInRange(
    from: Date,
    to: Date,
  ): Promise<{ totalCents: number; count: number }> {
    const result = await PromoRedemptionModel.aggregate<{ totalCents: number; count: number }>([
      { $match: { redeemedAt: { $gte: from, $lt: to } } },
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
