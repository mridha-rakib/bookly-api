import { model, Schema, type Types } from "mongoose";
import type { AvailabilityRules } from "./business-availability.rules.js";
import type { StoredBusinessTaxSettings } from "./business-tax-settings.js";

/**
 * Business-scoped booking settings: gap elimination, declared tax position and availability
 * restrictions. Availability mutations share the final scheduling admission transaction fence;
 * each setting group is updated independently so unrelated configuration remains intact.
 */
export type BusinessBookingSettingsDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  gapEliminationEnabled: boolean;
  availability?: AvailabilityRules | undefined;
  /** Business-declared VAT position (P0.5). Owner-only; never exposed by catalog APIs. */
  tax?: (StoredBusinessTaxSettings & { updatedByUserId: Types.ObjectId }) | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const businessBookingSettingsSchema = new Schema<BusinessBookingSettingsDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    gapEliminationEnabled: { type: Boolean, required: true, default: false },
    availability: {
      type: new Schema(
        {
          minimumNoticeMinutes: {
            type: Number,
            enum: [15, 30, 60, 120, 1440, null],
            default: null,
          },
          maximumAdvanceMonths: { type: Number, enum: [1, 3, 6, 12, null], default: null },
          closedPeriods: {
            type: [
              new Schema(
                {
                  startDate: { type: String, required: true },
                  endDate: { type: String, required: true },
                  note: String,
                },
                { _id: false },
              ),
            ],
            default: [],
          },
          slotBlocks: {
            type: [
              new Schema(
                {
                  staffMembershipId: String,
                  startAt: { type: Date, required: true },
                  endAt: { type: Date, required: true },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      required: false,
    },
    tax: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ["VAT_REGISTERED", "VAT_EXEMPT", "NOT_VAT_REGISTERED"],
            required: true,
          },
          countryCode: { type: String, enum: ["CY"], required: true },
          vatNumber: { type: String, match: /^CY\d{8}[A-Z]$/ },
          updatedAt: { type: Date, required: true },
          updatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: true },
);

businessBookingSettingsSchema.index({ businessId: 1 }, { unique: true });

export const BusinessBookingSettingsModel = model<BusinessBookingSettingsDocument>(
  "BusinessBookingSettings",
  businessBookingSettingsSchema,
);
