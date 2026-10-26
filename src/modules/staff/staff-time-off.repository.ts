import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";
import { StaffError } from "./staff.errors.js";
import { StaffMembershipModel } from "./staff.model.js";

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
  public async create(
    input: CreateStaffTimeOffInput,
    session?: ClientSession,
  ): Promise<StaffTimeOffDocument> {
    return withPackageEligibility(input.businessId, session, async (transaction) => {
      const member = await StaffMembershipModel.findOne({
        _id: input.membershipId,
        businessId: input.businessId,
        removedAt: { $exists: false },
      }).session(transaction);
      if (!member) throw new StaffError("STAFF_NOT_FOUND", 404);
      const overlapping = await StaffTimeOffModel.exists({
        membershipId: input.membershipId,
        startDate: { $lte: input.endDate },
        endDate: { $gte: input.startDate },
      }).session(transaction);
      if (overlapping) throw new StaffError("STAFF_TIME_OFF_OVERLAP", 409);
      return new StaffTimeOffModel(input).save({ session: transaction });
    });
  }

  public async listByMembershipId(
    membershipId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<StaffTimeOffDocument[]> {
    return StaffTimeOffModel.find({ membershipId })
      .sort({ startDate: 1 })
      .session(session ?? null)
      .exec();
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

  /**
   * The Availability Engine's own read: only time-off entries that could possibly overlap the
   * requested (already-bounded) date range — never a staff member's entire leave history,
   * which could span years for a long-tenured member. `startDate <= toDateStr AND endDate >=
   * fromDateStr` is the standard inclusive-range-overlap predicate for the "YYYY-MM-DD" string
   * dates this collection already uses (see staff-time-off.model.ts — they sort/compare
   * correctly as plain strings).
   */
  public async findManyByMembershipIdsOverlappingRange(
    membershipIds: Array<Types.ObjectId | string>,
    fromDateStr: string,
    toDateStr: string,
    session?: ClientSession,
  ): Promise<StaffTimeOffDocument[]> {
    if (membershipIds.length === 0) {
      return [];
    }

    return StaffTimeOffModel.find({
      membershipId: { $in: membershipIds },
      startDate: { $lte: toDateStr },
      endDate: { $gte: fromDateStr },
    })
      .session(session ?? null)
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
    session?: ClientSession,
  ): Promise<boolean> {
    const member = await StaffMembershipModel.findById(membershipId).session(session ?? null);
    if (!member) throw new StaffError("STAFF_NOT_FOUND", 404);
    return withPackageEligibility(member.businessId, session, async (transaction) => {
      const result = await StaffTimeOffModel.deleteOne({
        _id: timeOffId,
        membershipId,
        businessId: member.businessId,
      }).session(transaction);
      return result.deletedCount > 0;
    });
  }

  public async deleteByMembershipId(
    membershipId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<void> {
    const member = await StaffMembershipModel.findById(membershipId).session(session ?? null);
    if (!member) throw new StaffError("STAFF_NOT_FOUND", 404);
    await withPackageEligibility(member.businessId, session, async (transaction) => {
      await StaffTimeOffModel.deleteMany({ membershipId, businessId: member.businessId }).session(
        transaction,
      );
    });
  }
}
