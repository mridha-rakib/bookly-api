import { model, Schema, type Types } from "mongoose";

import { type DayOfWeek, daysOfWeek } from "../staff/staff-schedule.types.js";
import { isValidCanonicalTime } from "../staff/staff-schedule.utils.js";

/**
 * A Business's own general weekly opening hours — separate from StaffSchedule (a Staff
 * member's individual working hours) and separate from the per-Service MANUAL schedule
 * override on Service.manualSchedule. This is the "Business's general schedule" that
 * Service.scheduleMode = "AUTO" is documented as reading once the booking engine exists (see
 * service.types.ts) — that domain did not exist before this module.
 *
 * Unlike StaffSchedule (exactly one shift per day), the existing Business "Opening Hours"
 * onboarding UI (see components/create-business/OpeningHoursSection.tsx on the frontend)
 * already supports multiple time slots per day (e.g. a lunch-break split), so `slots` is an
 * array here rather than a single startTime/endTime pair.
 *
 * A missing document (no BusinessOpeningHours row for a businessId at all) means "not
 * configured" — the future availability engine must treat that as unknown/unbookable, never as
 * "open 24/7". A day omitted from `days` (or present with isOpen: false) means that day is
 * closed. Neither state is ever fabricated by this module.
 */
export type BusinessOpeningHoursSlot = {
  startTime: string;
  endTime: string;
};

export type BusinessOpeningHoursDay = {
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  /** Canonical 24-hour "HH:mm" ranges. Empty when isOpen is false. */
  slots: BusinessOpeningHoursSlot[];
};

export type BusinessOpeningHoursDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  days: BusinessOpeningHoursDay[];
  createdAt: Date;
  updatedAt: Date;
};

const businessOpeningHoursSlotSchema = new Schema<BusinessOpeningHoursSlot>(
  {
    startTime: {
      type: String,
      required: true,
      validate: { validator: isValidCanonicalTime, message: "startTime must be a valid HH:mm" },
    },
    endTime: {
      type: String,
      required: true,
      validate: { validator: isValidCanonicalTime, message: "endTime must be a valid HH:mm" },
    },
  },
  { _id: false },
);

const businessOpeningHoursDaySchema = new Schema<BusinessOpeningHoursDay>(
  {
    dayOfWeek: { type: String, enum: daysOfWeek, required: true },
    isOpen: { type: Boolean, required: true, default: false },
    slots: { type: [businessOpeningHoursSlotSchema], required: true, default: [] },
  },
  { _id: false },
);

// Cross-field structural check (isOpen must agree with slots.length; every slot's start must
// precede its end) — a subdocument `pre("validate")` hook rather than a path-level custom
// validator, since Mongoose's validator-function typing for subdocuments does not compose
// cleanly with a `this`-typed parameter here. `this` is cast once, narrowly, right where it's
// used, rather than fighting the generic Mongoose validator signature. This is defense in
// depth only — the one real write path (business-hours.route.ts) already fully enforces this
// via business-hours.schema.ts (Zod) before it ever reaches Mongoose, matching how
// StaffSchedule's equivalent "one shift per day" rule is Zod/service-enforced, not
// Mongoose-validated.
businessOpeningHoursDaySchema.pre("validate", function () {
  const day = this as unknown as BusinessOpeningHoursDay;

  if (day.isOpen && day.slots.length === 0) {
    throw new Error(`${day.dayOfWeek} is marked open but has no time slots`);
  }

  if (!day.isOpen && day.slots.length > 0) {
    throw new Error(`${day.dayOfWeek} is marked closed but has time slots`);
  }

  const invalidSlot = day.slots.find((slot) => slot.startTime >= slot.endTime);

  if (invalidSlot) {
    throw new Error(`${day.dayOfWeek} has a time slot where start time is not before end time`);
  }
});

const businessOpeningHoursSchema = new Schema<BusinessOpeningHoursDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    days: { type: [businessOpeningHoursDaySchema], required: true, default: [] },
  },
  { timestamps: true },
);

businessOpeningHoursSchema.index({ businessId: 1 }, { unique: true });

export const BusinessOpeningHoursModel = model<BusinessOpeningHoursDocument>(
  "BusinessOpeningHours",
  businessOpeningHoursSchema,
);
