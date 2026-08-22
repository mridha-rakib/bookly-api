import type { ClientSession, Types } from "mongoose";
import {
  type BookingSlotReservationDocument,
  type BookingSlotReservationInterval,
  BookingSlotReservationModel,
} from "./booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "./booking-slot-reservation-claim.model.js";

export type ClaimIdempotencyKeyInput = {
  idempotencyKey: string;
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  occupancyDate: string;
  serviceId: Types.ObjectId;
  reservationId: Types.ObjectId;
  partySize: number;
};

export type ClaimIdempotencyKeyResult = {
  /** true only the very first time this key was ever claimed — false means an existing claim
   * (this call's own retry, or a concurrent racer that won) was returned instead. */
  isNew: boolean;
  reservationId: Types.ObjectId;
};

export type CreateIntervalInput = {
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  occupancyDate: string;
  timezone: string;
  reservationId: Types.ObjectId;
  serviceId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  capacityMax: number;
  partySize: number;
};

export type JoinCapacityInput = {
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  occupancyDate: string;
  reservationId: Types.ObjectId;
  /** The interval's own capacityMax, as read by the caller immediately before this call —
   * capacityMax is fixed at interval creation and never modified afterward, so this is safe
   * to trust; see joinCapacity's own comment for why the ceiling check is expressed this way. */
  capacityMax: number;
  partySize: number;
};

