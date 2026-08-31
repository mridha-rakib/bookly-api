import { model, Schema, type Types } from "mongoose";

/**
 * Blog media asset store. Mirrors `business-media.model.ts` exactly (storage key + bucket +
 * mime/size metadata, never a signed URL). Deliberately has NO `blogPostId` — an image is
 * uploaded first, gets an id, and is then referenced by `BlogPost.coverMediaId` /
 * `BlogPost.galleryMediaIds`. Read URLs are minted fresh on every response via the storage
 * service, so a 15-minute signed URL never becomes stale persisted data.
 */
export type BlogMediaDocument = {
  _id: Types.ObjectId;
  storageKey: string;
  bucket: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const blogMediaSchema = new Schema<BlogMediaDocument>(
  {
    storageKey: { type: String, required: true, trim: true },
    bucket: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 1 },
    originalFileName: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

blogMediaSchema.index({ storageKey: 1, bucket: 1 }, { unique: true });

export const BlogMediaModel = model<BlogMediaDocument>("BlogMedia", blogMediaSchema);
