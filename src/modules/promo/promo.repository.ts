import type { ClientSession, Types } from "mongoose";
import { type PromoCodeDocument, PromoCodeModel } from "./promo.model.js";
import type { PromoScope, PromoStatus, PromoType } from "./promo.types.js";

export type CreatePromoInput = {
  code: string;
  normalizedCode: string;
  type: PromoType;
  value: number;
  scope: PromoScope;
  businessIds: Types.ObjectId[];
  startAt?: Date | undefined;
  expiresAt: Date;
  totalUsageLimit?: number | undefined;
  perUserUsageLimit?: number | undefined;
  createdByUserId: Types.ObjectId;
};

export type UpdatePromoInput = Partial<
  Pick<
    PromoCodeDocument,
    | "code"
    | "normalizedCode"
    | "type"
    | "value"
    | "scope"
    | "businessIds"
    | "startAt"
    | "expiresAt"
    | "totalUsageLimit"
    | "perUserUsageLimit"
  >
>;

export class PromoRepository {
  public async create(input: CreatePromoInput): Promise<PromoCodeDocument> {
    return new PromoCodeModel({ ...input, status: "ACTIVE", redeemedCount: 0 }).save();
  }

  public async findById(promoId: Types.ObjectId | string): Promise<PromoCodeDocument | null> {
    return PromoCodeModel.findById(promoId).exec();
  }

  public async findByNormalizedCode(normalizedCode: string): Promise<PromoCodeDocument | null> {
    return PromoCodeModel.findOne({ normalizedCode }).exec();
  }

  public async update(
    promoId: Types.ObjectId | string,
    update: UpdatePromoInput,
  ): Promise<PromoCodeDocument | null> {
    return PromoCodeModel.findByIdAndUpdate(
      promoId,
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async setStatus(
    promoId: Types.ObjectId | string,
    status: PromoStatus,
  ): Promise<PromoCodeDocument | null> {
    return PromoCodeModel.findByIdAndUpdate(
      promoId,
      { $set: { status } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async delete(promoId: Types.ObjectId | string): Promise<void> {
    await PromoCodeModel.deleteOne({ _id: promoId }).exec();
  }

  public async list(
    filter: { status?: PromoStatus | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<{ promos: PromoCodeDocument[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.status) query["status"] = filter.status;
    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query["normalizedCode"] = new RegExp(escaped, "i");
    }

    const skip = (pagination.page - 1) * pagination.limit;
    const [promos, total] = await Promise.all([
      PromoCodeModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      PromoCodeModel.countDocuments(query).exec(),
    ]);
    return { promos, total };
  }

  /** The single global-usage-cap concurrency guard (rule #14: "must support global total cap" —
   * concurrency-safe, never read-then-write). `undefined` `totalUsageLimit` means unlimited: the
   * filter simply omits the `redeemedCount` bound, so every attempt succeeds. Returns `null` when
   * the cap has been reached (a real, expected outcome the caller maps to a clear error), never
   * throws for that case. */
  public async claimGlobalUsage(
    promoId: Types.ObjectId | string,
    totalUsageLimit: number | undefined,
    session: ClientSession,
  ): Promise<PromoCodeDocument | null> {
    return PromoCodeModel.findOneAndUpdate(
      {
        _id: promoId,
        ...(totalUsageLimit !== undefined ? { redeemedCount: { $lt: totalUsageLimit } } : {}),
      },
      { $inc: { redeemedCount: 1 } },
      { returnDocument: "after", session },
    ).exec();
  }
}
