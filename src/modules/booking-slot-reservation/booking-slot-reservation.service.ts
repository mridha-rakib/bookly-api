import type { ClientSession } from "mongoose";
import { Types } from "mongoose";

import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import { BookingSlotReservationError } from "./booking-slot-reservation.errors.js";
import type {
  BookingSlotReservationDocument,
  BookingSlotReservationInterval,
} from "./booking-slot-reservation.model.js";
import type { BookingSlotReservationRepository } from "./booking-slot-reservation.repository.js";

/** Bounded so heavy contention on one popular group-session slot fails clearly rather than
 * retrying forever — each attempt is a real atomic DB round trip, never a busy-spin. */
const MAX_RESERVE_OR_JOIN_ATTEMPTS = 8;

export type ReserveSlotInput = {
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  serviceId: Types.ObjectId;
  /** Business-local IANA zone the interval was scheduled in — used only to compute
   * occupancyDate; the interval itself is always stored/compared as absolute UTC instants. */
  timezone: string;
  startAt: Date;
  endAt: Date;
  /** 1 for an exclusive (non-group) service. */
  capacityMax: number;
  partySize: number;
  /** Required — every caller must supply a stable key for its own retry safety. Never
   * generated here, since the caller (not this service) is the one that knows whether a given
   * attempt is a fresh request or a retry of an earlier one. */
  idempotencyKey: string;
};

export type ReservationResult = {
  reservationId: Types.ObjectId;
  businessId: Types.ObjectId;
  staffMembershipId: Types.ObjectId;
  occupancyDate: string;
  serviceId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  capacityMax: number;
  capacityUsed: number;
};

/**
 * The conflict-safe reservation foundation (see booking-slot-reservation.model.ts for the full
 * concurrency-correctness argument). Deliberately does NOT create a Booking — see this
 * service's own module doc comment in the model file. Deliberately does NOT implement
 * cancel/release — nothing in this batch needs to release a reservation (no cancellation
 * charging, no full booking lifecycle yet); that is explicit Batch 3 scope.
 */
export class BookingSlotReservationService {
  public constructor(private readonly reservationRepository: BookingSlotReservationRepository) {}

  /**
   * The one entry point real callers (the Availability Engine) should use — handles both an
   * exclusive 1:1 booking and a group/capacity session uniformly, and is fully idempotent.
   *
   * Concurrency-safety story in three layers:
   *  1. IDEMPOTENCY: `claimIdempotencyKey` atomically pins one `reservationId` to this
   *     `idempotencyKey`, collection-wide, via a flat single-level unique index (see
   *     booking-slot-reservation-claim.model.ts). Every call — first attempt, a client's own
   *     retry, or a concurrent duplicate of the identical request — converges on the SAME
   *     reservationId.
   *  2. Every loop iteration checks FIRST whether an interval for that exact reservationId
   *     already exists and returns it immediately if so — this is what makes a retry (or a
   *     race between two copies of the same logical request) idempotent even while the
   *     original attempt is still in flight, not just after it completes.
   *  3. If not yet created, this attempts createInterval (a brand-new session) or, if a
   *     *different* reservationId already occupies the exact same session identity (a
   *     genuinely different customer joining a group session), joinCapacity instead. Both are
   *     single-document atomic operations (see the repository) — a bounded retry loop absorbs
   *     the case where capacity/occupancy changes between the two.
   * For an exclusive (capacityMax=1) service, the join branch can never find room, so this
   * collapses to plain create-or-conflict semantics automatically.
   */
  public async reserveOrJoin(
    input: ReserveSlotInput,
    session?: ClientSession,
  ): Promise<ReservationResult> {
    this.requireValidInterval(input.startAt, input.endAt, input.partySize, input.capacityMax);

    const occupancyDate = utcToBusinessLocalDate(input.timezone, input.startAt).dateStr;
    const endOccupancyDate = utcToBusinessLocalDate(input.timezone, input.endAt).dateStr;

    if (occupancyDate !== endOccupancyDate) {
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CROSSES_MIDNIGHT", 422);
    }

    await this.reservationRepository.ensureDayDocument(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.timezone,
      session,
    );

    const claim = await this.reservationRepository.claimIdempotencyKey(
      {
        idempotencyKey: input.idempotencyKey,
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        occupancyDate,
        serviceId: input.serviceId,
        reservationId: new Types.ObjectId(),
        partySize: input.partySize,
      },
      session,
    );
    const reservationId = claim.reservationId;

    for (let attempt = 0; attempt < MAX_RESERVE_OR_JOIN_ATTEMPTS; attempt += 1) {
      const own = await this.reservationRepository.findIntervalByReservationId(
        input.businessId,
        input.staffMembershipId,
        occupancyDate,
        reservationId,
        session,
      );
      if (own) {
        return this.toResultFromParts(
          input.businessId,
          input.staffMembershipId,
          occupancyDate,
          own,
        );
      }

      const created = await this.reservationRepository.createInterval(
        {
          businessId: input.businessId,
          staffMembershipId: input.staffMembershipId,
          occupancyDate,
          timezone: input.timezone,
          reservationId,
          serviceId: input.serviceId,
          startAt: input.startAt,
          endAt: input.endAt,
          capacityMax: input.capacityMax,
          partySize: input.partySize,
        },
        session,
      );
      if (created) {
        const interval = created.intervals.find((entry) =>
          entry.reservationId.equals(reservationId),
        );
        if (interval) {
          return this.toResult(created, interval);
        }
      }

      const matching = await this.findExactMatchingInterval(input, occupancyDate, session);

      if (matching && !matching.reservationId.equals(reservationId)) {
        if (matching.capacityUsed + input.partySize > matching.capacityMax) {
          throw new BookingSlotReservationError(
            "BOOKING_SLOT_RESERVATION_CAPACITY_UNAVAILABLE",
            409,
          );
        }

        const joined = await this.reservationRepository.joinCapacity(
          {
            businessId: input.businessId,
            staffMembershipId: input.staffMembershipId,
            occupancyDate,
            reservationId: matching.reservationId,
            capacityMax: matching.capacityMax,
            partySize: input.partySize,
          },
          session,
        );

        if (joined) {
          const interval = joined.intervals.find((entry) =>
            entry.reservationId.equals(matching.reservationId),
          );
          if (interval) {
            return this.toResult(joined, interval);
          }
        }

        // Capacity changed underneath us between the read and the write — loop and re-evaluate
        // from scratch rather than assuming either success or failure.
        continue;
      }

      const hasBlockingOverlap = await this.hasOverlapOtherThanOwn(
        input,
        occupancyDate,
        reservationId,
        session,
      );
      if (hasBlockingOverlap) {
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
      }

      // No blocking overlap observed and no exact-match session to join — the state changed
      // between our failed create and this check (another attempt's write landed in between);
      // loop and try again from the top.
    }

    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
  }

