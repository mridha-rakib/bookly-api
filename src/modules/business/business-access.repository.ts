import type { ClientSession, Types } from "mongoose";

import { type BusinessAccessDocument, BusinessAccessModel } from "./business-access.model.js";

export type CreateBusinessAccessInput = {
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
};

export class BusinessAccessRepository {
  public async create(
    input: CreateBusinessAccessInput,
    session?: ClientSession,
  ): Promise<BusinessAccessDocument> {
    return new BusinessAccessModel(input).save(session ? { session } : undefined);
  }

  public async findByUserAndBusiness(
    userId: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
  ): Promise<BusinessAccessDocument | null> {
    return BusinessAccessModel.findOne({ userId, businessId }).exec();
  }

  public async listByUserId(userId: Types.ObjectId | string): Promise<BusinessAccessDocument[]> {
    return BusinessAccessModel.find({ userId }, { businessId: 1 }).exec();
  }

  public async deleteByUserAndBusiness(
    userId: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
  ): Promise<boolean> {
    const result = await BusinessAccessModel.deleteOne({ userId, businessId }).exec();
    return result.deletedCount > 0;
  }
}
