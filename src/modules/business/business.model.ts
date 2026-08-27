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
  /** Explicit, Super Admin-controlled marketing flag (Business Detail action + public landing
   * "Trusted by local businesses" section). Never inferred from age / approval date / bookings —
   * an admin sets it. Defaults to false; pre-existing rows read as false via this schema default
   * (no destructive backfill). */
  isFoundingPartner: boolean;
  /** Manual link-only integration fields (no OAuth) — shown on Settings → Integration and the
   * public business profile. Not fetched or verified via Meta's Graph API. */
  instagramHandle?: string | undefined;
  facebookPageUrl?: string | undefined;
  /** Batch 11 — the Business lifecycle audit trail (mirrors Booking's own embedded
   * `eventHistory` pattern rather than a separate global audit collection — same established
   * per-entity convention). Written ONLY by BusinessLifecycleService's approve/reject/suspend
   * methods, never by a generic status PATCH (no such endpoint exists). */
  statusHistory: Array<{
    fromStatus: BusinessStatus;
    toStatus: BusinessStatus;
    actorUserId: Types.ObjectId;
    reason?: string | undefined;
    changedAt: Date;
  }>;
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
    isFoundingPartner: { type: Boolean, required: true, default: false },
    instagramHandle: { type: String, trim: true },
    facebookPageUrl: { type: String, trim: true },
    statusHistory: {
      type: [
        {
          _id: false,
          fromStatus: { type: String, enum: businessStatuses, required: true },
          toStatus: { type: String, enum: businessStatuses, required: true },
          actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          reason: { type: String, trim: true, maxlength: 2000 },
          changedAt: { type: Date, required: true },
        },
      ],
      required: true,
      default: [],
    },
  },
  { timestamps: true },
);

businessSchema.index({ ownerUserId: 1 }, { unique: true });
businessSchema.index({ status: 1 });
// Super Admin Business list — status filter + newest-first, the one paginated list query this
// collection needs (see business.repository.ts listForSuperAdmin).
businessSchema.index({ status: 1, createdAt: -1 });
// Batch 12 — Super Admin Business Analytics "businesses created over time" needs an unfiltered
// createdAt range/sort; the compound index above can't serve that efficiently since status is
// its leading key.
businessSchema.index({ createdAt: -1 });
// Batch 12 — Super Admin Recent Activity: the most-recently-changed Businesses (a statusHistory
// push updates this same field) to surface recent approve/reject/suspend events without scanning
// every Business's full history.
businessSchema.index({ updatedAt: -1 });
// Public landing "Trusted by local businesses" — the founding-partners read filters on exactly
// {isFoundingPartner, status} (a tiny subset), keeping that anonymous path off a collection scan.
businessSchema.index({ isFoundingPartner: 1, status: 1 });

export const BusinessModel = model<BusinessDocument>("Business", businessSchema);
