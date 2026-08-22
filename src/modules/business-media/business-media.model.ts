import { model, Schema, type Types } from "mongoose";

export const businessMediaRoles = ["PROFILE", "GALLERY"] as const;

export type BusinessMediaRole = (typeof businessMediaRoles)[number];

export type BusinessMediaDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  storageKey: string;
  bucket: string;
  role: BusinessMediaRole;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  sortOrder: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const businessMediaSchema = new Schema<BusinessMediaDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    storageKey: { type: String, required: true, trim: true },
    bucket: { type: String, required: true, trim: true },
    role: { type: String, enum: businessMediaRoles, required: true, default: "GALLERY" },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 1 },
    originalFileName: { type: String, trim: true },
    sortOrder: { type: Number, required: true, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Media gallery list — trailing createdAt matches listByBusinessId's actual compound sort
// (business-media.repository.ts `.sort({ sortOrder: 1, createdAt: 1 })`, the tie-break for
// rows sharing a sortOrder) so the list never falls back to an in-memory sort.
businessMediaSchema.index({ businessId: 1, sortOrder: 1, createdAt: 1 });
businessMediaSchema.index(
  { businessId: 1, role: 1 },
  { partialFilterExpression: { role: "PROFILE" }, unique: true },
);
businessMediaSchema.index({ storageKey: 1, bucket: 1 }, { unique: true });

export const BusinessMediaModel = model<BusinessMediaDocument>(
  "BusinessMedia",
  businessMediaSchema,
);
