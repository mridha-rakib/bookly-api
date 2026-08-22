import { model, Schema, type Types } from "mongoose";

/**
 * Booking-creation idempotency contract (Batch 3) — mirrors
 * booking-slot-reservation-claim.model.ts's proven design exactly: a flat, single-level unique
 * index is the only reliably-enforced form of MongoDB uniqueness (see that model's own doc
 * comment for the empirical finding this is based on), so idempotency for the much larger
 * Booking-creation operation reuses the same primitive rather than inventing a second scheme.
 *
 * `bookingId` is populated with a client-generated (`new Types.ObjectId()`) id BEFORE the
 * Booking document itself is written — the claim is inserted first, outside the creation
 * transaction (see BookingCreationService.createManualBooking), so a losing concurrent request
 * with the same key can immediately resolve to the winner's `bookingId` without waiting on or
 * inspecting the transaction. If the subsequent transactional creation fails for any reason
 * (a genuine validation error, a reservation conflict, a transient transaction error), the
 * caller deletes this claim row in the same failure path — an idempotency key must never be
 * permanently "poisoned" by an attempt that never produced a real Booking (see
 * BookingCreationService's own comment on this).
 */
export type BookingCreationClaimDocument = {
  _id: Types.ObjectId;
  idempotencyKey: string;
  businessId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  bookingId: Types.ObjectId;
  createdAt: Date;
};

const bookingCreationClaimSchema = new Schema<BookingCreationClaimDocument>(
  {
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

bookingCreationClaimSchema.index({ idempotencyKey: 1 }, { unique: true });

export const BookingCreationClaimModel = model<BookingCreationClaimDocument>(
  "BookingCreationClaim",
  bookingCreationClaimSchema,
);
