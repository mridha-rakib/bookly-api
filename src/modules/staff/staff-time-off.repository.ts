import type { Types } from "mongoose";

import { type StaffTimeOffDocument, StaffTimeOffModel } from "./staff-time-off.model.js";
import type { StaffTimeOffType } from "./staff-time-off.types.js";

export type CreateStaffTimeOffInput = {
  membershipId: Types.ObjectId;
  businessId: Types.ObjectId;
  type: StaffTimeOffType;
  startDate: string;
  endDate: string;
  createdByUserId: Types.ObjectId;
};

export class StaffTimeOffRepository {
  public async create(input: CreateStaffTimeOffInput): Promise<StaffTimeOffDocument> {
    return new StaffTimeOffModel(input).save();
  }

  public async listByMembershipId(
    membershipId: Types.ObjectId | string,
  ): Promise<StaffTimeOffDocument[]> {
    return StaffTimeOffModel.find({ membershipId }).sort({ startDate: 1 }).exec();
  }

  /** Batched lookup for the Staff list / Availability table — one query, never per-row. */
  public async findManyByMembershipIds(
    membershipIds: Array<Types.ObjectId | string>,
  ): Promise<StaffTimeOffDocument[]> {
    if (membershipIds.length === 0) {
      return [];
    }

    return StaffTimeOffModel.find({ membershipId: { $in: membershipIds } })
      .sort({ startDate: 1 })
      .exec();
  }

  public async findByIdForMembership(
    membershipId: Types.ObjectId | string,
    timeOffId: Types.ObjectId | string,
  ): Promise<StaffTimeOffDocument | null> {
    return StaffTimeOffModel.findOne({ _id: timeOffId, membershipId }).exec();
  }

  public async deleteByIdForMembership(
    membershipId: Types.ObjectId | string,
    timeOffId: Types.ObjectId | string,
  ): Promise<boolean> {
    const result = await StaffTimeOffModel.deleteOne({ _id: timeOffId, membershipId }).exec();
    return result.deletedCount > 0;
  }

  public async deleteByMembershipId(membershipId: Types.ObjectId | string): Promise<void> {
    await StaffTimeOffModel.deleteMany({ membershipId }).exec();
  }
}
