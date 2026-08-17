import { model, Schema, type Types } from "mongoose";

import type { BusinessCity } from "../business/business.types.js";
import { businessCities } from "../business/business.types.js";
import { genders } from "../user/user.types.js";
import {
  type ClientLinkState,
  type ClientPropertyType,
  type ClientTag,
  clientLinkStates,
  clientPropertyTypes,
  clientTags,
} from "./client.types.js";

export type BusinessClientAddress = {
  city: BusinessCity;
  propertyType: ClientPropertyType;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string | undefined;
  aptRoom?: string | undefined;
  additionalDirections?: string | undefined;
};

export type BusinessClientDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  createdByUserId: Types.ObjectId;

  // Locally captured contact/profile snapshot. Authoritative for an UNLINKED or
  // IDENTITY_CONFLICT Client; once LINKED, the service layer overlays live User/UserProfile
  // data for firstName/lastName/normalizedEmail/phone/gender in API responses instead — these
  // stored values are left untouched as a historical record and stay available if the Client
  // is later unlinked/relinked to a different identity.
  firstName: string;
  lastName?: string | undefined;
  normalizedEmail: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  // Not a global identity field (Bookly's registration flow never collects DOB), so this stays
  // Business-specific and editable even when LINKED.
  dateOfBirth?: string | undefined;
  gender?: "male" | "female" | "other" | undefined;

  // Business-specific metadata — always locally authoritative, editable regardless of link state.
  address: BusinessClientAddress;
  notes?: string | undefined;
  tag?: ClientTag | undefined;

  linkState: ClientLinkState;
  linkedUserId?: Types.ObjectId | undefined;

  archivedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const addressSchema = new Schema<BusinessClientAddress>(
  {
    city: { type: String, enum: businessCities, required: true },
    propertyType: { type: String, enum: clientPropertyTypes, required: true },
    area: { type: String, required: true, trim: true },
    streetName: { type: String, required: true, trim: true },
    streetNumber: { type: String, required: true, trim: true },
    floorUnit: { type: String, trim: true },
    aptRoom: { type: String, trim: true },
    additionalDirections: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const businessClientSchema = new Schema<BusinessClientDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    firstName: { type: String, required: true, trim: true, maxlength: 200 },
    lastName: { type: String, trim: true, maxlength: 200 },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: {
      countryCode: { type: String, required: true },
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true },
    },
    dateOfBirth: { type: String },
    gender: { type: String, enum: genders },

    address: { type: addressSchema, required: true },
    notes: { type: String, trim: true, maxlength: 2000 },
    tag: { type: String, enum: clientTags },

    linkState: { type: String, enum: clientLinkStates, required: true, default: "UNLINKED" },
    linkedUserId: { type: Schema.Types.ObjectId, ref: "User" },

    archivedAt: { type: Date },
  },
  { timestamps: true },
);

// Same-business duplicate prevention (the DB-level concurrency backstop) — matching either
// signal is treated as "the same person" for creation-blocking purposes. Deliberately NOT
// partial/scoped to non-archived docs: an archived Client with the same contact info must be
// restored, never shadowed by a second, fragmented record for the same person.
businessClientSchema.index({ businessId: 1, normalizedEmail: 1 }, { unique: true });
businessClientSchema.index({ businessId: 1, "phone.e164": 1 }, { unique: true });
// One Client row per Business per linked Customer identity.
businessClientSchema.index(
  { businessId: 1, linkedUserId: 1 },
  { unique: true, partialFilterExpression: { linkedUserId: { $exists: true } } },
);
// Cross-business identity-matching scans (post customer-registration linking) — never scoped
// to one business, so these are separate from the compound indexes above.
businessClientSchema.index({ normalizedEmail: 1 });
businessClientSchema.index({ "phone.e164": 1 });
// Clients list / Archived Clients list.
businessClientSchema.index({ businessId: 1, archivedAt: 1 });

export const BusinessClientModel = model<BusinessClientDocument>(
  "BusinessClient",
  businessClientSchema,
);
