import type { ClientSession } from "mongoose";
import mongoose, { Types } from "mongoose";

import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import { BookingSlotReservationError } from "./booking-slot-reservation.errors.js";
import type {
  BookingSlotReservationDocument,
  BookingSlotReservationInterval,
} from "./booking-slot-reservation.model.js";
import type { BookingSlotReservationRepository } from "./booking-slot-reservation.repository.js";
import {
  type PackageInitialReservationOperation,
  packageInitialReservationOperationSchema,
} from "./reservation-operation.js";

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
  /** Future server-correlated initial Package writer only; never a public actor/consent proof. */
  packageOperation?: PackageInitialReservationOperation | undefined;
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

/** Canonical party effects and occupancy share the caller's transaction. Calls without
 * a session own a transaction here. No external effects run inside either callback. */
export class BookingSlotReservationService {
  public constructor(private readonly reservationRepository: BookingSlotReservationRepository) {}

  /** Replays verify immutable intent then read the actual APPLIED target. Historical
   * no-effect claims retain B1 creator-only evidence; they never authorize another write. */
  public async reserveOrJoin(
    input: ReserveSlotInput,
    session?: ClientSession,
  ): Promise<ReservationResult> {
    input = {
      ...input,
      startAt: new Date(input.startAt.getTime()),
      endAt: new Date(input.endAt.getTime()),
      ...(input.packageOperation
        ? {
            packageOperation: packageInitialReservationOperationSchema.parse(
              input.packageOperation,
            ),
          }
        : {}),
    };
    this.requireValidInterval(input.startAt, input.endAt, input.partySize, input.capacityMax);
    // One initial Package appointment always contributes one seat. The structured
    // operation is correlation, not permission for a larger ordinary party.
    if (input.packageOperation && input.partySize !== 1)
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);

    const occupancyDate = utcToBusinessLocalDate(input.timezone, input.startAt).dateStr;
    const endOccupancyDate = utcToBusinessLocalDate(input.timezone, input.endAt).dateStr;

    if (occupancyDate !== endOccupancyDate) {
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CROSSES_MIDNIGHT", 422);
    }

