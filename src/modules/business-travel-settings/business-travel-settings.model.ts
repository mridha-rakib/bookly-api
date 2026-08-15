import { model, Schema, type Types } from "mongoose";

import { type BusinessCity, businessCities } from "../business/business.types.js";

export type BusinessTravelCitySetting = {
  city: BusinessCity;
  active: boolean;
  feeCents: number;
};

export type BusinessTravelSettingsDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  cities: BusinessTravelCitySetting[];
  createdAt: Date;
  updatedAt: Date;
};

const businessTravelCitySettingSchema = new Schema<BusinessTravelCitySetting>(
  {
    city: { type: String, enum: businessCities, required: true },
    active: { type: Boolean, required: true, default: false },
    feeCents: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "feeCents must be an integer",
      },
    },
  },
  { _id: false },
);

const businessTravelSettingsSchema = new Schema<BusinessTravelSettingsDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    cities: {
      type: [businessTravelCitySettingSchema],
      required: true,
      default: [],
      validate: {
        validator: (cities: BusinessTravelCitySetting[]) =>
          new Set(cities.map((city) => city.city)).size === cities.length,
        message: "Duplicate travel-fee city entries are not allowed",
      },
    },
  },
  { timestamps: true },
);

businessTravelSettingsSchema.index({ businessId: 1 }, { unique: true });

export const BusinessTravelSettingsModel = model<BusinessTravelSettingsDocument>(
  "BusinessTravelSettings",
  businessTravelSettingsSchema,
);
