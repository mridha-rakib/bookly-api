import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean; sparse?: boolean };

const TIMEZONE = "Europe/Nicosia";

describe("database-backed BookingSlotReservation integration (concurrency-critical)", () => {
  let repository: BookingSlotReservationRepository;
  let service: BookingSlotReservationService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    repository = new BookingSlotReservationRepository();
    service = new BookingSlotReservationService(repository);
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const exclusiveInput = (overrides: Record<string, unknown> = {}) => ({
    businessId: new Types.ObjectId(),
    staffMembershipId: new Types.ObjectId(),
    serviceId: new Types.ObjectId(),
    timezone: TIMEZONE,
    startAt: new Date("2026-08-25T09:00:00.000Z"),
    endAt: new Date("2026-08-25T10:00:00.000Z"),
    capacityMax: 1,
    partySize: 1,
    idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    ...overrides,
  });

  // --- Indexes ------------------------------------------------------------------------------

  it("enforces one day-document per (business, staff, occupancyDate) and unique claim idempotency keys", async () => {
    const indexes = (await BookingSlotReservationModel.collection.indexes()) as DbIndex[];

    const dayIndex = indexes.find(
      (index) =>
        index.key["businessId"] === 1 &&
        index.key["staffMembershipId"] === 1 &&
        index.key["occupancyDate"] === 1,
    );
    expect(dayIndex?.unique).toBe(true);

    const claimIndexes = (await BookingSlotReservationClaimModel.collection.indexes()) as DbIndex[];
    const claimIndex = claimIndexes.find((index) => index.key["idempotencyKey"] === 1);
    expect(claimIndex?.unique).toBe(true);
  });

  // --- Basic correctness ----------------------------------------------------------------------

  it("reserves a fresh exclusive slot", async () => {
    const input = exclusiveInput();
    const result = await service.reserveOrJoin(input);

    expect(result.capacityUsed).toBe(1);
    expect(result.capacityMax).toBe(1);
    expect(result.occupancyDate).toBe("2026-08-25");

    const stored = await BookingSlotReservationModel.findOne({
      businessId: input.businessId,
      staffMembershipId: input.staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
  });

  it("rejects a reservation crossing a business-local midnight boundary", async () => {
    // 23:30 -> 01:00 Europe/Nicosia (UTC+3 in August): starts on Aug 25 local, ends Aug 26 local.
    const input = exclusiveInput({
      startAt: new Date("2026-08-25T20:30:00.000Z"),
      endAt: new Date("2026-08-25T22:00:00.000Z"),
    });

    await expect(service.reserveOrJoin(input)).rejects.toMatchObject({ statusCode: 422 });

    expect(await BookingSlotReservationModel.countDocuments({ businessId: input.businessId })).toBe(
      0,
    );
  });

  it("idempotent retry with the same key does not double-reserve", async () => {
    const input = exclusiveInput();

    const first = await service.reserveOrJoin(input);
    const second = await service.reserveOrJoin(input);

    expect(second.reservationId.equals(first.reservationId)).toBe(true);

    const stored = await BookingSlotReservationModel.findOne({
      businessId: input.businessId,
      staffMembershipId: input.staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
    expect(
      await BookingSlotReservationClaimModel.countDocuments({
        idempotencyKey: input.idempotencyKey,
      }),
    ).toBe(1);
  });

  // --- Concurrency race #1: same staff, same exclusive slot ----------------------------------

  it("race 1: same staff, same exclusive slot — exactly one concurrent request succeeds", async () => {
    const base = exclusiveInput();
    const attempts = Array.from({ length: 8 }, () =>
      service.reserveOrJoin({ ...base, idempotencyKey: `key-${new Types.ObjectId().toString()}` }),
    );

    const outcomes = await Promise.allSettled(attempts);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const outcome of rejected) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    }

    const stored = await BookingSlotReservationModel.findOne({
      businessId: base.businessId,
      staffMembershipId: base.staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
  });

  // --- Concurrency race #2: overlapping slots, different starts ------------------------------

  it("race 2: overlapping slots with different starts — final state has no two overlapping intervals", async () => {
    const businessId = new Types.ObjectId();
    const staffMembershipId = new Types.ObjectId();
    const serviceId = new Types.ObjectId();

    // A: 09:00-10:00, B: 09:30-10:30 (overlaps A), C: 10:00-11:00 (does NOT overlap A, touches
    // but does not overlap C at the boundary since intervals are half-open [start,end)).
    const candidates = [
      {
        startAt: new Date("2026-08-25T09:00:00.000Z"),
        endAt: new Date("2026-08-25T10:00:00.000Z"),
      },
      {
        startAt: new Date("2026-08-25T09:30:00.000Z"),
        endAt: new Date("2026-08-25T10:30:00.000Z"),
      },
      {
        startAt: new Date("2026-08-25T10:00:00.000Z"),
        endAt: new Date("2026-08-25T11:00:00.000Z"),
      },
    ];

    const outcomes = await Promise.allSettled(
      candidates.map((interval) =>
        service.reserveOrJoin({
          businessId,
          staffMembershipId,
          serviceId,
          timezone: TIMEZONE,
          startAt: interval.startAt,
          endAt: interval.endAt,
          capacityMax: 1,
          partySize: 1,
          idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        }),
      ),
    );

    const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    // A and C never conflict with each other, so the best case is both succeed (B always
    // loses to at least one of them); the worst case is exactly one of the three wins.
    expect(succeeded).toBeGreaterThanOrEqual(1);
    expect(succeeded).toBeLessThanOrEqual(2);

    const stored = await BookingSlotReservationModel.findOne({
      businessId,
      staffMembershipId,
    }).orFail();
    const intervals = [...stored.intervals].sort(
      (a, b) => a.startAt.getTime() - b.startAt.getTime(),
    );
    for (let i = 1; i < intervals.length; i += 1) {
      const previous = intervals[i - 1];
      const current = intervals[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      // No two stored intervals may overlap — the core invariant.
      expect(current!.startAt.getTime()).toBeGreaterThanOrEqual(previous!.endAt.getTime());
    }
  });

  // --- Concurrency race #3: same time, different staff ---------------------------------------

  it("race 3: same time, different staff — both succeed", async () => {
    const businessId = new Types.ObjectId();
    const serviceId = new Types.ObjectId();
    const staffA = new Types.ObjectId();
    const staffB = new Types.ObjectId();
    const startAt = new Date("2026-08-25T09:00:00.000Z");
    const endAt = new Date("2026-08-25T10:00:00.000Z");

    const outcomes = await Promise.allSettled([
      service.reserveOrJoin({
        businessId,
        staffMembershipId: staffA,
        serviceId,
        timezone: TIMEZONE,
        startAt,
        endAt,
        capacityMax: 1,
        partySize: 1,
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      }),
      service.reserveOrJoin({
        businessId,
        staffMembershipId: staffB,
        serviceId,
        timezone: TIMEZONE,
        startAt,
        endAt,
        capacityMax: 1,
        partySize: 1,
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
  });

  // --- Concurrency race #5/#6: capacity ceiling + final-seat boundary ------------------------

  it("race 5+6: parallel party-size reservations never exceed maxPersons; the final seat goes to exactly one racer", async () => {
    const businessId = new Types.ObjectId();
    const staffMembershipId = new Types.ObjectId();
    const serviceId = new Types.ObjectId();
    const startAt = new Date("2026-08-25T09:00:00.000Z");
    const endAt = new Date("2026-08-25T10:00:00.000Z");
    const capacityMax = 5;

    // 8 concurrent parties of size 1 each racing for 5 total seats — expect exactly 5 to
    // succeed (including the one that consumes the final seat) and 3 to fail as capacity
    // exhausted, with the stored capacityUsed never exceeding capacityMax.
    const attempts = Array.from({ length: 8 }, () =>
      service.reserveOrJoin({
        businessId,
        staffMembershipId,
        serviceId,
        timezone: TIMEZONE,
        startAt,
        endAt,
        capacityMax,
        partySize: 1,
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      }),
    );

    const outcomes = await Promise.allSettled(attempts);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(capacityMax);
    expect(rejected).toHaveLength(8 - capacityMax);
    for (const outcome of rejected) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    }

    const stored = await BookingSlotReservationModel.findOne({
      businessId,
      staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
    expect(stored.intervals[0]?.capacityUsed).toBeLessThanOrEqual(stored.intervals[0]!.capacityMax);
    expect(stored.intervals[0]?.capacityUsed).toBe(capacityMax);
  });

  it("a party larger than the remaining capacity is rejected without partially consuming it", async () => {
    const businessId = new Types.ObjectId();
    const staffMembershipId = new Types.ObjectId();
    const serviceId = new Types.ObjectId();
    const startAt = new Date("2026-08-25T09:00:00.000Z");
    const endAt = new Date("2026-08-25T10:00:00.000Z");

    await service.reserveOrJoin({
      businessId,
      staffMembershipId,
      serviceId,
      timezone: TIMEZONE,
      startAt,
      endAt,
      capacityMax: 5,
      partySize: 3,
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    // 3 used, 2 remaining — a party of 3 must be rejected outright, not partially applied.
    await expect(
      service.reserveOrJoin({
        businessId,
        staffMembershipId,
        serviceId,
        timezone: TIMEZONE,
        startAt,
        endAt,
        capacityMax: 5,
        partySize: 3,
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const stored = await BookingSlotReservationModel.findOne({
      businessId,
      staffMembershipId,
    }).orFail();
    expect(stored.intervals[0]?.capacityUsed).toBe(3);
  });

  // --- Concurrency race #7: idempotent retry under real concurrency --------------------------

  it("race 7: the same idempotency key retried concurrently never consumes capacity twice", async () => {
    const input = exclusiveInput({ capacityMax: 3, partySize: 1 });

    const outcomes = await Promise.allSettled([
      service.reserveOrJoin(input),
      service.reserveOrJoin(input),
      service.reserveOrJoin(input),
      service.reserveOrJoin(input),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const results = outcomes.map(
      (outcome) =>
        (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof service.reserveOrJoin>>>)
          .value,
    );
    const reservationIds = new Set(results.map((result) => String(result.reservationId)));
    expect(reservationIds.size).toBe(1);

    const stored = await BookingSlotReservationModel.findOne({
      businessId: input.businessId,
      staffMembershipId: input.staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
    expect(stored.intervals[0]?.capacityUsed).toBe(1);
    expect(
      await BookingSlotReservationClaimModel.countDocuments({
        idempotencyKey: input.idempotencyKey,
      }),
    ).toBe(1);
  });

  // --- Group session: first party creates, later parties join ---------------------------------

  it("a second party can join an already-reserved group session at the exact same session identity", async () => {
    const businessId = new Types.ObjectId();
    const staffMembershipId = new Types.ObjectId();
    const serviceId = new Types.ObjectId();
    const startAt = new Date("2026-08-25T09:00:00.000Z");
    const endAt = new Date("2026-08-25T10:00:00.000Z");

    const first = await service.reserveOrJoin({
      businessId,
      staffMembershipId,
      serviceId,
      timezone: TIMEZONE,
      startAt,
      endAt,
      capacityMax: 10,
      partySize: 2,
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    const second = await service.reserveOrJoin({
      businessId,
      staffMembershipId,
      serviceId,
      timezone: TIMEZONE,
      startAt,
      endAt,
      capacityMax: 10,
      partySize: 3,
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    expect(second.reservationId.equals(first.reservationId)).toBe(true);
    expect(second.capacityUsed).toBe(5);

    const stored = await BookingSlotReservationModel.findOne({
      businessId,
      staffMembershipId,
    }).orFail();
    expect(stored.intervals).toHaveLength(1);
  });

  it("does not let a group session's staff-occupied interval overlap a different, non-matching booking", async () => {
    const businessId = new Types.ObjectId();
    const staffMembershipId = new Types.ObjectId();
    const groupServiceId = new Types.ObjectId();
    const otherServiceId = new Types.ObjectId();
    const startAt = new Date("2026-08-25T09:00:00.000Z");
    const endAt = new Date("2026-08-25T10:00:00.000Z");

    await service.reserveOrJoin({
      businessId,
      staffMembershipId,
      serviceId: groupServiceId,
      timezone: TIMEZONE,
      startAt,
      endAt,
      capacityMax: 10,
      partySize: 2,
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    // A different, exclusive 1:1 service for the SAME staff, overlapping the group session's
    // interval — must be rejected, proving group sessions still occupy the staff timeline.
    await expect(
      service.reserveOrJoin({
        businessId,
        staffMembershipId,
        serviceId: otherServiceId,
        timezone: TIMEZONE,
        startAt: new Date("2026-08-25T09:30:00.000Z"),
        endAt: new Date("2026-08-25T10:30:00.000Z"),
        capacityMax: 1,
        partySize: 1,
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // --- Explain: the day-document lookup uses the unique index --------------------------------

  it("the day-document lookup uses the unique {businessId,staffMembershipId,occupancyDate} index, not a collection scan", async () => {
    const input = exclusiveInput();
    await service.reserveOrJoin(input);

    const explanation = (await BookingSlotReservationModel.find({
      businessId: input.businessId,
      staffMembershipId: input.staffMembershipId,
      occupancyDate: "2026-08-25",
    }).explain("executionStats")) as {
      executionStats?: { executionStages?: { stage?: string; inputStage?: { stage?: string } } };
    };
    const stages = [
      explanation.executionStats?.executionStages?.stage,
      explanation.executionStats?.executionStages?.inputStage?.stage,
    ];
    expect(stages).not.toContain("COLLSCAN");
  });
});
