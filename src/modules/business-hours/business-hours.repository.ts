import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";

import {
  type BusinessOpeningHoursDay,
  type BusinessOpeningHoursDocument,
  BusinessOpeningHoursModel,
} from "./business-hours.model.js";

export class BusinessHoursRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessOpeningHoursDocument | null> {
    return BusinessOpeningHoursModel.findOne({ businessId })
      .session(session ?? null)
      .exec();
  }

  /** Replaces the whole week in one upsert — mirrors StaffSchedule's "whole-week replace". */
  public async replace(
    businessId: Types.ObjectId,
    days: BusinessOpeningHoursDay[],
    session?: ClientSession,
  ): Promise<BusinessOpeningHoursDocument> {
    return withPackageEligibility(businessId, session, async (transaction) => {
      return BusinessOpeningHoursModel.findOneAndUpdate(
        { businessId },
        { $set: { days } },
        { session: transaction, upsert: true, returnDocument: "after", runValidators: true },
      ).exec() as Promise<BusinessOpeningHoursDocument>;
    });
  }
}
