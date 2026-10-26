import type { ClientSession, Types } from "mongoose";

import {
  type BusinessBookingSettingsDocument,
  BusinessBookingSettingsModel,
} from "./business-booking-settings.model.js";

export class BusinessBookingSettingsRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessBookingSettingsDocument | null> {
    const query = BusinessBookingSettingsModel.findOne({ businessId });
    if (session) query.session(session);
    return query.exec();
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
