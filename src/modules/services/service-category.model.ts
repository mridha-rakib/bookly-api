import { model, Schema, type Types } from "mongoose";

/**
 * A Business-specific custom Service Category (Business Profile → "Service Category (add
 * custom tabs for your business e.g. Hair Treatment, Nail Treatment etc.)"). Deliberately
 * NOT a global taxonomy — every category belongs to exactly one Business and Business A's
 * categories must never be selectable by Business B. "Delete" from the UI archives
 * (active: false) rather than removing the row, so Services that already reference a
 * category keep a valid, resolvable reference even after the owner retires it.
 */
export type ServiceCategoryDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  name: string;
  /** Lowercased/trimmed shadow of `name`, used only for the case-insensitive uniqueness index. */
  nameKey: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const serviceCategorySchema = new Schema<ServiceCategoryDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    nameKey: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// A Business may not have two categories with the same name (case-insensitive), including
// against an archived one — reactivating/renaming is the intended path, not a duplicate.
serviceCategorySchema.index({ businessId: 1, nameKey: 1 }, { unique: true });
// Service-creation picker: active categories for one Business, newest first.
serviceCategorySchema.index({ businessId: 1, active: 1 });

export const ServiceCategoryModel = model<ServiceCategoryDocument>(
  "ServiceCategory",
  serviceCategorySchema,
);
