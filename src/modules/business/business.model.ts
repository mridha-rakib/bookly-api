import { model, Schema, type Types } from "mongoose";

import { DEFAULT_BUSINESS_TIMEZONE, isValidIanaTimeZone } from "../../common/time/timezone.js";
import {
  type BusinessStatus,
  type BusinessVisitType,
  businessStatuses,
  businessVisitTypes,
} from "./business.types.js";

export type BusinessAddress = {
  city: string;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string | undefined;
  aptRoom?: string | undefined;
};

export type BusinessDocument = {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  name: string;
  ownerName: string;
  email: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  status: BusinessStatus;
  visitType: BusinessVisitType;
  /**
   * IANA time zone identifier (e.g. "Europe/Nicosia") — the source of truth for interpreting
   * every business-local date/time this Business will ever produce (opening hours, Booking
   * schedule snapshots, etc). `required: true` describes the model going forward; Business
   * documents persisted before this field existed simply lack it in the raw database record. No
   * destructive backfill migration was run for those rows — a plain find/findById self-heals via
   * this schema's own `default`, but `.lean()` queries and aggregation results do not (they skip
   * Document hydration), so any such read path must go through `resolveBusinessTimezone()` (see
   * common/time/timezone.ts) instead of assuming the field is always populated.
   */
  timezone: string;
  address: BusinessAddress;
  location?:
    | {
        lat: number;
        lng: number;
        searchQuery?: string | undefined;
      }
    | undefined;
  briefDescription: string;
  category: string;
  subcategories: string[];
  createdAt: Date;
  updatedAt: Date;
};

const businessSchema = new Schema<BusinessDocument>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: {
      countryCode: { type: String, required: true },
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true },
    },
    status: { type: String, enum: businessStatuses, required: true, default: "PENDING" },
    visitType: {
      type: String,
      enum: [...businessVisitTypes, "location", "travel"],
      required: true,
    },
    timezone: {
      type: String,
      required: true,
      default: DEFAULT_BUSINESS_TIMEZONE,
      validate: {
        validator: isValidIanaTimeZone,
        message: "timezone must be a valid IANA time zone identifier",
      },
    },
    address: {
      city: { type: String, required: true },
      area: { type: String, required: true },
      streetName: { type: String, required: true },
      streetNumber: { type: String, required: true },
      floorUnit: { type: String },
      aptRoom: { type: String },
    },
    location: {
      lat: { type: Number },
      lng: { type: Number },
      searchQuery: { type: String },
    },
    briefDescription: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    subcategories: { type: [String], required: true },
  },
  { timestamps: true },
);

businessSchema.index({ ownerUserId: 1 }, { unique: true });
businessSchema.index({ status: 1 });

export const BusinessModel = model<BusinessDocument>("Business", businessSchema);
