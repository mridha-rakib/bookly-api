import { model, Schema, type Types } from "mongoose";

/**
 * Business-scoped booking/scheduling settings. Currently holds only Gap Elimination — a
 * single toggle shown once above the Services catalogue in the dashboard, not per-Service
 * (confirmed product rule). Modeled as its own small collection (mirrors
 * business-travel-settings) rather than a field on Business, so future booking-settings
 * additions don't keep growing the core Business document.
 */
export type BusinessBookingSettingsDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  gapEliminationEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const businessBookingSettingsSchema = new Schema<BusinessBookingSettingsDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    gapEliminationEnabled: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

businessBookingSettingsSchema.index({ businessId: 1 }, { unique: true });

export const BusinessBookingSettingsModel = model<BusinessBookingSettingsDocument>(
  "BusinessBookingSettings",
  businessBookingSettingsSchema,
);
