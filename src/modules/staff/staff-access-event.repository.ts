import type { ClientSession, Types } from "mongoose";
import type { StaffCreatableRole } from "./staff.types.js";
import {
  type StaffAccessEventDocument,
  StaffAccessEventModel,
  type StaffAccessEventType,
} from "./staff-access-event.model.js";

export type CreateStaffAccessEventInput = {
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId | string;
  staffUserId: Types.ObjectId;
  type: StaffAccessEventType;
  changedByUserId: Types.ObjectId;
  previousRole?: StaffCreatableRole | undefined;
  newRole?: StaffCreatableRole | undefined;
  previousEmploymentActive?: boolean | undefined;
  newEmploymentActive?: boolean | undefined;
};

export class StaffAccessEventRepository {
  /** Insert one audit event. Pass the caller's `session` to make it part of the SAME
   * transaction as the role/employment write it records — never a second transaction. */
  public async create(
    input: CreateStaffAccessEventInput,
    session?: ClientSession,
  ): Promise<StaffAccessEventDocument> {
    return new StaffAccessEventModel(input).save(session ? { session } : undefined);
  }

  /** One membership's access-change history, newest first. */
  public async listByMembershipId(
    staffMembershipId: Types.ObjectId | string,
  ): Promise<StaffAccessEventDocument[]> {
    return StaffAccessEventModel.find({ staffMembershipId }).sort({ createdAt: -1 }).exec();
  }
}
