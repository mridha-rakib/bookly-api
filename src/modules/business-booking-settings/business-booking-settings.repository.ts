import type { Types } from "mongoose";

import {
  type BusinessBookingSettingsDocument,
  BusinessBookingSettingsModel,
} from "./business-booking-settings.model.js";

export class BusinessBookingSettingsRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<BusinessBookingSettingsDocument | null> {
    return BusinessBookingSettingsModel.findOne({ businessId }).exec();
  }

  public async upsertByBusinessId(
    businessId: Types.ObjectId | string,
    gapEliminationEnabled: boolean,
  ): Promise<BusinessBookingSettingsDocument> {
    return BusinessBookingSettingsModel.findOneAndUpdate(
      { businessId },
      { $set: { gapEliminationEnabled } },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      },
    ).orFail();
  }
}
