import { model, Schema, type Types } from "mongoose";

import { type StaffCreatableRole, staffCreatableRoles } from "./staff.types.js";

/**
 * Employment/membership record linking a SUPERVISOR/STAFF identity (User) to the
 * Business it works for. Deliberately excludes schedule, time-off, services, and avatar —
 * those are separate domains added in a later phase (see staff-management audit).
 *
 * The Business Owner is never represented here — the Owner row on the Staff page is
 * synthesized from Business.ownerUserId + User/UserProfile (see staff.service.ts).
 */
export type StaffMembershipDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  role: StaffCreatableRole;
  employmentActive: boolean;
  createdByUserId: Types.ObjectId;
  removedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const staffMembershipSchema = new Schema<StaffMembershipDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    role: { type: String, enum: staffCreatableRoles, required: true },
    employmentActive: { type: Boolean, required: true, default: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    removedAt: { type: Date },
  },
  { timestamps: true },
);

// One Staff identity may belong to exactly one Business at a time (confirmed product rule).
// Partial-unique on userId scoped to "not removed" so a soft-removed membership never blocks
// re-provisioning, while still guaranteeing at most one *active* membership per user overall.
// (In practice email is globally unique too, so a removed staff member's email cannot be
// reused to create a brand-new account in this phase — see staff.service.ts createStaff.)
//
// MongoDB partial-index filters only support a limited operator set (equality, $exists: true,
// comparisons, $and) — `$exists: false` is rejected (it expands to $not internally). `{ $eq:
// null }` is the supported equivalent: it matches both an explicit null and a genuinely
// absent field, which is exactly "not yet removed" here (removedAt is never set to null
// explicitly — it's simply absent until softRemoveById sets a real Date).
staffMembershipSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { removedAt: { $eq: null } } },
);

// Staff list screen: fetch all active memberships for a business in one bounded query.
// Trailing createdAt matches listActiveByBusinessId's actual sort (staff.repository.ts
// `.sort({ createdAt: -1 })`) so the list never falls back to an in-memory sort.
staffMembershipSchema.index({ businessId: 1, removedAt: 1, createdAt: -1 });

export const StaffMembershipModel = model<StaffMembershipDocument>(
  "StaffMembership",
  staffMembershipSchema,
);
