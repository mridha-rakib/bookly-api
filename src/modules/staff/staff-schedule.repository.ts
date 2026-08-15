import type { Types } from "mongoose";

import {
  type StaffScheduleDayDocument,
  type StaffScheduleDocument,
  StaffScheduleModel,
} from "./staff-schedule.model.js";

export class StaffScheduleRepository {
  public async findByMembershipId(
    membershipId: Types.ObjectId | string,
  ): Promise<StaffScheduleDocument | null> {
    return StaffScheduleModel.findOne({ membershipId }).exec();
  }

  /** Batched lookup for the Staff list / Availability table — one query, never per-row. */
  public async findManyByMembershipIds(
    membershipIds: Array<Types.ObjectId | string>,
  ): Promise<StaffScheduleDocument[]> {
    if (membershipIds.length === 0) {
      return [];
    }

    return StaffScheduleModel.find({ membershipId: { $in: membershipIds } }).exec();
  }

  /** Replaces the whole week in one upsert — this is what enforces "one shift per day". */
  public async replace(
    membershipId: Types.ObjectId,
    businessId: Types.ObjectId,
    days: StaffScheduleDayDocument[],
  ): Promise<StaffScheduleDocument> {
    return StaffScheduleModel.findOneAndUpdate(
      { membershipId },
      { $set: { businessId, days } },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<StaffScheduleDocument>;
  }

  public async deleteByMembershipId(membershipId: Types.ObjectId | string): Promise<void> {
    await StaffScheduleModel.deleteOne({ membershipId }).exec();
  }
}
