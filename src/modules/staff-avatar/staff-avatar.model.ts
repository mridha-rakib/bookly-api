import { model, Schema, type Types } from "mongoose";

/**
 * Exactly one current avatar per User (Staff/Supervisor identity, or a future Owner
 * upload path — never StaffMembership). Not BusinessMedia: no role enum, no gallery,
 * no businessId — this is user/identity media, not business-profile media.
 */
export type StaffAvatarDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storageKey: string;
  bucket: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const staffAvatarSchema = new Schema<StaffAvatarDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    storageKey: { type: String, required: true, trim: true },
    bucket: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 1 },
    originalFileName: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

staffAvatarSchema.index({ userId: 1 }, { unique: true });
staffAvatarSchema.index({ storageKey: 1, bucket: 1 }, { unique: true });

export const StaffAvatarModel = model<StaffAvatarDocument>("StaffAvatar", staffAvatarSchema);
