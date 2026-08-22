import { model, Schema, type Types } from "mongoose";

import {
  type BookingSlotReservationStatus,
  bookingSlotReservationStatuses,
} from "./booking-slot-reservation.types.js";

/**
 * The DB-enforced source of truth for "is this Staff member occupied at this instant" — the
 * conflict-safety primitive the Availability Engine reads from and writes to. This is
 * deliberately NOT the same thing as a Booking: no route/controller creates a Booking from
 * this module in this batch (that composition is Batch 3's job, per the brief's explicit "no
 * full booking creation transaction yet"). A reservation stands on its own as the occupancy
 * record; `bookingId` is populated later once Batch 3 wires real booking creation to it.
 *
 * ONE DOCUMENT PER (businessId, staffMembershipId, occupancyDate) — occupancyDate is the
 * Staff's Business-local calendar date (see common/time/business-clock.ts), never a UTC date.
 * Each document holds every interval that Staff member has reserved that business-local day.
 *
 * WHY ONE DOCUMENT PER STAFF-DAY: MongoDB cannot express "no two rows for the same staff have
 * overlapping [startAt, endAt) ranges" as a unique index — interval overlap is not a
 * functional-dependency constraint a B-tree index can encode (the audit finding this batch
 * fixes: "a unique index only on startAt is NOT enough"). The two genuinely correct strategies
 * are (a) discretize time into fixed buckets, each with its own uniquely-indexed row, or (b)
 * make the write atomic at the single-document level via a filter that re-validates
 * non-overlap against the document's CURRENT state. This module uses (b):
 * BookingSlotReservationRepository.createInterval performs one atomic `findOneAndUpdate` whose
 * FILTER includes a negated `$elemMatch` over `intervals` ("no existing interval overlaps
 * [startAt, endAt)") and whose UPDATE pushes the new interval — one indivisible storage-engine
 * operation. MongoDB guarantees no other write interleaves between evaluating that filter and
 * applying that update on the same document, so two concurrent attempts at genuinely
 * overlapping ranges can never both succeed. Unlike a discretized-bucket scheme, this supports
 * service durations/buffers of ANY integer-minute length, not just multiples of a fixed bucket.
 *
 * CAPACITY (PER_PERSON / group services): an interval's `capacityMax` is 1 for an exclusive
 * (non-group) service, set once at creation. A group interval's `capacityMax` is the Service's
 * own maxPersons; later joiners atomically increment `capacityUsed` via a *separate*,
 * arrayFilter-targeted update (BookingSlotReservationRepository.joinCapacity) that never
 * re-checks interval overlap — the interval's non-overlap was already proven once, at creation.
 *
 * IDEMPOTENCY: deliberately NOT enforced by a unique index nested inside this document's own
 * `intervals` array. An earlier design tried a multikey unique index on
 * `intervals.claims.idempotencyKey` (a scalar nested two array-levels deep: intervals[].claims[]
 * .idempotencyKey) and — confirmed empirically against a real `mongodb-memory-server` instance,
 * not merely suspected — MongoDB does NOT reliably enforce uniqueness across documents for a
 * doubly-nested multikey path; a duplicate key silently succeeded. Idempotency is instead
 * enforced by a flat, single-level unique index on a *separate* collection
 * (BookingSlotReservationClaimModel, see booking-slot-reservation-claim.model.ts) — the most
 * basic, unambiguously-reliable form of MongoDB uniqueness. See
 * BookingSlotReservationService.reserveOrJoin for how the two collections compose.
 *
 * CROSS-MIDNIGHT: deliberately REJECTED, not split across two day-documents. AUTO-mode slots
 * can never cross a business-local midnight (they only ever fit inside a same-day opening
 * interval, and BusinessOpeningHours slots themselves cannot cross midnight by construction).
 * Only a MANUAL-schedule service configured very late in the day could theoretically produce
 * one. Splitting a single occupied interval across two day-documents would reintroduce exactly
 * the "read one document, can't atomically prove non-overlap" problem this whole design exists
 * to avoid (a genuine conflict spanning both documents cannot be checked-and-written as one
 * atomic operation without a real multi-document transaction, which loses this scheme's
 * lock-free performance for the overwhelming common case). Given how rare the edge case is,
 * BookingSlotReservationService.reserveOrJoin explicitly rejects any interval whose startAt and
 * endAt fall on different Business-local calendar dates rather than silently mishandling it —
 * a documented, deliberate limitation (see the Batch 2 final report), not an oversight.
 */
