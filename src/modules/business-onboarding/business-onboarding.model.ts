import { model, Schema, type Types } from "mongoose";

import type { BusinessVisitType } from "../business/business.types.js";
import type { PhoneNumber } from "../user/user.types.js";

export type BusinessOnboardingDraftDocument = {
  _id: Types.ObjectId;
  registrationSessionId: Types.ObjectId;
  visitType?: BusinessVisitType | undefined;
  businessDetails?: {
    businessName: string;
    ownerName: string;
    city: string;
    phone: PhoneNumber;
    address: {
      area: string;
      streetName: string;
      streetNumber: string;
      floorUnit?: string | undefined;
      aptRoom?: string | undefined;
    };
    location?: {
      lat: number;
      lng: number;
      searchQuery?: string | undefined;
    };
    briefDescription: string;
  };
  categorySelection?:
    | {
        category: string;
        subcategories: string[];
      }
    | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const businessOnboardingDraftSchema = new Schema<BusinessOnboardingDraftDocument>(
  {
    registrationSessionId: {
      type: Schema.Types.ObjectId,
      ref: "RegistrationSession",
      required: true,
      unique: true,
    },
    visitType: {
      type: String,
      enum: ["AT_BUSINESS_LOCATION", "TRAVEL_TO_CUSTOMER", "location", "travel"],
    },
    businessDetails: {
      businessName: { type: String, trim: true },
      ownerName: { type: String, trim: true },
      city: { type: String },
      phone: {
        countryCode: { type: String },
        nationalNumber: { type: String },
        e164: { type: String },
      },
      address: {
        area: { type: String },
        streetName: { type: String },
        streetNumber: { type: String },
        floorUnit: { type: String },
        aptRoom: { type: String },
      },
      location: {
        lat: { type: Number },
        lng: { type: Number },
        searchQuery: { type: String },
      },
      briefDescription: { type: String },
    },
    categorySelection: {
      category: { type: String },
      subcategories: { type: [String] },
    },
  },
  { timestamps: true },
);

export const BusinessOnboardingDraftModel = model<BusinessOnboardingDraftDocument>(
  "BusinessOnboardingDraft",
  businessOnboardingDraftSchema,
);
