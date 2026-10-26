import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import {
  type PackageInitialReservationOperation,
  packageInitialReservationKey,
} from "../../../src/modules/booking-slot-reservation/reservation-operation.js";
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

  describe("B2 durable original intent", () => {
    afterEach(() => vi.restoreAllMocks());
    const state = async () => {
      const db = mongoose.connection.db;
      if (!db || mongoose.connection.host !== "127.0.0.1") throw new Error("Owned DB required");
      const rows: Record<string, unknown> = {};
      for (const c of (await db.collections()).sort((a, b) =>
        a.collectionName.localeCompare(b.collectionName),
      ))
        rows[c.collectionName] = await c.find({}).sort({ _id: 1 }).toArray();
      return JSON.stringify(rows);
    };
    it("B2 different timezone context cannot replay even when UTC and local date match", async () => {
      const input = exclusiveInput();
      await service.reserveOrJoin(input);
      const before = await state();
      await expect(service.reserveOrJoin({ ...input, timezone: "UTC" })).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await state()).toBe(before);
    });
    it("B2 retains exact original intent after interval removal without recreating occupancy", async () => {
      const input = exclusiveInput();
      const result = await service.reserveOrJoin(input);
      await service.release({ ...input, reservationId: result.reservationId });
      const claim = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      }).orFail();
      expect(claim.toObject()).toMatchObject({
        originalIntent: {
          version: 1,
          startAt: input.startAt,
          endAt: input.endAt,
          timezone: input.timezone,
          capacityMax: input.capacityMax,
        },
      });
      const before = await state();
      await expect(service.reserveOrJoin(input)).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
    });
    it.each([
      "Service",
      "start",
      "end",
      "Staff",
      "Business",
      "date",
      "timezone",
      "party",
      "capacity",
    ])(
      "B2 retained join intent rejects changed %s before looking for its missing pinned interval",
      async (fault) => {
        const input = exclusiveInput({ capacityMax: 5 });
        await service.reserveOrJoin(input);
        const joining = { ...input, idempotencyKey: "b2-unmapped-join" };
        await service.reserveOrJoin(joining);
        const changed =
          fault === "Service"
            ? { serviceId: new Types.ObjectId() }
            : fault === "Staff"
              ? { staffMembershipId: new Types.ObjectId() }
              : fault === "Business"
                ? { businessId: new Types.ObjectId() }
                : fault === "party"
                  ? { partySize: 2 }
                  : fault === "capacity"
                    ? { capacityMax: 6 }
                    : fault === "timezone"
                      ? { timezone: "UTC" }
                      : fault === "start"
                        ? { startAt: new Date("2026-08-25T09:15:00Z") }
                        : fault === "end"
                          ? { endAt: new Date("2026-08-25T10:15:00Z") }
                          : {
                              startAt: new Date("2026-08-26T09:00:00Z"),
                              endAt: new Date("2026-08-26T10:00:00Z"),
                            };
        const before = await state();
        const read = vi.spyOn(repository, "findIntervalByReservationId");
        await expect(service.reserveOrJoin({ ...joining, ...changed })).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(read).not.toHaveBeenCalled();
        expect(await state()).toBe(before);
      },
    );
    const historical = async (input: ReturnType<typeof exclusiveInput>) => {
      const reservationId = new Types.ObjectId();
      const scope = { ...input, occupancyDate: "2026-08-25", reservationId };
      await BookingSlotReservationClaimModel.create({
        idempotencyKey: input.idempotencyKey,
        businessId: input.businessId,
        staffMembershipId: input.staffMembershipId,
        serviceId: input.serviceId,
        partySize: input.partySize,
        occupancyDate: scope.occupancyDate,
        reservationId,
      });
      await repository.ensureDayDocument(
        input.businessId,
        input.staffMembershipId,
        scope.occupancyDate,
        input.timezone,
      );
      await repository.createInterval(scope);
      return reservationId;
    };
    it("B2 historical hydration and creator replay succeed without adopting new evidence", async () => {
      const input = exclusiveInput();
      const reservationId = await historical(input);
      const claim = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      }).orFail();
      await claim.validate();
      expect(claim.originalIntent).toBeUndefined();
      const before = await state();
      expect(String((await service.reserveOrJoin(input)).reservationId)).toBe(
        String(reservationId),
      );
      await expect(
        service.reserveOrJoin({ ...input, endAt: new Date("2026-08-25T10:15:00Z") }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
      await service.release({ ...input, reservationId });
      const afterRelease = await state();
      await expect(service.reserveOrJoin(input)).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(afterRelease);
    });
    it.each(["save", "query", "pipeline", "replace", "bulk"])(
      "B2 %s cannot rewrite immutable claim intent/scope",
      async (method) => {
        const input = exclusiveInput();
        await service.reserveOrJoin(input);
        const claim = await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: input.idempotencyKey,
        }).orFail();
        const before = await state();
        const change = { "originalIntent.timezone": "UTC" };
        const write =
          method === "save"
            ? (() => {
                claim.set(change);
                return claim.save({ validateBeforeSave: false });
              })()
            : method === "query"
              ? BookingSlotReservationClaimModel.updateOne({ _id: claim._id }, { $set: change })
              : method === "pipeline"
                ? BookingSlotReservationClaimModel.updateOne(
                    { _id: claim._id },
                    [{ $set: change }],
                    { updatePipeline: true },
                  )
                : method === "replace"
                  ? BookingSlotReservationClaimModel.replaceOne(
                      { _id: claim._id },
                      { ...claim.toObject(), serviceId: new Types.ObjectId() },
                    )
                  : BookingSlotReservationClaimModel.bulkWrite([
                      { updateOne: { filter: { _id: claim._id }, update: { $set: change } } },
                    ]);
        await expect(write).rejects.toMatchObject({ statusCode: 409 });
        expect(await state()).toBe(before);
      },
    );
    it("B2 aborted reservation transaction leaves neither claim intent nor occupancy", async () => {
      const input = exclusiveInput();
      const session = await mongoose.startSession();
      try {
        await expect(
          session.withTransaction(async () => {
            await service.reserveOrJoin(input, session);
            throw new Error("B2 abort");
          }),
        ).rejects.toThrow("B2 abort");
      } finally {
        await session.endSession();
      }
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
      await service.reserveOrJoin(input);
      expect(
        (await BookingSlotReservationClaimModel.findOne({ idempotencyKey: input.idempotencyKey }))
          ?.originalIntent?.version,
      ).toBe(1);
    });
    const operation = (businessId: Types.ObjectId): PackageInitialReservationOperation => ({
      version: 1,
      kind: "PACKAGE_INITIAL_APPOINTMENT",
      businessId: String(businessId),
      bookingId: String(new Types.ObjectId()),
      batchId: String(new Types.ObjectId()),
      selectionId: String(new Types.ObjectId()),
    });
    it("B2 planned Package identity binds atomically and cannot change batch or lose its binding", async () => {
      const input = exclusiveInput();
      const packageOperation = operation(input.businessId);
      const idempotencyKey = packageInitialReservationKey(packageOperation);
      const request = { ...input, idempotencyKey, packageOperation };
      const first = await service.reserveOrJoin(request);
      const before = await state();
      expect(String((await service.reserveOrJoin(request)).reservationId)).toBe(
        String(first.reservationId),
      );
      await expect(
        service.reserveOrJoin({
          ...request,
          packageOperation: { ...packageOperation, batchId: String(new Types.ObjectId()) },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(service.reserveOrJoin({ ...input, idempotencyKey })).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await state()).toBe(before);
      const row = await BookingSlotReservationClaimModel.findOne({ idempotencyKey }).orFail();
      expect(row.originalIntent?.packageOperation).toMatchObject(packageOperation);
    });
    it("B2 unbound new namespace keys cannot preclaim a future Package operation", async () => {
      const input = exclusiveInput();
      const binding = operation(input.businessId);
      const before = await state();
      for (const idempotencyKey of [
        packageInitialReservationKey(binding),
        ` ${packageInitialReservationKey(binding)}`,
        `${packageInitialReservationKey(binding)} `,
      ])
        await expect(service.reserveOrJoin({ ...input, idempotencyKey })).rejects.toMatchObject({
          statusCode: 409,
        });
      expect(await state()).toBe(before);
    });
    it("B2 an existing caller numeric line suffix stays compatible even with a shared textual prefix", async () => {
      const input = exclusiveInput();
      const binding = operation(input.businessId);
      input.idempotencyKey = `${packageInitialReservationKey(binding)}:0`;
      const first = await service.reserveOrJoin(input);
      const before = await state();
      expect(String((await service.reserveOrJoin(input)).reservationId)).toBe(
        String(first.reservationId),
      );
      expect(await state()).toBe(before);
    });
    it("B2 historical namespace overlap replays historically but cannot impersonate a bound operation", async () => {
      const input = exclusiveInput();
      const binding = operation(input.businessId);
      input.idempotencyKey = packageInitialReservationKey(binding);
      const reservationId = await historical(input);
      const before = await state();
      expect(String((await service.reserveOrJoin(input)).reservationId)).toBe(
        String(reservationId),
      );
      await expect(
        service.reserveOrJoin({ ...input, packageOperation: binding }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
    });
    it("B2 concurrent conflicting inserts bind only the winning original intent", async () => {
      const input = exclusiveInput();
      const originalIntent = {
        version: 1 as const,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
        capacityMax: input.capacityMax,
      };
      const common = { ...input, occupancyDate: "2026-08-25", originalIntent };
      const original = BookingSlotReservationClaimModel.findOne.bind(
        BookingSlotReservationClaimModel,
      );
      let remaining = 2;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      vi.spyOn(BookingSlotReservationClaimModel, "findOne").mockImplementation((...args) => {
        const query = original(...args);
        if (calls++ < 2) {
          const exec = query.exec.bind(query);
          vi.spyOn(query, "exec").mockImplementationOnce(async () => {
            const row = await exec();
            expect(row).toBeNull();
            if (--remaining === 0) release();
            await barrier;
            return row;
          });
        }
        return query;
      });
      const changed = {
        ...originalIntent,
        startAt: new Date("2026-08-25T11:00:00Z"),
        endAt: new Date("2026-08-25T12:00:00Z"),
      };
      const outcomes = await Promise.allSettled([
        repository.claimIdempotencyKey({ ...common, reservationId: new Types.ObjectId() }),
        repository.claimIdempotencyKey({
          ...common,
          originalIntent: changed,
          reservationId: new Types.ObjectId(),
        }),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      const row = await original({ idempotencyKey: input.idempotencyKey }).orFail();
      const index = outcomes.findIndex((r) => r.status === "fulfilled");
      expect(row.originalIntent?.startAt).toEqual(
        index === 0 ? originalIntent.startAt : changed.startAt,
      );
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(1);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
    });
  });

  describe("B1 existing-evidence replay", () => {
    afterEach(() => vi.restoreAllMocks());
    const state = async () => {
      const db = mongoose.connection.db;
      if (!db || mongoose.connection.host !== "127.0.0.1") throw new Error("Owned DB required");
      const result: Record<string, unknown> = {};
      for (const collection of (await db.collections()).sort((a, b) =>
        a.collectionName.localeCompare(b.collectionName),
      ))
        result[collection.collectionName] = await collection.find({}).sort({ _id: 1 }).toArray();
      return JSON.stringify(result);
    };
    it.each(["Business", "Staff", "date", "Service", "party", "start", "end", "capacity"])(
      "B1 changed %s cannot reuse or mutate a creator reservation",
      async (fault) => {
        const input = exclusiveInput({ capacityMax: 5 });
        await service.reserveOrJoin(input);
        const changes =
          fault === "Business"
            ? { businessId: new Types.ObjectId() }
            : fault === "Staff"
              ? { staffMembershipId: new Types.ObjectId() }
              : fault === "date"
                ? {
                    startAt: new Date("2026-08-26T09:00:00Z"),
                    endAt: new Date("2026-08-26T10:00:00Z"),
                  }
                : fault === "Service"
                  ? { serviceId: new Types.ObjectId() }
                  : fault === "party"
                    ? { partySize: 2 }
                    : fault === "start"
                      ? { startAt: new Date("2026-08-25T09:15:00Z") }
                      : fault === "end"
                        ? { endAt: new Date("2026-08-25T10:15:00Z") }
                        : { capacityMax: 6 };
        const before = await state();
        await expect(service.reserveOrJoin({ ...input, ...changes })).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(await state()).toBe(before);
      },
    );
    it.each([1, 5])("B1 capacity %s creator replay is read-only", async (capacityMax) => {
      const input = exclusiveInput({ capacityMax });
      const original = await service.reserveOrJoin(input);
      const before = await state();
      const replay = await service.reserveOrJoin(input);
      expect(String(replay.reservationId)).toBe(String(original.reservationId));
      expect(await state()).toBe(before);
    });
    it("B1 historical join without effect cannot increment capacity again", async () => {
      const input = exclusiveInput({ capacityMax: 5 });
      const creator = await service.reserveOrJoin(input);
      const joining = { ...input, idempotencyKey: "b1-join" };
      const joined = await service.reserveOrJoin(joining);
      expect(String(joined.reservationId)).toBe(String(creator.reservationId));
      expect(joined.capacityUsed).toBe(2);
      const claim = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: joining.idempotencyKey,
      }).orFail();
      expect(String(claim.reservationId)).not.toBe(String(joined.reservationId));
      // Explicit pre-B3 fixture: a retained intent and unused proposed ID cannot
      // prove the actual joined target. New operations are covered by B3 tests.
      await BookingSlotReservationClaimModel.collection.updateOne(
        { _id: claim._id },
        { $unset: { effect: "" } },
      );
      const before = await state();
      await expect(service.reserveOrJoin(joining)).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
      expect(String((await service.reserveOrJoin(input)).reservationId)).toBe(
        String(creator.reservationId),
      );
      expect(await state()).toBe(before);
    });
    it("B1 a retained claim with a missing interval cannot recreate occupancy", async () => {
      const input = exclusiveInput();
      const original = await service.reserveOrJoin(input);
      await service.release({ ...input, reservationId: original.reservationId });
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(1);
      const before = await state();
      await expect(service.reserveOrJoin(input)).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
    });
    it.each(["Service", "time", "reservation"])(
      "B1 corrupted claim-to-interval %s rejects without mutation",
      async (fault) => {
        const input = exclusiveInput();
        const reserved = await service.reserveOrJoin(input);
        if (fault === "reservation")
          await BookingSlotReservationClaimModel.collection.updateOne(
            { idempotencyKey: input.idempotencyKey },
            { $set: { reservationId: new Types.ObjectId() } },
          );
        else
          await BookingSlotReservationModel.collection.updateOne(
            { businessId: input.businessId },
            {
              $set: {
                [fault === "Service" ? "intervals.0.serviceId" : "intervals.0.startAt"]:
                  fault === "Service" ? new Types.ObjectId() : new Date("2026-08-25T08:30:00Z"),
              },
            },
          );
        const before = await state();
        await expect(service.reserveOrJoin(input)).rejects.toMatchObject({ statusCode: 409 });
        expect(await state()).toBe(before);
        expect(reserved.reservationId).toBeDefined();
      },
    );
    it("B1 concurrent pending creator converges after its atomic transaction completes", async () => {
      const input = exclusiveInput({ capacityMax: 5 });
      let entered!: () => void;
      const atCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const released = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = repository.createInterval.bind(repository);
      vi.spyOn(repository, "createInterval").mockImplementationOnce(async (...args) => {
        entered();
        await released;
        return original(...args);
      });
      const first = service.reserveOrJoin(input);
      await atCreate;
      // The fresh claim is now invisible with its uncommitted occupancy. A
      // duplicate contends/retries the entire transaction, never partial writes.
      const duplicate = service.reserveOrJoin(input);
      resume();
      const [one, two] = await Promise.all([first, duplicate]);
      expect(String(one.reservationId)).toBe(String(two.reservationId));
      expect(two.capacityUsed).toBe(1);
      expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(1);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(1);
    });
    it("B1 transaction replay reads the existing claim before attempting a duplicate insert", async () => {
      const input = exclusiveInput();
      const first = await service.reserveOrJoin(input);
      const before = await state();
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          expect(String((await service.reserveOrJoin(input, session)).reservationId)).toBe(
            String(first.reservationId),
          );
        });
      } finally {
        await session.endSession();
      }
      expect(await state()).toBe(before);
    });
    it("B1 actual duplicate insert after a missed pre-read never falls back inside the transaction", async () => {
      const input = exclusiveInput();
      const claimInput = {
        ...input,
        occupancyDate: "2026-08-25",
        reservationId: new Types.ObjectId(),
      };
      await repository.claimIdempotencyKey(claimInput);
      const before = await state();
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const original = BookingSlotReservationClaimModel.findOne.bind(
          BookingSlotReservationClaimModel,
        );
        // A controlled missed lookup, followed by a REAL duplicate-key insert in Mongo.
        const read = vi
          .spyOn(BookingSlotReservationClaimModel, "findOne")
          .mockImplementationOnce(() => original({ _id: new Types.ObjectId() }));
        const failure = await repository
          .claimIdempotencyKey(claimInput, session)
          .catch((error) => error);
        expect(failure.code).toBe(11000);
        expect(read).toHaveBeenCalledTimes(1);
        const next = await original({ idempotencyKey: input.idempotencyKey })
          .session(session)
          .catch((error) => error);
        expect(next.code).toBe(251);
        process.stdout.write(
          `B1 duplicate insert: write=${failure.code}, subsequentRead=${next.code}\n`,
        );
        expect(await state()).toBe(before);
      } finally {
        await session.abortTransaction().catch(() => undefined);
        await session.endSession();
      }
    });
    it("B1 actual transactional claim collision propagates without using the invalidated session", async () => {
      const input = exclusiveInput();
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: input.idempotencyKey,
        }).session(session);
        const claimInput = {
          ...input,
          occupancyDate: "2026-08-25",
          reservationId: new Types.ObjectId(),
        };
        await repository.claimIdempotencyKey(claimInput);
        const before = await state();
        const read = vi.spyOn(BookingSlotReservationClaimModel, "findOne");
        const failure = await repository
          .claimIdempotencyKey({ ...claimInput, reservationId: new Types.ObjectId() }, session)
          .catch((error) => error);
        expect([11000, 112]).toContain(failure.code);
        expect(read).toHaveBeenCalledTimes(1); // the pre-insert snapshot read only
        const afterError = await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: input.idempotencyKey,
        })
          .session(session)
          .catch((error) => error);
        expect(afterError.code).toBe(251);
        process.stdout.write(
          `B1 transactional collision: write=${failure.code}, subsequentRead=${afterError.code}\n`,
        );
        expect(await state()).toBe(before);
      } finally {
        await session.abortTransaction().catch(() => undefined);
        await session.endSession();
      }
    });
  });

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
