import type { Types } from "mongoose";

import { type StaffAvatarDocument, StaffAvatarModel } from "./staff-avatar.model.js";

export type CreateStaffAvatarInput = {
  userId: Types.ObjectId;
  storageKey: string;
  bucket: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  createdBy: Types.ObjectId;
};

export type ReplaceStaffAvatarInput = Omit<CreateStaffAvatarInput, "userId">;

export class StaffAvatarRepository {
  public async findByUserId(userId: Types.ObjectId | string): Promise<StaffAvatarDocument | null> {
    return StaffAvatarModel.findOne({ userId }).exec();
  }

  public async findManyByUserIds(
    userIds: Array<Types.ObjectId | string>,
  ): Promise<StaffAvatarDocument[]> {
    if (userIds.length === 0) {
      return [];
    }

    return StaffAvatarModel.find({ userId: { $in: userIds } }).exec();
  }

  public async create(input: CreateStaffAvatarInput): Promise<StaffAvatarDocument> {
    return new StaffAvatarModel(input).save();
  }

  /** Used on replace instead of `create` so the unique index on `userId` is never violated. */
  public async replaceForUserId(
    userId: Types.ObjectId | string,
    input: ReplaceStaffAvatarInput,
  ): Promise<StaffAvatarDocument | null> {
    return StaffAvatarModel.findOneAndUpdate(
      { userId },
      { $set: input },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }
}