    if (!session) return this.inOwnedTransaction((owned) => this.reserveOrJoin(input, owned));
    if (!session.inTransaction())
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);

    const claim = await this.reservationRepository.claimIdempotencyKey(
      {
        idempotencyKey: input.idempotencyKey,
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        occupancyDate,
        serviceId: input.serviceId,
        reservationId: new Types.ObjectId(),
        partySize: input.partySize,
        originalIntent: {
          version: 1,
          startAt: input.startAt,
          endAt: input.endAt,
          timezone: input.timezone,
          capacityMax: input.capacityMax,
          ...(input.packageOperation ? { packageOperation: input.packageOperation } : {}),
        },
      },
      session,
    );
    const reservationId = claim.reservationId;

    // Existing claims never authorize new create/join work. In particular a group
    // joiner's unused pinned ID is NOT evidence that its capacity was never applied.
    if (!claim.isNew) {
      const operation = await this.reservationRepository.findOperation(
        input.idempotencyKey,
        session,
      );
      if (!operation)
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
      if (operation.effect) {
        if (
          operation.effect.state !== "APPLIED" ||
          (operation.effect.role === "CREATOR" &&
            !operation.reservationId.equals(operation.effect.actualReservationId))
        )
          throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
        const actual = await this.reservationRepository.findIntervalByReservationId(
          input.businessId,
          input.staffMembershipId,
          occupancyDate,
          operation.effect.actualReservationId,
          session,
        );
        if (!actual || actual.capacityUsed < input.partySize)
          throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
        this.assertExistingIntent(input, actual);
        return this.toResultFromParts(
          input.businessId,
          input.staffMembershipId,
          occupancyDate,
          actual,
        );
      }
      // A concurrent creator may still be finishing. Bounded reads can observe its
      // result; absence never authorizes another write or a repeated group join.
      for (let attempt = 0; attempt < MAX_RESERVE_OR_JOIN_ATTEMPTS; attempt += 1) {
        const own = await this.reservationRepository.findIntervalByReservationId(
          input.businessId,
          input.staffMembershipId,
          occupancyDate,
          reservationId,
          session,
        );
        if (!own) continue;
        this.assertExistingIntent(input, own);
        return this.toResultFromParts(
          input.businessId,
          input.staffMembershipId,
          occupancyDate,
          own,
        );
      }
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
    }

    await this.reservationRepository.ensureDayDocument(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.timezone,
      session,
    );

    for (let attempt = 0; attempt < MAX_RESERVE_OR_JOIN_ATTEMPTS; attempt += 1) {
      const own = await this.reservationRepository.findIntervalByReservationId(
        input.businessId,
        input.staffMembershipId,
        occupancyDate,
        reservationId,
        session,
      );
      if (own) throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);

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
          await this.reservationRepository.recordEffect(
            input.idempotencyKey,
            {
              version: 1,
              actualReservationId: interval.reservationId,
              role: "CREATOR",
              state: "APPLIED",
            },
            session,
          );
          return this.toResult(created, interval);
        }
      }

      const matching = await this.findExactMatchingInterval(input, occupancyDate, session);

      if (matching && !matching.reservationId.equals(reservationId)) {
        if (matching.capacityMax !== input.capacityMax)
          throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
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
            await this.reservationRepository.recordEffect(
              input.idempotencyKey,
              {
                version: 1,
                actualReservationId: interval.reservationId,
                role: "JOINER",
                state: "APPLIED",
              },
              session,
            );
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

  /** Internal owned-Booking call only. Keys select canonical operations, not actors.
   * Historical unkeyed exclusive release is retained; ambiguous Group release fails closed. */
  public async release(
    input: {
      businessId: Types.ObjectId;
      staffMembershipId: Types.ObjectId;
      timezone: string;
      startAt: Date;
      reservationId: Types.ObjectId;
      partySize: number;
      idempotencyKey?: string | undefined;
    },
    session?: ClientSession,
  ): Promise<{ released: boolean; alreadyReleased: boolean }> {
    input = { ...input, startAt: new Date(input.startAt.getTime()) };
    if (!session) return this.inOwnedTransaction((owned) => this.release(input, owned));
    if (!session.inTransaction())
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    const occupancyDate = utcToBusinessLocalDate(input.timezone, input.startAt).dateStr;
    const operation = input.idempotencyKey
      ? await this.reservationRepository.findOperation(input.idempotencyKey, session)
      : null;
    if (input.idempotencyKey && !operation)
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    if (
      operation &&
      (!operation.businessId.equals(input.businessId) ||
        !operation.staffMembershipId.equals(input.staffMembershipId) ||
        operation.occupancyDate !== occupancyDate ||
        operation.partySize !== input.partySize ||
        (operation.originalIntent &&
          (operation.originalIntent.timezone !== input.timezone ||
            operation.originalIntent.startAt.getTime() !== input.startAt.getTime())))
    )
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    if (operation?.effect) {
      if (!operation.effect.actualReservationId.equals(input.reservationId))
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
      if (operation.effect.state === "RELEASED") return { released: false, alreadyReleased: true };
      const interval = await this.reservationRepository.findIntervalByReservationId(
        input.businessId,
        input.staffMembershipId,
        occupancyDate,
        input.reservationId,
        session,
      );
      if (!interval || !operation.originalIntent)
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
      this.assertExistingIntent(
        {
          serviceId: operation.serviceId,
          startAt: operation.originalIntent.startAt,
          endAt: operation.originalIntent.endAt,
          capacityMax: operation.originalIntent.capacityMax,
        },
        interval,
      );
      const released = await this.reservationRepository.releaseInterval(
        input.businessId,
        input.staffMembershipId,
        occupancyDate,
        input.reservationId,
        operation.partySize,
        session,
      );
      if (!released)
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
      await this.reservationRepository.recordEffect(
        operation.idempotencyKey,
        {
          version: 1,
          actualReservationId: input.reservationId,
          role: operation.effect.role,
          state: "RELEASED",
        },
        session,
      );
      return { released: true, alreadyReleased: false };
    }
    // An unkeyed caller cannot decrement new membership. Historical Group parties
    // cannot be identified from pooled usage; no backfill or guessed decrement.
    if (
      await this.reservationRepository.hasEffectForInterval(
        input.businessId,
        input.reservationId,
        session,
      )
    )
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    const interval = await this.reservationRepository.findIntervalByReservationId(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.reservationId,
      session,
    );
    // Absence proves neither which historical party released nor whether it was
    // ever applied. Only a retained RELEASED effect authorizes that response.
    if (!interval)
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    if (
      interval.capacityMax !== 1 ||
      input.partySize !== 1 ||
      (operation && !operation.reservationId.equals(input.reservationId))
    )
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    const released = await this.reservationRepository.releaseInterval(
      input.businessId,
      input.staffMembershipId,
      occupancyDate,
      input.reservationId,
      1,
      session,
    );
    if (!released)
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_RELEASE_INVALID", 409);
    return { released: true, alreadyReleased: false };
  }

  private async inOwnedTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    let callbackCompleted = false;
    try {
      return await session.withTransaction(async () => {
        callbackCompleted = false;
        const result = await work(session);
        callbackCompleted = true;
        return result;
      });
    } catch (error) {
      // Preserve evidence after any completed callback or structured unknown result.
      // A later matching call reads the committed effect; absence never triggers cleanup.
      if (
        callbackCompleted ||
        (error &&
          typeof error === "object" &&
          "hasErrorLabel" in error &&
          typeof error.hasErrorLabel === "function" &&
          error.hasErrorLabel("UnknownTransactionCommitResult"))
      )
        throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 503);
      throw error;
    } finally {
      await session.endSession().catch(() => undefined);
    }
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

  private assertExistingIntent(
    input: Pick<ReserveSlotInput, "serviceId" | "startAt" | "endAt" | "capacityMax">,
    interval: BookingSlotReservationInterval,
  ) {
    if (
      String(interval.serviceId) !== String(input.serviceId) ||
      interval.startAt.getTime() !== input.startAt.getTime() ||
      interval.endAt.getTime() !== input.endAt.getTime() ||
      interval.capacityMax !== input.capacityMax
    )
      throw new BookingSlotReservationError("BOOKING_SLOT_RESERVATION_CONFLICT", 409);
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
