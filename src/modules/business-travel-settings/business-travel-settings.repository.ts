import type { Types } from "mongoose";

import type {
  BusinessTravelCitySetting,
  BusinessTravelSettingsDocument,
} from "./business-travel-settings.model.js";
import { BusinessTravelSettingsModel } from "./business-travel-settings.model.js";

export class BusinessTravelSettingsRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<BusinessTravelSettingsDocument | null> {
    return BusinessTravelSettingsModel.findOne({ businessId }).exec();
  }

  public async upsertByBusinessId(
    businessId: Types.ObjectId | string,
    cities: BusinessTravelCitySetting[],
  ): Promise<BusinessTravelSettingsDocument> {
    return BusinessTravelSettingsModel.findOneAndUpdate(
      { businessId },
      { $set: { cities } },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      },
    ).orFail();
  }
}
