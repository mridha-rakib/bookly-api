import { type ClientSession, model, Schema, type Types } from "mongoose";
import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import { BookingSlotReservationError } from "./booking-slot-reservation.errors.js";
import {
  type OriginalReservationIntent,
  originalReservationIntentSchema,
  packageInitialReservationKey,
} from "./reservation-operation.js";

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
 * `reservationId` rather than racing to create its own. partySize records requested intent;
 * neither this proposed ID nor pooled capacity proves a group join was applied. The
 * optional effect separately binds the actual shared interval and once-only membership.
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
  originalIntent?: OriginalReservationIntent | undefined;
  effect?: ReservationMembershipEffect | undefined;
};

export type ReservationMembershipEffect = {
  version: 1;
  actualReservationId: Types.ObjectId;
  role: "CREATOR" | "JOINER";
  state: "APPLIED" | "RELEASED";
};

const authorizedEffectQueries = new WeakSet<object>();
const freshClaims = new WeakMap<ClientSession, Set<string>>();
const effectSchema = new Schema<ReservationMembershipEffect>(
  {
    version: { type: Number, required: true, enum: [1] },
    actualReservationId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, required: true, enum: ["CREATOR", "JOINER"] },
    state: { type: String, required: true, enum: ["APPLIED", "RELEASED"] },
  },
  { _id: false, strict: "throw" },
);

const packageOperationSchema = new Schema(
  {
    version: { type: Number, required: true, enum: [1] },
    kind: { type: String, required: true, enum: ["PACKAGE_INITIAL_APPOINTMENT"] },
    businessId: { type: String, required: true },
    bookingId: { type: String, required: true },
    batchId: { type: String, required: true },
    selectionId: { type: String, required: true },
  },
  { _id: false, strict: "throw" },
);
const originalIntentSchema = new Schema<OriginalReservationIntent>(
  {
    version: { type: Number, required: true, enum: [1] },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, required: true },
    capacityMax: { type: Number, required: true, min: 1, validate: Number.isInteger },
    packageOperation: { type: packageOperationSchema, required: false },
  },
  { _id: false, strict: "throw" },
);

const bookingSlotReservationClaimSchema = new Schema<BookingSlotReservationClaimDocument>(
  {
    idempotencyKey: { type: String, required: true, trim: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    staffMembershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    occupancyDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    reservationId: { type: Schema.Types.ObjectId, required: true },
    partySize: { type: Number, required: true, min: 1, validate: Number.isInteger },
    originalIntent: { type: originalIntentSchema, required: false },
    effect: { type: effectSchema, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// No default/backfill: missing intent means historical evidence, never inferred v1.
bookingSlotReservationClaimSchema.pre("validate", function () {
  if (!this.originalIntent) return;
  const intent = originalReservationIntentSchema.parse(this.toObject().originalIntent);
  if (
    intent.capacityMax < this.partySize ||
    (intent.packageOperation !== undefined && this.partySize !== 1) ||
    utcToBusinessLocalDate(intent.timezone, intent.startAt).dateStr !== this.occupancyDate ||
    utcToBusinessLocalDate(intent.timezone, intent.endAt).dateStr !== this.occupancyDate ||
    (intent.packageOperation &&
      (intent.packageOperation.businessId !== String(this.businessId) ||
        packageInitialReservationKey(intent.packageOperation) !== this.idempotencyKey))
  )
    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
});
// Ordinary writers cannot change roots or effects. Only the fixed-shape, transaction-
// scoped CAS below appends an effect or advances APPLIED to RELEASED.
bookingSlotReservationClaimSchema.pre("save", function () {
  const session = this.$session();
  if (this.isNew && !this.effect && session?.inTransaction()) {
    const ids = freshClaims.get(session) ?? new Set<string>();
    ids.add(String(this._id));
    freshClaims.set(session, ids);
  }
  if ((this.isNew && this.effect) || (!this.isNew && this.isModified()))
    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
});
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  bookingSlotReservationClaimSchema.pre(operation, function () {
    if (operation === "updateOne" && authorizedEffectQueries.delete(this)) return;
    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
  });
}
bookingSlotReservationClaimSchema.pre("deleteOne", { document: true, query: false }, () => {
  throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
});
bookingSlotReservationClaimSchema.pre("insertMany", () => {
  throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
});
bookingSlotReservationClaimSchema.pre("bulkWrite", () => {
  throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
});

// The idempotency guarantee itself: the same key can only ever be claimed once, collection-wide.
bookingSlotReservationClaimSchema.index({ idempotencyKey: 1 }, { unique: true });
// Proposed-ID lookup only. A join may target a different shared interval; this index
// cannot count applied parties or authorize release; use the effect and canonical key.
bookingSlotReservationClaimSchema.index({ reservationId: 1, createdAt: 1 });

export const BookingSlotReservationClaimModel = model<BookingSlotReservationClaimDocument>(
  "BookingSlotReservationClaim",
  bookingSlotReservationClaimSchema,
);

/** Internal fixed-shape CAS, never a general query authorization switch. Occupancy and
 * effect must be changed by the reservation service in this same active transaction. */
export async function transitionReservationEffect(
  claim: BookingSlotReservationClaimDocument,
  effect: ReservationMembershipEffect,
  session: ClientSession,
): Promise<void> {
  if (
    !session.inTransaction() ||
    !claim.originalIntent ||
    effect.version !== 1 ||
    (!claim.effect && !freshClaims.get(session)?.has(String(claim._id))) ||
    (claim.effect
      ? claim.effect.state !== "APPLIED" ||
        effect.state !== "RELEASED" ||
        String(claim.effect.actualReservationId) !== String(effect.actualReservationId) ||
        claim.effect.role !== effect.role
      : effect.state !== "APPLIED") ||
    (effect.role === "CREATOR" &&
      String(effect.actualReservationId) !== String(claim.reservationId))
  )
    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
  const query = BookingSlotReservationClaimModel.updateOne(
    {
      _id: claim._id,
      idempotencyKey: claim.idempotencyKey,
      businessId: claim.businessId,
      staffMembershipId: claim.staffMembershipId,
      serviceId: claim.serviceId,
      occupancyDate: claim.occupancyDate,
      partySize: claim.partySize,
      reservationId: claim.reservationId,
      originalIntent: claim.originalIntent,
      effect: claim.effect ?? { $exists: false },
    },
    { $set: { effect } },
    { session, runValidators: true },
  );
  authorizedEffectQueries.add(query);
  const result = await query.exec();
  freshClaims.get(session)?.delete(String(claim._id));
  if (result.modifiedCount !== 1)
    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
}
