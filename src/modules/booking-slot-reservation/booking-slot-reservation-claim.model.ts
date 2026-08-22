import { model, Schema, type Types } from "mongoose";

/**
 * The idempotency ledger for BookingSlotReservation — see that model's own "IDEMPOTENCY"
 * section for why this is a separate, flat collection rather than a nested array field: a
 * single-level unique index on a top-level scalar field is the most basic, unambiguously
 * reliable form of MongoDB uniqueness, unlike a multikey index nested inside this module's
 * per-staff-per-day document.
 *
 * One document per idempotencyKey, ever. `reservationId` is assigned here, atomically, the
 * FIRST time a given key is ever claimed (see
 * BookingSlotReservationRepository.claimIdempotencyKey) — every subsequent attempt with the
 * same key (whether a genuine retry or a concurrent race) resolves to this same
 * `reservationId` rather than racing to create its own. This document is also the audit trail
 * of "which party (partySize) made this specific claim," which the reservation interval itself
 * no longer needs to track.
 */
export type BookingSlotReservationClaimDocument = {
  _id: Types.ObjectId;
  idempotencyKey: string;
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  occupancyDate: string;
  serviceId: Types.ObjectId;
  reservationId: Types.ObjectId;
  partySize: number;
  createdAt: Date;
};

const bookingSlotReservationClaimSchema = new Schema<BookingSlotReservationClaimDocument>(
  {
    idempotencyKey: { type: String, required: true, trim: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    staffMembershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    occupancyDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    reservationId: { type: Schema.Types.ObjectId, required: true },
    partySize: { type: Number, required: true, min: 1, validate: Number.isInteger },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The idempotency guarantee itself: the same key can only ever be claimed once, collection-wide.
bookingSlotReservationClaimSchema.index({ idempotencyKey: 1 }, { unique: true });
// A reservation's audit trail — every claim (creating + joining) that contributed to it, in
// order. Also used to compute how many distinct parties are on a session, if ever needed.
bookingSlotReservationClaimSchema.index({ reservationId: 1, createdAt: 1 });

export const BookingSlotReservationClaimModel = model<BookingSlotReservationClaimDocument>(
  "BookingSlotReservationClaim",
  bookingSlotReservationClaimSchema,
);
