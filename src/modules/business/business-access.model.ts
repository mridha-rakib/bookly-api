import { model, Schema, type Types } from "mongoose";

export type BusinessAccessDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const businessAccessSchema = new Schema<BusinessAccessDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
  },
  { timestamps: true },
);

// Supports: duplicate-link prevention and "list linked businesses for user" (userId prefix).
businessAccessSchema.index({ userId: 1, businessId: 1 }, { unique: true });

export const BusinessAccessModel = model<BusinessAccessDocument>(
  "BusinessAccess",
  businessAccessSchema,
);
