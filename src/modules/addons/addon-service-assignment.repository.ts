import type { Types } from "mongoose";

import {
  type AddonServiceAssignmentDocument,
  AddonServiceAssignmentModel,
} from "./addon-service-assignment.model.js";

export type CreateAddonServiceAssignmentInput = {
  businessId: Types.ObjectId;
  addonId: Types.ObjectId;
  serviceId: Types.ObjectId;
};

/**
 * Thin CRUD over the join collection — the diffing/validation rules (same-business, archived
 * Service handling, etc.) live in AddonService, not here, matching the repository/service
 * split used across the rest of this codebase.
 */
export class AddonServiceAssignmentRepository {
  /** Batched — the Add-ons list/detail summary never issues one query per Add-on. */
  public async findByAddonIds(
    addonIds: Array<Types.ObjectId | string>,
  ): Promise<AddonServiceAssignmentDocument[]> {
    if (addonIds.length === 0) {
      return [];
    }

    return AddonServiceAssignmentModel.find({ addonId: { $in: addonIds } }).exec();
  }

  /** Batched — Service Edit's "Assigned Add-ons" and any future multi-service view. */
  public async findByServiceIds(
    serviceIds: Array<Types.ObjectId | string>,
  ): Promise<AddonServiceAssignmentDocument[]> {
    if (serviceIds.length === 0) {
      return [];
    }

    return AddonServiceAssignmentModel.find({ serviceId: { $in: serviceIds } }).exec();
  }

  public async insertMany(assignments: CreateAddonServiceAssignmentInput[]): Promise<void> {
    if (assignments.length === 0) {
      return;
    }

    await AddonServiceAssignmentModel.insertMany(assignments, { ordered: false });
  }

  public async deleteByAddonAndServiceIds(
    addonId: Types.ObjectId | string,
    serviceIds: Array<Types.ObjectId | string>,
  ): Promise<void> {
    if (serviceIds.length === 0) {
      return;
    }

    await AddonServiceAssignmentModel.deleteMany({
      addonId,
      serviceId: { $in: serviceIds },
    }).exec();
  }
}
