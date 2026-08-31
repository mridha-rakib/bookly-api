import { model, Schema, type Types } from "mongoose";

import { type StaffCreatableRole, staffCreatableRoles } from "./staff.types.js";

/**
 * Append-only audit record of a Business-Owner-initiated change to a StaffMembership's ACCESS
 * state — its role, or its active/inactive employment flag. It is deliberately NOT a general
 * staff-edit log: name/email/phone/schedule edits are not recorded here.
 *
 * Its purpose is twofold:
 *   1. a durable history of who changed what and when (no reason/comment is captured — none is
 *      entered anywhere in the current flow, and none is invented here); and
 *   2. a STABLE, unique identity (`_id`) for the transactional email that follows the change —
 *      this is what closes the earlier "repeatable role/active toggle has no safe dedupe key"
 *      gap. STAFF↔SUPERVISOR back-and-forth, or deactivate/reactivate cycles, each produce a
 *      new event with a new `_id`, so each legitimately sends exactly one email while a retried
 *      notifier call for the SAME event id stays deduped by the EmailOutbox unique index.
 *
 * `removedAt`-style soft removal is a DIFFERENT, pre-existing concept (STAFF_ACCESS_REMOVED) and
 * is not modelled here.
 */
export const staffAccessEventTypes = ["ROLE_CHANGED", "DEACTIVATED", "REACTIVATED"] as const;
export type StaffAccessEventType = (typeof staffAccessEventTypes)[number];

export type StaffAccessEventDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  staffUserId: Types.ObjectId;
  type: StaffAccessEventType;
  changedByUserId: Types.ObjectId;
  /** Populated only for `ROLE_CHANGED`. */
  previousRole?: StaffCreatableRole | undefined;
  newRole?: StaffCreatableRole | undefined;
  /** Populated only for `DEACTIVATED` / `REACTIVATED`. */
  previousEmploymentActive?: boolean | undefined;
  newEmploymentActive?: boolean | undefined;
  createdAt: Date;
};

const staffAccessEventSchema = new Schema<StaffAccessEventDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    staffMembershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    staffUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: staffAccessEventTypes, required: true },
    changedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    previousRole: { type: String, enum: staffCreatableRoles },
    newRole: { type: String, enum: staffCreatableRoles },
    previousEmploymentActive: { type: Boolean },
    newEmploymentActive: { type: Boolean },
  },
  // Immutable audit record — only the creation instant is meaningful.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// A single membership's access history, newest first (the natural "what changed on this staff
// member" query, and the shape a future audit timeline would read).
staffAccessEventSchema.index({ staffMembershipId: 1, createdAt: -1 });
// The same, scoped to a business (a future business-wide access-audit view).
staffAccessEventSchema.index({ businessId: 1, staffMembershipId: 1, createdAt: -1 });

export const StaffAccessEventModel = model<StaffAccessEventDocument>(
  "StaffAccessEvent",
  staffAccessEventSchema,
);
