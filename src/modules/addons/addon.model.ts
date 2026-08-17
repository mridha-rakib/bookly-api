import { model, Schema, type Types } from "mongoose";

import { type AddonStatus, addonStatuses } from "./addon.types.js";

/**
 * A Business-scoped Add-on (flat-fee only — no hourly/per-person/package pricing, see
 * addon.schema.ts). Deliberately NOT embedded on Business (an unbounded catalogue) and
 * deliberately NOT holding its Service relationship inline — that's a many-to-many, modeled
 * as a separate join collection (see addon-service-assignment.model.ts) so both sides have one
 * canonical source of truth instead of two arrays that can drift out of sync.
 */
export type AddonDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  status: AddonStatus;
  name: string;
  description?: string | undefined;
  /** Flat fee in integer cents — never a formatted string, never multiplied by qty/hours. */
  priceCents?: number | undefined;
  /**
   * Classification/filtering metadata only (confirmed product rule) — NOT a hard boundary on
   * which Services this Add-on may be assigned to. May be absent while the Add-on is DRAFT.
   */
  customServiceCategoryId?: Types.ObjectId | undefined;
  archivedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const addonSchema = new Schema<AddonDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    status: { type: String, enum: addonStatuses, required: true, default: "ACTIVE" },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    priceCents: { type: Number, min: 0, validate: Number.isInteger },
    customServiceCategoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);

// Catalogue list + DRAFT/ACTIVE/INACTIVE/ARCHIVED counts for one Business — the primary
// Add-ons page query.
addonSchema.index({ businessId: 1, status: 1 });
// Category picker's reverse lookup / filter-by-category.
addonSchema.index({ businessId: 1, customServiceCategoryId: 1 });
// Archived-add-ons screen.
addonSchema.index({ businessId: 1, archivedAt: 1 });

export const AddonModel = model<AddonDocument>("Addon", addonSchema);
