import type { ClientSession, Types } from "mongoose";

import {
  type BusinessMediaDocument,
  BusinessMediaModel,
  type BusinessMediaRole,
} from "./business-media.model.js";

export type CreateBusinessMediaInput = {
  businessId: Types.ObjectId;
  storageKey: string;
  bucket: string;
  role: BusinessMediaRole;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  sortOrder: number;
  createdBy: Types.ObjectId;
};

export class BusinessMediaRepository {
  public async listByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<BusinessMediaDocument[]> {
    return BusinessMediaModel.find({ businessId }).sort({ sortOrder: 1, createdAt: 1 }).exec();
  }

  public async create(input: CreateBusinessMediaInput): Promise<BusinessMediaDocument> {
    return new BusinessMediaModel(input).save();
  }

  public async countByBusinessId(businessId: Types.ObjectId | string): Promise<number> {
    return BusinessMediaModel.countDocuments({ businessId }).exec();
  }

  public async listProfileByBusinessIds(
    businessIds: Array<Types.ObjectId | string>,
  ): Promise<BusinessMediaDocument[]> {
    if (businessIds.length === 0) {
      return [];
    }

    return BusinessMediaModel.find({ businessId: { $in: businessIds }, role: "PROFILE" })
      .select(
        "_id businessId storageKey bucket role mimeType size sortOrder createdBy createdAt updatedAt",
      )
      .exec();
  }

  public async findByIdForBusiness(
    businessId: Types.ObjectId | string,
    mediaId: Types.ObjectId | string,
  ): Promise<BusinessMediaDocument | null> {
    return BusinessMediaModel.findOne({ _id: mediaId, businessId }).exec();
  }

  public async deleteByIdForBusiness(
    businessId: Types.ObjectId | string,
    mediaId: Types.ObjectId | string,
  ): Promise<BusinessMediaDocument | null> {
    return BusinessMediaModel.findOneAndDelete({ _id: mediaId, businessId }).exec();
  }

  public async restore(document: BusinessMediaDocument): Promise<BusinessMediaDocument> {
    return new BusinessMediaModel({
      _id: document._id,
      businessId: document.businessId,
      storageKey: document.storageKey,
      bucket: document.bucket,
      role: document.role,
      mimeType: document.mimeType,
      size: document.size,
      originalFileName: document.originalFileName,
      sortOrder: document.sortOrder,
      createdBy: document.createdBy,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }).save();
  }

  public async setProfileRole(
    businessId: Types.ObjectId | string,
    mediaId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessMediaDocument | null> {
    const demoteQuery = BusinessMediaModel.updateMany(
      { businessId, role: "PROFILE" },
      { $set: { role: "GALLERY" } },
    );

    if (session) {
      demoteQuery.session(session);
    }

    await demoteQuery.exec();

    const updateQuery = BusinessMediaModel.findOneAndUpdate(
      { _id: mediaId, businessId },
      { $set: { role: "PROFILE" } },
      { returnDocument: "after", runValidators: true },
    );

    if (session) {
      updateQuery.session(session);
    }

    return updateQuery.exec();
  }
}
