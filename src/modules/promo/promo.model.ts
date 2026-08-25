import { model, Schema, type Types } from "mongoose";
import {
  type PromoScope,
  type PromoStatus,
  type PromoType,
  promoScopes,
  promoStatuses,
  promoTypes,
} from "./promo.types.js";

export type PromoCodeDocument = {
  _id: Types.ObjectId;
  /** As entered by the Super Admin (display only). */
  code: string;
  /** Uppercase-trimmed, the ONLY field ever queried/uniqued — canonicalizes "BOOKLY20" /
   * "bookly20" / "Bookly20" to the same promo (rule: never rely on frontend uppercasing alone). */
  normalizedCode: string;
  type: PromoType;
  /** PERCENTAGE: 0–100. FIXED: integer cents. Validated per-type at the schema layer. */
  value: number;
  scope: PromoScope;
  /** Only meaningful (and only ever non-empty) when `scope === "SELECTED_BUSINESSES"`. */
  businessIds: Types.ObjectId[];
  startAt?: Date | undefined;
  expiresAt: Date;
  status: PromoStatus;
  totalUsageLimit?: number | undefined;
  perUserUsageLimit?: number | undefined;
  /** Atomically incremented via a CAS `findOneAndUpdate` gated on `redeemedCount <
   * totalUsageLimit` (mirrors BusinessRepository.casUpdateStatus's own CAS idiom) — the single
   * global-cap concurrency guard. Never read-then-write. */
  redeemedCount: number;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const promoCodeSchema = new Schema<PromoCodeDocument>(
  {
    code: { type: String, required: true, trim: true, maxlength: 40 },
    normalizedCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    type: { type: String, enum: promoTypes, required: true },
    value: { type: Number, required: true, min: 0, validate: Number.isFinite },
    scope: { type: String, enum: promoScopes, required: true },
    businessIds: { type: [Schema.Types.ObjectId], ref: "Business", required: true, default: [] },
    startAt: { type: Date },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: promoStatuses, required: true, default: "ACTIVE" },
    totalUsageLimit: { type: Number, min: 1, validate: Number.isInteger },
    perUserUsageLimit: { type: Number, min: 1, validate: Number.isInteger },
    redeemedCount: { type: Number, required: true, default: 0, min: 0 },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

promoCodeSchema.pre("validate", function () {
  const doc = this as unknown as PromoCodeDocument;
  if (doc.scope === "SELECTED_BUSINESSES" && doc.businessIds.length === 0) {
    throw new Error("SELECTED_BUSINESSES scope requires at least one businessId");
  }
  if (doc.startAt && doc.startAt >= doc.expiresAt) {
    throw new Error("startAt must be before expiresAt");
  }
  if (doc.type === "PERCENTAGE" && doc.value > 100) {
    throw new Error("PERCENTAGE promo value cannot exceed 100");
  }
});

promoCodeSchema.index({ normalizedCode: 1 }, { unique: true });
// Validity/listing queries: status filter + newest-first (Super Admin list), and the validation
// path's own "is this code currently active" read.
promoCodeSchema.index({ status: 1, createdAt: -1 });

export const PromoCodeModel = model<PromoCodeDocument>("PromoCode", promoCodeSchema);
