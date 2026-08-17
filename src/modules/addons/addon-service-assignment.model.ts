import { model, Schema, type Types } from "mongoose";

/**
 * The single canonical source of truth for the Add-on <-> Service many-to-many relationship.
 * Deliberately a separate join collection rather than an array on either side — an Add-on can
 * be attached to many Services and a Service can have many Add-ons, and each side has its own
 * independent lifecycle (draft/active/inactive/archived), so two arrays would risk drifting
 * out of sync. businessId is denormalized here purely to make assignment queries cheap to
 * scope/bound without an extra join back to Addon/Service on every read.
 */
export type AddonServiceAssignmentDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  addonId: Types.ObjectId;
  serviceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const addonServiceAssignmentSchema = new Schema<AddonServiceAssignmentDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    addonId: { type: Schema.Types.ObjectId, ref: "Addon", required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
  },
  { timestamps: true },
);

// Prevents duplicate assignment rows and is the primary "Services attached to this Add-on"
// lookup (addonId is the index prefix, so an addonId-only query also uses this index).
addonServiceAssignmentSchema.index({ addonId: 1, serviceId: 1 }, { unique: true });
// The reverse lookup — "Add-ons attached to this Service" (Service Edit's Assigned Add-ons
// section) — needs its own index since serviceId isn't a usable prefix of the index above.
addonServiceAssignmentSchema.index({ serviceId: 1 });

export const AddonServiceAssignmentModel = model<AddonServiceAssignmentDocument>(
  "AddonServiceAssignment",
  addonServiceAssignmentSchema,
);
