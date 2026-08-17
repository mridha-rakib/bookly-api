import { type ClientSession, Types } from "mongoose";
import { type ServiceDocument, ServiceModel } from "./service.model.js";
import type { ServiceStatus } from "./service.types.js";

export type CreateServiceInput = Omit<
  ServiceDocument,
  "_id" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type ReplaceServiceFields = Omit<
  ServiceDocument,
  "_id" | "businessId" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type ServiceListFilter = {
  status?: ServiceStatus | undefined;
  /** When true, restricts the list to ARCHIVED rows regardless of `status`. */
  archivedOnly?: boolean | undefined;
};

export type ServiceStatusCounts = {
  draft: number;
  active: number;
  inactive: number;
  archived: number;
};

export class ServiceRepository {
  public async create(
    input: CreateServiceInput,
    session?: ClientSession,
  ): Promise<ServiceDocument> {
    return new ServiceModel(input).save(session ? { session } : undefined);
  }

  public async findById(
    businessId: Types.ObjectId | string,
    serviceId: Types.ObjectId | string,
  ): Promise<ServiceDocument | null> {
    return ServiceModel.findOne({ _id: serviceId, businessId }).exec();
  }

  /** Batched lookup for Add-on service-assignment validation — never one query per id. */
  public async findManyByIdsForBusiness(
    businessId: Types.ObjectId | string,
    serviceIds: Array<Types.ObjectId | string>,
  ): Promise<ServiceDocument[]> {
    if (serviceIds.length === 0) {
      return [];
    }

    return ServiceModel.find({ _id: { $in: serviceIds }, businessId }).exec();
  }

  public async listByBusinessId(
    businessId: Types.ObjectId | string,
    filter: ServiceListFilter,
  ): Promise<ServiceDocument[]> {
    const query: Record<string, unknown> = { businessId };

    if (filter.archivedOnly) {
      query["status"] = "ARCHIVED";
    } else {
      query["status"] = filter.status ?? { $ne: "ARCHIVED" };
    }

    return ServiceModel.find(query).sort({ createdAt: -1 }).exec();
  }

  /** Single grouped query — never one count query per status. */
  public async countByStatus(businessId: Types.ObjectId | string): Promise<ServiceStatusCounts> {
    const businessObjectId =
      typeof businessId === "string" ? new Types.ObjectId(businessId) : businessId;

    const rows = await ServiceModel.aggregate<{ _id: ServiceStatus; count: number }>([
      { $match: { businessId: businessObjectId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();

    const counts: ServiceStatusCounts = { draft: 0, active: 0, inactive: 0, archived: 0 };
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
    serviceId: Types.ObjectId | string,
    fields: ReplaceServiceFields,
  ): Promise<ServiceDocument | null> {
    const setFields = this.stripUndefined(fields);

    // A field may not appear in both $set and $unset in one MongoDB update — so only the
    // discriminated keys the validated input did NOT populate get unset. This is what
    // guarantees a pricing-mode switch never leaves a stale sibling block behind (e.g.
    // switching HOURLY -> FIXED drops hourlyPricing) without conflicting with the $set of
    // whichever block the new mode did populate.
    const discriminatedKeys = [
      "pricingMode",
      "fixedPricing",
      "hourlyPricing",
      "perPersonPricing",
      "packagePricing",
      "packageServicesName",
      "description",
      // Optional since DRAFT Services may not have a category/subcategory chosen yet —
      // absent here must clear a previously-set value, not silently keep the old one.
      "serviceCategoryId",
      "subcategory",
    ] as const;

    const unset: Record<string, ""> = {};
    for (const key of discriminatedKeys) {
      if (!(key in setFields)) {
        unset[key] = "";
      }
    }

    const update: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unset).length > 0) {
      update["$unset"] = unset;
    }

    return ServiceModel.findOneAndUpdate({ _id: serviceId, businessId }, update, {
      returnDocument: "after",
      runValidators: true,
    }).exec();
  }

  /**
   * The quick ACTIVE/INACTIVE toggle — deliberately only matches Services that are already
   * ACTIVE or INACTIVE. A DRAFT can only reach ACTIVE/INACTIVE via the full validated
   * create/update path (replaceById), never this shortcut, since a draft may hold data that
   * wouldn't pass full publish validation.
   */
  public async updateStatusById(
    businessId: Types.ObjectId | string,
    serviceId: Types.ObjectId | string,
    status: Extract<ServiceStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<ServiceDocument | null> {
    return ServiceModel.findOneAndUpdate(
      { _id: serviceId, businessId, status: { $in: ["ACTIVE", "INACTIVE"] } },
      { $set: { status } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async archiveById(
    businessId: Types.ObjectId | string,
    serviceId: Types.ObjectId | string,
  ): Promise<ServiceDocument | null> {
    return ServiceModel.findOneAndUpdate(
      { _id: serviceId, businessId, status: { $ne: "ARCHIVED" } },
      { $set: { status: "ARCHIVED", archivedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async restoreById(
    businessId: Types.ObjectId | string,
    serviceId: Types.ObjectId | string,
    status: Extract<ServiceStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<ServiceDocument | null> {
    return ServiceModel.findOneAndUpdate(
      { _id: serviceId, businessId, status: "ARCHIVED" },
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
