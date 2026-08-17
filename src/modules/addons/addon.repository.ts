import { Types } from "mongoose";

import { type AddonDocument, AddonModel } from "./addon.model.js";
import type { AddonStatus } from "./addon.types.js";

export type CreateAddonInput = Omit<
  AddonDocument,
  "_id" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type ReplaceAddonFields = Omit<
  AddonDocument,
  "_id" | "businessId" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type AddonListFilter = {
  status?: AddonStatus | undefined;
  /** When true, restricts the list to ARCHIVED rows regardless of `status`. */
  archivedOnly?: boolean | undefined;
};

export type AddonStatusCounts = {
  draft: number;
  active: number;
  inactive: number;
  archived: number;
};

export class AddonRepository {
  public async create(input: CreateAddonInput): Promise<AddonDocument> {
    return new AddonModel(input).save();
  }

  public async findById(
    businessId: Types.ObjectId | string,
    addonId: Types.ObjectId | string,
  ): Promise<AddonDocument | null> {
    return AddonModel.findOne({ _id: addonId, businessId }).exec();
  }

  /** Batched lookup for Service-Edit's "Assigned Add-ons" display — never one query per id. */
  public async findManyByIdsForBusiness(
    businessId: Types.ObjectId | string,
    addonIds: Array<Types.ObjectId | string>,
  ): Promise<AddonDocument[]> {
    if (addonIds.length === 0) {
      return [];
    }

    return AddonModel.find({ _id: { $in: addonIds }, businessId }).exec();
  }

  public async listByBusinessId(
    businessId: Types.ObjectId | string,
    filter: AddonListFilter,
  ): Promise<AddonDocument[]> {
    const query: Record<string, unknown> = { businessId };

    if (filter.archivedOnly) {
      query["status"] = "ARCHIVED";
    } else {
      query["status"] = filter.status ?? { $ne: "ARCHIVED" };
    }

    return AddonModel.find(query).sort({ createdAt: -1 }).exec();
  }

  /** Single grouped query — never one count query per status. */
  public async countByStatus(businessId: Types.ObjectId | string): Promise<AddonStatusCounts> {
    const businessObjectId =
      typeof businessId === "string" ? new Types.ObjectId(businessId) : businessId;

    const rows = await AddonModel.aggregate<{ _id: AddonStatus; count: number }>([
      { $match: { businessId: businessObjectId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();

    const counts: AddonStatusCounts = { draft: 0, active: 0, inactive: 0, archived: 0 };
    for (const row of rows) {
      if (row._id === "DRAFT") counts.draft = row.count;
      else if (row._id === "ACTIVE") counts.active = row.count;
      else if (row._id === "INACTIVE") counts.inactive = row.count;
      else if (row._id === "ARCHIVED") counts.archived = row.count;
    }
    return counts;
  }

  public async replaceById(
    businessId: Types.ObjectId | string,
    addonId: Types.ObjectId | string,
    fields: ReplaceAddonFields,
  ): Promise<AddonDocument | null> {
    const setFields = this.stripUndefined(fields);

    // A field may not appear in both $set and $unset in one MongoDB update — only the keys
    // the validated input did NOT populate get unset, so a field cleared by the client (e.g.
    // a DRAFT losing its category) is actually cleared rather than left stale.
    const clearableKeys = ["description", "priceCents", "customServiceCategoryId"] as const;

    const unset: Record<string, ""> = {};
    for (const key of clearableKeys) {
      if (!(key in setFields)) {
        unset[key] = "";
      }
    }

    const update: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unset).length > 0) {
      update["$unset"] = unset;
    }

    return AddonModel.findOneAndUpdate({ _id: addonId, businessId }, update, {
      returnDocument: "after",
      runValidators: true,
    }).exec();
  }

  /**
   * The quick ACTIVE/INACTIVE toggle — deliberately only matches Add-ons that are already
   * ACTIVE or INACTIVE. A DRAFT can only reach ACTIVE/INACTIVE via the full validated
   * create/update path (replaceById), never this shortcut.
   */
  public async updateStatusById(
    businessId: Types.ObjectId | string,
    addonId: Types.ObjectId | string,
    status: Extract<AddonStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<AddonDocument | null> {
    return AddonModel.findOneAndUpdate(
      { _id: addonId, businessId, status: { $in: ["ACTIVE", "INACTIVE"] } },
      { $set: { status } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async archiveById(
    businessId: Types.ObjectId | string,
    addonId: Types.ObjectId | string,
  ): Promise<AddonDocument | null> {
    return AddonModel.findOneAndUpdate(
      { _id: addonId, businessId, status: { $ne: "ARCHIVED" } },
      { $set: { status: "ARCHIVED", archivedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async restoreById(
    businessId: Types.ObjectId | string,
    addonId: Types.ObjectId | string,
    status: Extract<AddonStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<AddonDocument | null> {
    return AddonModel.findOneAndUpdate(
      { _id: addonId, businessId, status: "ARCHIVED" },
      { $set: { status }, $unset: { archivedAt: "" } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  private stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
    const result: Partial<T> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        (result as Record<string, unknown>)[key] = val;
      }
    }
    return result;
  }
}
