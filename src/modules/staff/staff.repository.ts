import type { ClientSession, Types } from "mongoose";

import { type StaffMembershipDocument, StaffMembershipModel } from "./staff.model.js";
import type { StaffCreatableRole } from "./staff.types.js";

export type CreateStaffMembershipInput = {
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  role: StaffCreatableRole;
  createdByUserId: Types.ObjectId;
};

export class StaffRepository {
  public async create(
    input: CreateStaffMembershipInput,
    session?: ClientSession,
  ): Promise<StaffMembershipDocument> {
    return new StaffMembershipModel({ ...input, employmentActive: true }).save(
      session ? { session } : undefined,
    );
  }

  /** Active (not soft-removed) memberships for a business, newest first. */
  public async listActiveByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<StaffMembershipDocument[]> {
    return StaffMembershipModel.find({ businessId, removedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();
  }

  public async findActiveById(
    businessId: Types.ObjectId | string,
    staffId: Types.ObjectId | string,
  ): Promise<StaffMembershipDocument | null> {
    return StaffMembershipModel.findOne({
      _id: staffId,
      businessId,
      removedAt: { $exists: false },
    }).exec();
  }

  /**
   * Written as `removedAt: null` (MongoDB equality, matching both an absent field and an
   * explicit null) rather than `{$exists: false}` — the partial-unique index on `{userId: 1}`
   * (staff.model.ts) has filter expression `{removedAt: {$eq: null}}`, and MongoDB's query
   * planner only considers a partial index when the query predicate is provably a superset of
   * its filter expression. `{$exists: false}` does not satisfy that even though it happens to
   * return the same rows today (removedAt is never explicitly set to null — see the model's
   * own comment) — so this exact query shape is what lets this hot lookup actually use the
   * index instead of a full collection scan. Verified via `.explain()` in the integration
   * test (staff-database.integration.test.ts).
   */
  public async findActiveByUserId(
    userId: Types.ObjectId | string,
  ): Promise<StaffMembershipDocument | null> {
    return StaffMembershipModel.findOne({ userId, removedAt: null }).exec();
  }

  /**
   * Batched membership lookup scoped to one business — used by Services to resolve
   * assignedStaffMembershipIds for display without a query per Service. Does not filter by
   * removedAt: a Service may still reference a since-removed membership (display can show it
   * as inactive rather than silently vanishing).
   */
  public async findManyByIdsForBusiness(
    businessId: Types.ObjectId | string,
    staffIds: Array<Types.ObjectId | string>,
  ): Promise<StaffMembershipDocument[]> {
    if (staffIds.length === 0) {
      return [];
    }

    return StaffMembershipModel.find({ _id: { $in: staffIds }, businessId }).exec();
  }

  public async updateActiveById(
    businessId: Types.ObjectId | string,
    staffId: Types.ObjectId | string,
    update: Partial<Pick<StaffMembershipDocument, "role" | "employmentActive">>,
    session?: ClientSession,
  ): Promise<StaffMembershipDocument | null> {
    return StaffMembershipModel.findOneAndUpdate(
      { _id: staffId, businessId, removedAt: { $exists: false } },
      { $set: update },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  public async softRemoveById(
    businessId: Types.ObjectId | string,
    staffId: Types.ObjectId | string,
  ): Promise<StaffMembershipDocument | null> {
    return StaffMembershipModel.findOneAndUpdate(
      { _id: staffId, businessId, removedAt: { $exists: false } },
      { $set: { removedAt: new Date(), employmentActive: false } },
      { returnDocument: "after" },
    ).exec();
  }
}