export class BookingSlotReservationRepository {
  /**
   * The idempotency entry point (see booking-slot-reservation-claim.model.ts). Atomically
   * assigns `reservationId` to `idempotencyKey` the first time this key is ever seen; every
   * later call with the same key — genuine retry or concurrent race — deterministically
   * recovers that same `reservationId` instead of risking a second one. Relies solely on the
   * claim collection's single-level unique index, never the reservation document itself.
   */
  public async claimIdempotencyKey(
    input: ClaimIdempotencyKeyInput,
    session?: ClientSession,
  ): Promise<ClaimIdempotencyKeyResult> {
    try {
      await new BookingSlotReservationClaimModel({
        idempotencyKey: input.idempotencyKey,
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        occupancyDate: input.occupancyDate,
        serviceId: input.serviceId,
        reservationId: input.reservationId,
        partySize: input.partySize,
      }).save(session ? { session } : undefined);
      return { isNew: true, reservationId: input.reservationId };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      const query = BookingSlotReservationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      });
      if (session) {
        query.session(session);
      }
      const existing = await query.orFail();
      return { isNew: false, reservationId: existing.reservationId };
    }
  }

  /**
   * Unconditional upsert-if-missing for the day-document — never touches `intervals`. Its own
   * create-race (two concurrent first-reservations-of-the-day for the same staff) is resolved
   * by the unique `{businessId,staffMembershipId,occupancyDate}` index: the losing caller gets
   * E11000, which this method catches and resolves by re-reading the now-existing document —
   * always converges in at most one retry, since this filter has no interval condition to keep
   * conflicting on (unlike createInterval below).
   */
  public async ensureDayDocument(
    businessId: Types.ObjectId,
    staffMembershipId: Types.ObjectId,
    occupancyDate: string,
    timezone: string,
    session?: ClientSession,
  ): Promise<BookingSlotReservationDocument> {
    try {
      return await BookingSlotReservationModel.findOneAndUpdate(
        { businessId, staffMembershipId, occupancyDate },
        { $setOnInsert: { businessId, staffMembershipId, occupancyDate, timezone, intervals: [] } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          ...(session ? { session } : {}),
        },
      ).orFail();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const query = BookingSlotReservationModel.findOne({
          businessId,
          staffMembershipId,
          occupancyDate,
        });
        if (session) {
          query.session(session);
        }
        return await query.orFail();
      }

      throw error;
    }
  }

  /**
   * Finds an interval by its reservationId — the fast idempotent-retry path: once a caller has
   * a claimed reservationId (see claimIdempotencyKey), it checks here first before ever
   * attempting create/join again.
   */
  public async findIntervalByReservationId(
    businessId: Types.ObjectId,
    staffMembershipId: Types.ObjectId,
    occupancyDate: string,
    reservationId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<BookingSlotReservationInterval | null> {
    const query = BookingSlotReservationModel.findOne({
      businessId,
      staffMembershipId,
      occupancyDate,
      "intervals.reservationId": reservationId,
    });
    if (session) {
      query.session(session);
    }
    const doc = await query.exec();

    return doc?.intervals.find((entry) => entry.reservationId.equals(reservationId)) ?? null;
  }

  /**
   * The core conflict-safety primitive (see booking-slot-reservation.model.ts's own doc
   * comment for why this is safe under concurrency). Requires the day-document to already
   * exist (call ensureDayDocument first) — this method never upserts, so a `null` result here
   * is unambiguous: a genuinely overlapping interval already occupies this staff member for
   * some portion of [startAt, endAt), never a missing-document race.
   */
  public async createInterval(
    input: CreateIntervalInput,
    session?: ClientSession,
  ): Promise<BookingSlotReservationDocument | null> {
    const interval: BookingSlotReservationInterval = {
      reservationId: input.reservationId,
      serviceId: input.serviceId,
      startAt: input.startAt,
      endAt: input.endAt,
      capacityMax: input.capacityMax,
      capacityUsed: input.partySize,
      status: "CONFIRMED",
      createdAt: new Date(),
    };

    return BookingSlotReservationModel.findOneAndUpdate(
      {
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        occupancyDate: input.occupancyDate,
        intervals: {
          $not: {
            $elemMatch: {
              startAt: { $lt: input.endAt },
              endAt: { $gt: input.startAt },
            },
          },
        },
      },
      { $push: { intervals: interval } },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /**
   * Joins an already-reserved capacity interval (a group/PER_PERSON session) — never
   * re-checks interval overlap, only the capacity ceiling, via an `arrayFilters`-targeted,
   * single-document atomic update. A `null` result means either the interval doesn't exist
   * (bad reservationId) or the ceiling would be exceeded — the caller distinguishes those by
   * re-reading if it needs to (see BookingSlotReservationService.joinCapacity).
   *
   * The ceiling check is expressed as `capacityUsed <= capacityMax - partySize` — a plain
   * comparison against a value computed in the caller before this call, NOT
   * `capacityUsed + partySize <= capacityMax` evaluated via `$expr` against the document's own
   * `capacityMax` field: MongoDB does not permit `$expr` inside `arrayFilters` at all ("$expr
   * is not allowed in this context", confirmed against the real server in this module's
   * integration tests). This is still fully atomic and race-free — MongoDB evaluates the
   * comparison against the CURRENT stored `capacityUsed` at write time, one indivisible
   * operation — and safe to compute the bound from a prior read because capacityMax is fixed
   * at interval creation and never modified afterward (see JoinCapacityInput's own comment).
   *
   * The ceiling condition appears TWICE — once in `arrayFilters` (to target the right element
   * for `$inc`) and once again as a top-level `$elemMatch` in the main filter. This is not
   * redundant: confirmed empirically (this module's own concurrency tests caught it) that when
   * an `arrayFilters` condition matches zero elements, `findOneAndUpdate` still matches and
   * returns the outer document *unchanged* — it does not fail the whole operation the way a
   * naive reading of "atomic conditional update" would suggest. Without the top-level
   * `$elemMatch` gate, a full-capacity join would silently no-op the `$inc` while this method
   * still returned a non-null "success" result, over-admitting capacity. With it, a
   * would-be-no-op correctly makes the ENTIRE filter fail to match, so this returns `null`,
   * exactly like every other conflict case in this module.
   */
  public async joinCapacity(
    input: JoinCapacityInput,
    session?: ClientSession,
  ): Promise<BookingSlotReservationDocument | null> {
    return BookingSlotReservationModel.findOneAndUpdate(
      {
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        occupancyDate: input.occupancyDate,
        intervals: {
          $elemMatch: {
            reservationId: input.reservationId,
            capacityUsed: { $lte: input.capacityMax - input.partySize },
          },
        },
      },
      {
        $inc: { "intervals.$[iv].capacityUsed": input.partySize },
      },
      {
        arrayFilters: [
          {
            "iv.reservationId": input.reservationId,
            "iv.capacityUsed": { $lte: input.capacityMax - input.partySize },
          },
        ],
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      },
    ).exec();
  }

  /** The Availability Engine's batched read: every reservation document for a set of staff
   * whose occupancyDate falls within the requested (already-bounded) range — one query
   * regardless of how many staff or how many days are being checked. */
  public async findManyForStaffInDateRange(
    businessId: Types.ObjectId,
    staffMembershipIds: Types.ObjectId[],
    dateStrings: string[],
    session?: ClientSession,
  ): Promise<BookingSlotReservationDocument[]> {
    if (staffMembershipIds.length === 0 || dateStrings.length === 0) {
      return [];
    }

    const query = BookingSlotReservationModel.find({
      businessId,
      staffMembershipId: { $in: staffMembershipIds },
      occupancyDate: { $in: dateStrings },
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  /**
   * The release/cancel counterpart to createInterval/joinCapacity (Batch 3, deliberately
   * deferred by Batch 2 — nothing needed to release a reservation until real Booking
   * cancellation existed). Two atomic steps, both safe to call within an outer Booking-
   * cancellation transaction via `session`:
   *
   *  1. Decrement `capacityUsed` by `partySize`, gated (top-level `$elemMatch` + matching
   *     `arrayFilters`, the exact double-check pattern joinCapacity's own comment documents —
   *     see that method) so capacityUsed can never go negative: the gate requires
   *     `capacityUsed >= partySize` before the decrement applies at all.
   *  2. Unconditionally attempt to `$pull` the interval once its capacityUsed has reached
   *     exactly 0 — safe to run even when step 1 changed nothing (a no-op `$pull` is not an
   *     error), so this method never needs a separate "was it just emptied" read.
   *
   * Returns `true` only when step 1 actually matched and decremented something on THIS call —
   * the caller (BookingSlotReservationService.release) uses that to distinguish "really
   * released just now" from "already released" for idempotent-retry callers, without this
   * method itself needing to interpret idempotency.
   */
  public async releaseInterval(
    businessId: Types.ObjectId,
    staffMembershipId: Types.ObjectId,
    occupancyDate: string,
    reservationId: Types.ObjectId,
    partySize: number,
    session?: ClientSession,
  ): Promise<boolean> {
    const decremented = await BookingSlotReservationModel.findOneAndUpdate(
      {
        businessId,
        staffMembershipId,
        occupancyDate,
        intervals: {
          $elemMatch: { reservationId, capacityUsed: { $gte: partySize } },
        },
      },
      { $inc: { "intervals.$[iv].capacityUsed": -partySize } },
      {
        arrayFilters: [
          { "iv.reservationId": reservationId, "iv.capacityUsed": { $gte: partySize } },
        ],
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      },
    ).exec();

    if (!decremented) {
      return false;
    }

    await BookingSlotReservationModel.updateOne(
      { businessId, staffMembershipId, occupancyDate },
      { $pull: { intervals: { reservationId, capacityUsed: 0 } } },
      session ? { session } : undefined,
    ).exec();

    return true;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
