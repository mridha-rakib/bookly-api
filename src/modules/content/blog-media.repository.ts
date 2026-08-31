import type { Types } from "mongoose";

import { type BlogMediaDocument, BlogMediaModel } from "./blog-media.model.js";

export type CreateBlogMediaInput = {
  storageKey: string;
  bucket: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  createdBy: Types.ObjectId;
};

export class BlogMediaRepository {
  public async create(input: CreateBlogMediaInput): Promise<BlogMediaDocument> {
    return new BlogMediaModel(input).save();
  }

  public async findById(mediaId: Types.ObjectId | string): Promise<BlogMediaDocument | null> {
    return BlogMediaModel.findById(mediaId).exec();
  }

  public async findManyByIds(ids: Array<Types.ObjectId | string>): Promise<BlogMediaDocument[]> {
    if (ids.length === 0) return [];
    return BlogMediaModel.find({ _id: { $in: ids } }).exec();
  }

  public async delete(mediaId: Types.ObjectId | string): Promise<void> {
    await BlogMediaModel.deleteOne({ _id: mediaId }).exec();
  }

  public async deleteManyByIds(ids: Array<Types.ObjectId | string>): Promise<void> {
    if (ids.length === 0) return;
    await BlogMediaModel.deleteMany({ _id: { $in: ids } }).exec();
  }
}
