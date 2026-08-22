import type { Types } from "mongoose";

import {
  type BusinessCancellationPolicyDocument,
  BusinessCancellationPolicyModel,
  type CancellationTierRule,
} from "./business-cancellation-policy.model.js";

export class BusinessCancellationPolicyRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<BusinessCancellationPolicyDocument | null> {
    return BusinessCancellationPolicyModel.findOne({ businessId }).exec();
  }

  /** Replaces the whole policy in one upsert — mirrors BusinessOpeningHours.replace. */
  public async replace(
    businessId: Types.ObjectId,
    tiers: CancellationTierRule[],
    noShowPercentage: number,
  ): Promise<BusinessCancellationPolicyDocument> {
    return BusinessCancellationPolicyModel.findOneAndUpdate(
      { businessId },
      { $set: { tiers, noShowPercentage } },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<BusinessCancellationPolicyDocument>;
  }
}
