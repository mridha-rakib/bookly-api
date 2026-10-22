import { model, Schema, type Types } from "mongoose";
import { packageDefinitionContractTermsSchema } from "./package.schema.js";
import { type PackageStatus, packageStatuses } from "./package.types.js";
import { calculatePackagePricing } from "./package-pricing.js";
import {
  PACKAGE_DEFINITION_CONTRACT_VERSION,
  PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
  PACKAGE_SESSION_PENALTY_POLICY,
  type PackageDefinitionContractTerms,
} from "./package-session-penalty-policy.js";

export type PackageItem = {
  itemId: Types.ObjectId;
  serviceId: Types.ObjectId;
  includedSessions: number;
  referenceUnitPriceCents?: number | undefined;
  penaltyBasisCents?: number | undefined;
};
export type PackageDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  name: string;
  description?: string | undefined;
  category: string;
  subcategory?: string | undefined;
  serviceCategoryId?: Types.ObjectId | undefined;
  status: PackageStatus;
  isFeatured: boolean;
  revision: number;
  items: PackageItem[];
  bundlePriceCents?: number | undefined;
  contractTerms?: PackageDefinitionContractTerms | undefined;
  archivedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};
const positive = {
  type: Number,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};
const itemSchema = new Schema<PackageItem>(
  {
    itemId: { type: Schema.Types.ObjectId, required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    includedSessions: { ...positive, required: true },
    referenceUnitPriceCents: positive,
    penaltyBasisCents: {
      type: Number,
      min: 0,
      max: PACKAGE_SESSION_PENALTY_POLICY.maxBasisCents,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: "throw" },
);
const packageSchema = new Schema<PackageDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    name: { type: String, trim: true, required: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    category: { type: String, required: true },
    subcategory: { type: String, trim: true },
    serviceCategoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },
    status: { type: String, enum: packageStatuses, default: "DRAFT", required: true },
    isFeatured: { type: Boolean, default: false, required: true },
    revision: { ...positive, default: 1, required: true },
    items: { type: [itemSchema], default: [], required: true },
    bundlePriceCents: {
      type: Number,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isSafeInteger,
    },
    // Optional with no default: old definitions are never silently opted in.
    contractTerms: {
      type: new Schema(
        {
          version: {
            type: Number,
            enum: [
              PACKAGE_DEFINITION_CONTRACT_VERSION,
              PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
            ],
            required: true,
          },
          validityMonths: { type: Number, enum: [6, 12] },
          validity: {
            type: new Schema(
              {
                mode: { type: String, enum: ["FINITE", "FOREVER"], required: true },
                months: { type: Number, enum: [6, 12] },
              },
              { _id: false, strict: "throw" },
            ),
          },
          penaltyPolicyVersion: {
            type: Number,
            enum: [PACKAGE_SESSION_PENALTY_POLICY.version],
            required: true,
          },
        },
        { _id: false, strict: "throw" },
      ),
      validate: {
        validator: (value: { toObject(): unknown }) =>
          value == null || packageDefinitionContractTermsSchema.safeParse(value.toObject()).success,
        message: "Invalid versioned Package contract terms",
      },
    },
    archivedAt: Date,
  },
  { timestamps: true, strict: "throw" },
);

packageSchema.pre("validate", function () {
  for (const key of ["itemId", "serviceId"] as const) {
    const ids = this.items.map((item) => String(item[key]));
    if (new Set(ids).size !== ids.length) this.invalidate("items", `Duplicate ${key}`);
  }
  try {
    calculatePackagePricing(this.items, this.bundlePriceCents);
  } catch (error) {
    this.invalidate("bundlePriceCents", (error as Error).message);
  }
  if (this.status === "ACTIVE" || this.status === "INACTIVE") {
    if (!this.items.length || this.items.some((item) => item.referenceUnitPriceCents === undefined))
      this.invalidate("items", "Complete items required for publication");
    for (const key of ["bundlePriceCents", "serviceCategoryId", "subcategory"] as const) {
      if (this[key] === undefined) this.invalidate(key, "Required for publication");
    }
  }
});

packageSchema.index({ businessId: 1, status: 1, createdAt: -1 });
packageSchema.index({ businessId: 1, archivedAt: 1, createdAt: -1 });
packageSchema.index({ businessId: 1, "items.serviceId": 1 });

export const PackageModel = model<PackageDocument>("Package", packageSchema);
