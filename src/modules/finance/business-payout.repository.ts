import type { Types } from "mongoose";

import { type BusinessPayoutDocument, BusinessPayoutModel } from "./business-payout.model.js";

export type CreateBusinessPayoutInput = Omit<
  BusinessPayoutDocument,
  "_id" | "createdAt" | "updatedAt"
>;

/**
 * See business-payout.model.ts's own doc comment: `create` has no caller in production code yet
 * (no real payout-execution process exists in this codebase) — it exists so the schema is
 * exercised by tests and ready for a future payout-execution batch, matching this codebase's
 * existing "storage shape before the write path" precedent.
 */
export class BusinessPayoutRepository {
  public async create(input: CreateBusinessPayoutInput): Promise<BusinessPayoutDocument> {
    return new BusinessPayoutModel(input).save();
  }

  public async listByBusinessId(input: {
    businessId: Types.ObjectId | string;
    page: number;
    limit: number;
  }): Promise<{ items: BusinessPayoutDocument[]; total: number }> {
    const filter = { businessId: input.businessId };
    const skip = (input.page - 1) * input.limit;
    const [items, total] = await Promise.all([
      BusinessPayoutModel.find(filter)
        .sort({ periodStart: -1 })
        .skip(skip)
        .limit(input.limit)
        .exec(),
      BusinessPayoutModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
}
