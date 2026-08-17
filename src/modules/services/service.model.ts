import { model, Schema, type Types } from "mongoose";

import type { BusinessCity } from "../business/business.types.js";
import { businessCities } from "../business/business.types.js";
import { type DayOfWeek, daysOfWeek } from "../staff/staff-schedule.types.js";
import {
  type ServicePricingMode,
  type ServiceScheduleMode,
  type ServiceStatus,
  servicePricingModes,
  serviceScheduleModes,
  serviceStatuses,
} from "./service.types.js";

export type ServiceFixedPricing = {
  priceCents: number;
  durationMin: number;
  bookingIntervalMin?: number | undefined;
  bufferAfterMin?: number | undefined;
  processingTimeMin?: number | undefined;
  discountPercent?: number | undefined;
};

export type ServiceHourlyPricing = {
  ratePerHourCents: number;
  minHours: number;
  maxHours: number;
  bufferAfterMin?: number | undefined;
};

export type ServicePerPersonPricing = {
  ratePerPersonCents: number;
  minPersons: number;
  maxPersons: number;
  durationMin: number;
  bookingIntervalMin?: number | undefined;
  bufferAfterMin?: number | undefined;
};

export type ServicePackagePricing = {
  durationMin: number;
  bookingIntervalMin?: number | undefined;
  bufferAfterMin?: number | undefined;
  processingTimeMin?: number | undefined;
  sessionsInPackage: number;
  bundlePriceCents: number;
  discountPercent?: number | undefined;
};

export type ServiceManualScheduleDay = {
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  /** Canonical 24-hour "HH:mm" values, deduped — never AM/PM display strings. */
  times: string[];
};

export type ServiceSessionExpiryAlert = {
  enabled: boolean;
  minutesBeforeSessionEnds?: number | undefined;
};

export type ServiceDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  status: ServiceStatus;
  isFeatured: boolean;
  isPackageDeal: boolean;

  // Snapshotted from Business at write time (Business.category/subcategories are plain
  // strings, not a dedicated collection — see business.model.ts). category is always known
  // (it's the Business's own fixed category, not user input) so it's always set; subcategory
  // and serviceCategoryId are user choices and may be absent while the Service is a DRAFT.
  category: string;
  subcategory?: string | undefined;
  serviceCategoryId?: Types.ObjectId | undefined;

  name: string;
  packageServicesName?: string | undefined;
  description?: string | undefined;

  pricingMode?: ServicePricingMode | undefined;
  fixedPricing?: ServiceFixedPricing | undefined;
  hourlyPricing?: ServiceHourlyPricing | undefined;
  perPersonPricing?: ServicePerPersonPricing | undefined;
  packagePricing?: ServicePackagePricing | undefined;

  sessionExpiryAlert: ServiceSessionExpiryAlert;

  scheduleMode: ServiceScheduleMode;
  manualSchedule: ServiceManualScheduleDay[];

  servedCities: BusinessCity[];

  assignedStaffMembershipIds: Types.ObjectId[];

  archivedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const fixedPricingSchema = new Schema<ServiceFixedPricing>(
  {
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    durationMin: { type: Number, required: true, min: 1 },
    bookingIntervalMin: { type: Number, min: 1 },
    bufferAfterMin: { type: Number, min: 0 },
    processingTimeMin: { type: Number, min: 0 },
    discountPercent: { type: Number, min: 0, max: 100 },
  },
  { _id: false },
);

const hourlyPricingSchema = new Schema<ServiceHourlyPricing>(
  {
    ratePerHourCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    minHours: { type: Number, required: true, min: 1 },
    maxHours: { type: Number, required: true, min: 1 },
    bufferAfterMin: { type: Number, min: 0 },
  },
  { _id: false },
);

const perPersonPricingSchema = new Schema<ServicePerPersonPricing>(
  {
    ratePerPersonCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    minPersons: { type: Number, required: true, min: 1 },
    maxPersons: { type: Number, required: true, min: 1 },
    durationMin: { type: Number, required: true, min: 1 },
    bookingIntervalMin: { type: Number, min: 1 },
    bufferAfterMin: { type: Number, min: 0 },
  },
  { _id: false },
);

const packagePricingSchema = new Schema<ServicePackagePricing>(
  {
    durationMin: { type: Number, required: true, min: 1 },
    bookingIntervalMin: { type: Number, min: 1 },
    bufferAfterMin: { type: Number, min: 0 },
    processingTimeMin: { type: Number, min: 0 },
    sessionsInPackage: { type: Number, required: true, min: 1 },
    bundlePriceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    discountPercent: { type: Number, min: 0, max: 100 },
  },
  { _id: false },
);

const manualScheduleDaySchema = new Schema<ServiceManualScheduleDay>(
  {
    dayOfWeek: { type: String, enum: daysOfWeek, required: true },
    isOpen: { type: Boolean, required: true, default: false },
    times: { type: [String], required: true, default: [] },
  },
  { _id: false },
);

const sessionExpiryAlertSchema = new Schema<ServiceSessionExpiryAlert>(
  {
    enabled: { type: Boolean, required: true, default: false },
    minutesBeforeSessionEnds: { type: Number, min: 1 },
  },
  { _id: false },
);

const serviceSchema = new Schema<ServiceDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    status: { type: String, enum: serviceStatuses, required: true, default: "ACTIVE" },
    isFeatured: { type: Boolean, required: true, default: false },
    isPackageDeal: { type: Boolean, required: true, default: false },

    category: { type: String, required: true, trim: true },
    // Not `required` — a DRAFT Service may not have a subcategory/custom category chosen
    // yet. ACTIVE/INACTIVE presence is enforced at the Zod layer (status-aware validation),
    // not here, since Mongoose has no notion of "required unless DRAFT".
    subcategory: { type: String, trim: true },
    serviceCategoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory" },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    packageServicesName: { type: String, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },

    pricingMode: { type: String, enum: servicePricingModes },
    fixedPricing: { type: fixedPricingSchema },
    hourlyPricing: { type: hourlyPricingSchema },
    perPersonPricing: { type: perPersonPricingSchema },
    packagePricing: { type: packagePricingSchema },

    sessionExpiryAlert: { type: sessionExpiryAlertSchema, required: true },

    scheduleMode: { type: String, enum: serviceScheduleModes, required: true, default: "AUTO" },
    manualSchedule: { type: [manualScheduleDaySchema], required: true, default: [] },

    servedCities: { type: [String], enum: businessCities, required: true, default: [] },

    assignedStaffMembershipIds: {
      type: [Schema.Types.ObjectId],
      ref: "StaffMembership",
      required: true,
      default: [],
    },

    archivedAt: { type: Date },
  },
  { timestamps: true },
);

// Catalogue list + ACTIVE/INACTIVE/ARCHIVED counts for one Business — the primary Services
// page query.
serviceSchema.index({ businessId: 1, status: 1 });
// "Which Services reference this category" — used before allowing a category rename check
// and by the picker's reverse lookup.
serviceSchema.index({ businessId: 1, serviceCategoryId: 1 });
// Archived-services screen.
serviceSchema.index({ businessId: 1, archivedAt: 1 });

export const ServiceModel = model<ServiceDocument>("Service", serviceSchema);
