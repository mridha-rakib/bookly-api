import type { Types } from "mongoose";

import {
  type BusinessOpeningHoursDay,
  type BusinessOpeningHoursDocument,
  BusinessOpeningHoursModel,
} from "./business-hours.model.js";

export class BusinessHoursRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<BusinessOpeningHoursDocument | null> {
    return BusinessOpeningHoursModel.findOne({ businessId }).exec();
  }

  /** Replaces the whole week in one upsert — mirrors StaffSchedule's "whole-week replace". */
  public async replace(
    businessId: Types.ObjectId,
    days: BusinessOpeningHoursDay[],
  ): Promise<BusinessOpeningHoursDocument> {
    return BusinessOpeningHoursModel.findOneAndUpdate(
      { businessId },
      { $set: { days } },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<BusinessOpeningHoursDocument>;
  }
}
