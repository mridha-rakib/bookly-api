import type { Types } from "mongoose";

import {
  type StaffScheduleDayDocument,
  type StaffScheduleDocument,
  StaffScheduleModel,
} from "./staff-schedule.model.js";
import type { DayOfWeek } from "./staff-schedule.types.js";

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

  /**
   * Replaces the whole week in one upsert — this is what enforces "one shift per day", and
   * now also carries the explicit Weekend/Off days for the same week in the same atomic
   * write, so a save never leaves stale `offDays` behind after `days` changes (or vice versa).
   */
  public async replace(
    membershipId: Types.ObjectId,
    businessId: Types.ObjectId,
    days: StaffScheduleDayDocument[],
    // Defaults to [] so every existing caller (test seed helpers included) that only ever
    // replaced working `days` keeps compiling and behaving exactly as before.
    offDays: DayOfWeek[] = [],
  ): Promise<StaffScheduleDocument> {
    return StaffScheduleModel.findOneAndUpdate(
      { membershipId },
      { $set: { businessId, days, offDays } },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<StaffScheduleDocument>;
  }

  public async deleteByMembershipId(membershipId: Types.ObjectId | string): Promise<void> {
    await StaffScheduleModel.deleteOne({ membershipId }).exec();
  }
}
