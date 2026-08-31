import { model, Schema, type Types } from "mongoose";

import { businessCategoryKeys } from "./business-category.js";
import {
  DEFAULT_MAX_SERVICES_PER_BOOKING,
  DEFAULT_NO_SHOW_CATEGORY_WINDOWS,
  MIN_MAX_SERVICES_PER_BOOKING,
  type NoShowCategoryWindow,
  STRUCTURAL_MAX_SERVICES_PER_BOOKING,
} from "./platform-settings.constants.js";

/**
 * Singleton platform configuration — the ONLY editable Super Admin platform settings for this
 * phase. Fixed product rules (deposit clamp, cancellation %-bounds, cancellation tiers, the
 * 90-minute no-show resolution duration, auth/session TTLs) are NOT stored here — they stay in
 * code / env and are only serialized read-only by the Super Admin GET.
 *
 * Exactly one document, pinned by `key: "SINGLETON"` (unique). Lazily created with canonical
 * defaults on first read (see PlatformSettingsRepository.getOrCreate) — never a destructive
 * startup seed, and a restart never overwrites an admin edit.
 */
export type PlatformSettingsDocument = {
  _id: Types.ObjectId;
  key: "SINGLETON";
  maxServicesPerBooking: number;
  noShowCategoryWindows: NoShowCategoryWindow[];
  createdAt: Date;
  updatedAt: Date;
};

const noShowCategoryWindowSchema = new Schema<NoShowCategoryWindow>(
  {
    categoryKey: { type: String, enum: businessCategoryKeys, required: true },
    opensAfterMinutes: { type: Number, required: true, min: 0, validate: Number.isInteger },
    closesAfterMinutes: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

noShowCategoryWindowSchema.pre("validate", function () {
  const window = this as unknown as NoShowCategoryWindow;
  if (window.opensAfterMinutes >= window.closesAfterMinutes) {
    throw new Error(
      `${window.categoryKey}: opensAfterMinutes (${window.opensAfterMinutes}) must be less than closesAfterMinutes (${window.closesAfterMinutes})`,
    );
  }
});

const platformSettingsSchema = new Schema<PlatformSettingsDocument>(
  {
    key: { type: String, enum: ["SINGLETON"], required: true, unique: true, default: "SINGLETON" },
    maxServicesPerBooking: {
      type: Number,
      required: true,
      default: DEFAULT_MAX_SERVICES_PER_BOOKING,
      min: MIN_MAX_SERVICES_PER_BOOKING,
      max: STRUCTURAL_MAX_SERVICES_PER_BOOKING,
      validate: Number.isInteger,
    },
    noShowCategoryWindows: {
      type: [noShowCategoryWindowSchema],
      required: true,
      default: () => DEFAULT_NO_SHOW_CATEGORY_WINDOWS.map((w) => ({ ...w })),
      validate: {
        validator: (windows: NoShowCategoryWindow[]) => {
          const keys = windows.map((w) => w.categoryKey);
          return (
            keys.length === businessCategoryKeys.length &&
            businessCategoryKeys.every((key) => keys.includes(key)) &&
            new Set(keys).size === keys.length
          );
        },
        message: "noShowCategoryWindows must contain exactly one entry per canonical category",
      },
    },
  },
  { timestamps: true },
);

export const PlatformSettingsModel = model<PlatformSettingsDocument>(
  "PlatformSettings",
  platformSettingsSchema,
);