  /**
   * The release/cancel counterpart to reserveOrJoin (Batch 3). Idempotent: releasing a
   * reservationId+partySize that has already been fully released (interval no longer present,
   * or already reduced below partySize by an earlier successful release of this exact claim) is
   * treated as a successful no-op, never an error — a Booking-cancellation retry must never fail
   * merely because an earlier attempt already released the slot. Only a genuine misuse (the
   * interval still exists, is still large enough that it could never legitimately have had this
   * partySize subtracted twice, yet the ceiling check still fails) throws.
   */
  public async release(
    input: {
      businessId: Types.ObjectId;
      staffMembershipId: Types.ObjectId;
      timezone: string;
      startAt: Date;
      reservationId: Types.ObjectId;
      partySize: number;
    },
    session?: ClientSession,
  ): Promise<{ released: boolean; alreadyReleased: boolean }> {
    const occupancyDate = utcToBusinessLocalDate(input.timezone, input.startAt).dateStr;

    const released = await this.reservationRepository.releaseInterval(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.reservationId,
      input.partySize,
      session,
    );

    if (released) {
      return { released: true, alreadyReleased: false };
    }

    const stillPresent = await this.reservationRepository.findIntervalByReservationId(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.reservationId,
      session,
    );

    if (!stillPresent) {
      return { released: false, alreadyReleased: true };
    }

    throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
  }

  private async findExactMatchingInterval(
    input: ReserveSlotInput,
    occupancyDate: string,
    session?: ClientSession,
  ): Promise<BookingSlotReservationInterval | null> {
    const docs = await this.reservationRepository.findManyForStaffInDateRange(
      input.businessId,
      [input.staffMembershipId],
      [occupancyDate],
      session,
    );

    const match = docs
      .flatMap((doc) => doc.intervals)
      .find(
        (entry) =>
          entry.serviceId.equals(input.serviceId) &&
          entry.startAt.getTime() === input.startAt.getTime() &&
          entry.endAt.getTime() === input.endAt.getTime(),
      );

    return match ?? null;
  }

  private async hasOverlapOtherThanOwn(
    input: ReserveSlotInput,
    occupancyDate: string,
    ownReservationId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<boolean> {
    const docs = await this.reservationRepository.findManyForStaffInDateRange(
      input.businessId,
      [input.staffMembershipId],
      [occupancyDate],
      session,
    );

    return docs
      .flatMap((doc) => doc.intervals)
      .some(
        (entry) =>
          !entry.reservationId.equals(ownReservationId) &&
          entry.startAt < input.endAt &&
          entry.endAt > input.startAt,
      );
  }

  private requireValidInterval(
    startAt: Date,
    endAt: Date,
    partySize: number,
    capacityMax: number,
  ): void {
    if (endAt <= startAt) {
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_INVALID_INTERVAL", 400);
    }

    if (!Number.isInteger(capacityMax) || capacityMax < 1) {
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_INVALID_INTERVAL", 400);
    }

    if (!Number.isInteger(partySize) || partySize < 1 || partySize > capacityMax) {
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_INVALID_INTERVAL", 400);
    }
  }

  private toResult(
    document: BookingSlotReservationDocument,
    interval: BookingSlotReservationInterval,
  ): ReservationResult {
    return this.toResultFromParts(
      document.businessId,
      document.staffMembershipId,
      document.occupancyDate,
      interval,
    );
  }

  private toResultFromParts(
    businessId: Types.ObjectId,
    staffMembershipId: Types.ObjectId,
    occupancyDate: string,
    interval: BookingSlotReservationInterval,
  ): ReservationResult {
    return {
      reservationId: interval.reservationId,
      businessId,
      staffMembershipId,
      occupancyDate,
      serviceId: interval.serviceId,
      startAt: interval.startAt,
      endAt: interval.endAt,
      capacityMax: interval.capacityMax,
      capacityUsed: interval.capacityUsed,
    };
  }
}
