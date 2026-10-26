import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";

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
    session?: ClientSession,
  ): Promise<BusinessCancellationPolicyDocument> {
    return withPackageEligibility(businessId, session, async (transaction) =>
      BusinessCancellationPolicyModel.findOneAndUpdate(
        { businessId },
        { $set: { tiers, noShowPercentage } },
        { upsert: true, returnDocument: "after", runValidators: true, session: transaction },
      )
        .orFail()
        .exec(),
    );
  }
}
