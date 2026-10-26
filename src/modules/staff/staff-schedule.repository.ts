import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";
import { StaffError } from "./staff.errors.js";
import { StaffMembershipModel } from "./staff.model.js";

import {
  type StaffScheduleDayDocument,
  type StaffScheduleDocument,
  StaffScheduleModel,
} from "./staff-schedule.model.js";
import type { DayOfWeek } from "./staff-schedule.types.js";

export class StaffScheduleRepository {
  public async findByMembershipId(
    membershipId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<StaffScheduleDocument | null> {
    return StaffScheduleModel.findOne({ membershipId })
      .session(session ?? null)
      .exec();
  }

  /** Batched lookup for the Staff list / Availability table — one query, never per-row. */
  public async findManyByMembershipIds(
    membershipIds: Array<Types.ObjectId | string>,
    session?: ClientSession,
  ): Promise<StaffScheduleDocument[]> {
    if (membershipIds.length === 0) {
      return [];
    }

    return StaffScheduleModel.find({ membershipId: { $in: membershipIds } })
      .session(session ?? null)
      .exec();
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
    session?: ClientSession,
  ): Promise<StaffScheduleDocument> {
    return withPackageEligibility(businessId, session, async (transaction) => {
      const member = await StaffMembershipModel.findOne({
        _id: membershipId,
        businessId,
        removedAt: { $exists: false },
      }).session(transaction);
      if (!member) throw new StaffError("STAFF_NOT_FOUND", 404);
      return StaffScheduleModel.findOneAndUpdate(
        { membershipId },
        { $set: { businessId, days, offDays } },
        { session: transaction, upsert: true, returnDocument: "after", runValidators: true },
      ).exec() as Promise<StaffScheduleDocument>;
    });
  }

  public async deleteByMembershipId(
    membershipId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<void> {
    const member = await StaffMembershipModel.findById(membershipId).session(session ?? null);
    if (!member) throw new StaffError("STAFF_NOT_FOUND", 404);
    await withPackageEligibility(member.businessId, session, async (transaction) => {
      await StaffScheduleModel.deleteOne({ membershipId, businessId: member.businessId }).session(
        transaction,
      );
    });
  }
}
