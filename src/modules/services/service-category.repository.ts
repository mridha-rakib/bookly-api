import type { Types } from "mongoose";

import { type ServiceCategoryDocument, ServiceCategoryModel } from "./service-category.model.js";

export type CreateServiceCategoryInput = {
  businessId: Types.ObjectId;
  name: string;
  nameKey: string;
};

export class ServiceCategoryRepository {
  public async create(input: CreateServiceCategoryInput): Promise<ServiceCategoryDocument> {
    return new ServiceCategoryModel({ ...input, active: true }).save();
  }

  public async listByBusinessId(
    businessId: Types.ObjectId | string,
    options: { includeInactive: boolean },
  ): Promise<ServiceCategoryDocument[]> {
    const filter: Record<string, unknown> = { businessId };

    if (!options.includeInactive) {
      filter["active"] = true;
    }

    return ServiceCategoryModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  public async findById(
    businessId: Types.ObjectId | string,
    categoryId: Types.ObjectId | string,
  ): Promise<ServiceCategoryDocument | null> {
    return ServiceCategoryModel.findOne({ _id: categoryId, businessId }).exec();
  }

  public async findActiveById(
    businessId: Types.ObjectId | string,
    categoryId: Types.ObjectId | string,
  ): Promise<ServiceCategoryDocument | null> {
    return ServiceCategoryModel.findOne({ _id: categoryId, businessId, active: true }).exec();
  }

  public async findByNameKey(
    businessId: Types.ObjectId | string,
    nameKey: string,
  ): Promise<ServiceCategoryDocument | null> {
    return ServiceCategoryModel.findOne({ businessId, nameKey }).exec();
  }

  public async updateById(
    businessId: Types.ObjectId | string,
    categoryId: Types.ObjectId | string,
    update: Partial<Pick<ServiceCategoryDocument, "name" | "nameKey" | "active">>,
  ): Promise<ServiceCategoryDocument | null> {
    return ServiceCategoryModel.findOneAndUpdate(
      { _id: categoryId, businessId },
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }
}
