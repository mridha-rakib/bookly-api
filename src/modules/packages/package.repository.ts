import type { Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";

import { type PackageDocument, PackageModel } from "./package.model.js";
import type { EditablePackageStatus } from "./package.types.js";

export type PackageFields = Omit<
  PackageDocument,
  "_id" | "businessId" | "revision" | "createdAt" | "updatedAt" | "archivedAt"
>;
export type PackageListFilter = {
  status?: EditablePackageStatus | undefined;
  archivedOnly?: boolean | undefined;
};

export class PackageRepository {
  public async create(businessId: Types.ObjectId, fields: PackageFields): Promise<PackageDocument> {
    return withPackageEligibility(businessId, undefined, (session) =>
      new PackageModel({ ...fields, businessId, revision: 1 }).save({ session }),
    );
  }
  public async findById(
    businessId: Types.ObjectId | string,
    packageId: string,
  ): Promise<PackageDocument | null> {
    return PackageModel.findOne({ _id: packageId, businessId }).exec();
  }
  public async list(
    businessId: Types.ObjectId,
    filter: PackageListFilter,
  ): Promise<PackageDocument[]> {
    return PackageModel.find({
      businessId,
      status: filter.archivedOnly ? "ARCHIVED" : (filter.status ?? { $ne: "ARCHIVED" }),
    })
      .sort({ createdAt: -1, _id: -1 })
      .exec();
  }
  /** Every mutation replaces the validated definition under one ownership + revision CAS. */
  public async replace(
    businessId: Types.ObjectId,
    packageId: string,
    expectedRevision: number,
    fields: PackageFields,
    archivedAt?: Date,
  ): Promise<PackageDocument | null> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) set[key] = value;
    for (const key of [
      "description",
      "subcategory",
      "serviceCategoryId",
      "bundlePriceCents",
      "contractTerms",
    ])
      if (!(key in set)) unset[key] = "";
    if (archivedAt) set["archivedAt"] = archivedAt;
    else unset["archivedAt"] = "";
    return withPackageEligibility(businessId, undefined, (session) =>
      PackageModel.findOneAndUpdate(
        { _id: packageId, businessId, revision: expectedRevision },
        { $set: set, $unset: unset, $inc: { revision: 1 } },
        { returnDocument: "after", runValidators: true, session },
      ).exec(),
    );
  }
}
