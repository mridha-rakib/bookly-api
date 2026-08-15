import { model, Schema, type Types } from "mongoose";

import { type DayOfWeek, daysOfWeek } from "./staff-schedule.types.js";

/**
 * One weekly schedule document per StaffMembership (not per-day) — compact by design: at
 * most 7 embedded day entries, each with exactly one shift (confirmed product rule forbids
 * multiple shifts/day, so there is no nested intervals array to overengineer). Keyed by
 * membershipId, not userId, so schedule is always scoped to the Business the membership
 * belongs to — never a bare identity-level record that could leak across businesses.
 */
export type StaffScheduleDayDocument = {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
};

export type StaffScheduleDocument = {
  _id: Types.ObjectId;
  membershipId: Types.ObjectId;
  businessId: Types.ObjectId;
  days: StaffScheduleDayDocument[];
  createdAt: Date;
  updatedAt: Date;
};

const staffScheduleDaySchema = new Schema<StaffScheduleDayDocument>(
  {
    dayOfWeek: { type: String, enum: daysOfWeek, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
  },
  { _id: false },
);

const staffScheduleSchema = new Schema<StaffScheduleDocument>(
  {
    membershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    days: { type: [staffScheduleDaySchema], required: true, default: [] },
  },
  { timestamps: true },
);

// One schedule document per membership — the service layer replaces `days` wholesale on
// every PUT (deduplicated by construction from a Map keyed by dayOfWeek), which is what
// actually enforces "at most one shift per day"; this index just guarantees at most one
// schedule document exists per membership at all.
staffScheduleSchema.index({ membershipId: 1 }, { unique: true });

export const StaffScheduleModel = model<StaffScheduleDocument>(
  "StaffSchedule",
  staffScheduleSchema,
);
