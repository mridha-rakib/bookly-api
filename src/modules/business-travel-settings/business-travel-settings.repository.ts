import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";

import type {
  BusinessTravelCitySetting,
  BusinessTravelSettingsDocument,
} from "./business-travel-settings.model.js";
import { BusinessTravelSettingsModel } from "./business-travel-settings.model.js";

export class BusinessTravelSettingsRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessTravelSettingsDocument | null> {
    return BusinessTravelSettingsModel.findOne({ businessId })
      .session(session ?? null)
      .exec();
  }

  public async upsertByBusinessId(
    businessId: Types.ObjectId | string,
    cities: BusinessTravelCitySetting[],
    session?: ClientSession,
  ): Promise<BusinessTravelSettingsDocument> {
    return withPackageEligibility(businessId, session, async (transaction) => {
      return BusinessTravelSettingsModel.findOneAndUpdate(
        { businessId },
        { $set: { cities } },
        {
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          session: transaction,
          upsert: true,
        },
      ).orFail();
    });
  }
}