export type BookingSlotReservationInterval = {
  /** The caller's stable handle for this occupied interval/session — used both to join
   * capacity on it and (Batch 3) to link it to a real Booking. Freshly generated per
   * reservation, never a client-supplied value. */
  reservationId: Types.ObjectId;
  serviceId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  capacityMax: number;
  capacityUsed: number;
  bookingId?: Types.ObjectId | undefined;
  status: BookingSlotReservationStatus;
  createdAt: Date;
};

export type BookingSlotReservationDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  /** Canonical "YYYY-MM-DD", Business-local (see common/time/business-clock.ts) — never UTC. */
  occupancyDate: string;
  /** Snapshot of the IANA zone occupancyDate was computed in — audit/debug aid, not re-derived
   * from a live Business lookup on every read. */
  timezone: string;
  intervals: BookingSlotReservationInterval[];
  createdAt: Date;
  updatedAt: Date;
};

const intervalSchema = new Schema<BookingSlotReservationInterval>(
  {
    reservationId: { type: Schema.Types.ObjectId, required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    capacityMax: { type: Number, required: true, min: 1, validate: Number.isInteger },
    capacityUsed: { type: Number, required: true, min: 1, validate: Number.isInteger },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    status: { type: String, enum: bookingSlotReservationStatuses, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

// Defense in depth for the direct `.save()`/`Model.create()` path (used by this module's own
// tests to prove the schema's own shape constraints) — NOTE: MongoDB update-validators
// (`runValidators` on `findOneAndUpdate`) do NOT run Mongoose document middleware like this
// hook, only SchemaType-level field validators. The real write path
// (BookingSlotReservationRepository.createInterval/joinCapacity) is a `findOneAndUpdate`, so
// its correctness comes from the service layer computing startAt/endAt/capacityUsed/capacityMax
// correctly before ever building the update — never from this hook firing on that path. This
// hook still guards any code that constructs/saves a document directly.
intervalSchema.pre("validate", function () {
  const interval = this as unknown as BookingSlotReservationInterval;

  if (interval.endAt <= interval.startAt) {
    throw new Error("Reservation interval endAt must be after startAt");
  }

  if (interval.capacityUsed > interval.capacityMax) {
    throw new Error("Reservation interval capacityUsed cannot exceed capacityMax");
  }
});

const bookingSlotReservationSchema = new Schema<BookingSlotReservationDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    staffMembershipId: { type: Schema.Types.ObjectId, ref: "StaffMembership", required: true },
    occupancyDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    timezone: { type: String, required: true },
    intervals: { type: [intervalSchema], required: true, default: [] },
  },
  { timestamps: true },
);

// One document per Staff member per Business-local day — also the target of the create-race in
// BookingSlotReservationRepository.ensureDayDocument (E11000 here is the expected/handled
// signal that a concurrent request just created the day-document first; see that method).
bookingSlotReservationSchema.index(
  { businessId: 1, staffMembershipId: 1, occupancyDate: 1 },
  { unique: true },
);

// The Availability Engine's own read pattern — every reservation for a set of staff overlapping
// a requested date range, batched (see AvailabilityService) — is already fully covered by the
// unique index above (businessId + staffMembershipId prefix, occupancyDate range).

export const BookingSlotReservationModel = model<BookingSlotReservationDocument>(
  "BookingSlotReservation",
  bookingSlotReservationSchema,
);
