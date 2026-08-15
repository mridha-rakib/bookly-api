import { model, Schema, type Types } from "mongoose";

import { type StaffTimeOffType, staffTimeOffTypes } from "./staff-time-off.types.js";

/**
 * A single leave period for a StaffMembership. Single-day leave is represented as
 * startDate === endDate (no separate single/range model) — see staff.service.ts for the
 * inclusive-range semantics. Dates are stored as "YYYY-MM-DD" strings rather than Date
 * objects: leave is a calendar-date concept with no time-of-day/timezone component, and
 * ISO-formatted date strings sort/compare correctly as plain strings.
 *
 * Deliberately separate from any future Business-Closed-Periods concept — this is
 * per-staff-member leave, not a business-wide closure.
 */
export type StaffTimeOffDocument = {
  _id: Types.ObjectId;
  membershipId: Types.ObjectId;
  businessId: Types.ObjectId;
  type: StaffTimeOffType;
  startDate: string;
  endDate: string;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const staffTimeOffSchema = new Schema<StaffTimeOffDocument>(
  {
    membershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    type: { type: String, enum: staffTimeOffTypes, required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Staff Availability table / Edit-prefill: fetch one membership's leave, sorted by date,
// in one indexed query. Also the natural shape for the overlap check on create.
staffTimeOffSchema.index({ membershipId: 1, startDate: 1 });

export const StaffTimeOffModel = model<StaffTimeOffDocument>("StaffTimeOff", staffTimeOffSchema);
