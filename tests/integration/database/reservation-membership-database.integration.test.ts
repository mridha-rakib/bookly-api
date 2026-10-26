import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("B3 canonical reservation membership", () => {
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
  afterEach(() => vi.restoreAllMocks());
  const input = () => ({
    businessId: new Types.ObjectId(),
    staffMembershipId: new Types.ObjectId(),
    serviceId: new Types.ObjectId(),
    timezone: "Europe/Nicosia",
    startAt: new Date("2026-08-25T09:00:00Z"),
    endAt: new Date("2026-08-25T10:00:00Z"),
    capacityMax: 5,
    partySize: 1,
    idempotencyKey: `b3-${new Types.ObjectId()}`,
  });

  it("recovers the actual joined interval without applying capacity twice", async () => {
    const creator = input();
    const first = await service.reserveOrJoin(creator);
    const joining = { ...creator, idempotencyKey: `${creator.idempotencyKey}-join` };
    const joined = await service.reserveOrJoin(joining);
    const claim = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: joining.idempotencyKey,
    }).orFail();
    expect(String(claim.reservationId)).not.toBe(String(joined.reservationId));
    expect(String(joined.reservationId)).toBe(String(first.reservationId));
    const replay = await service.reserveOrJoin(joining);
    expect(String(replay.reservationId)).toBe(String(joined.reservationId));
    expect(replay.capacityUsed).toBe(2);
  });

  const state = async () =>
    JSON.stringify({
      claims: await BookingSlotReservationClaimModel.find().sort({ _id: 1 }).lean(),
      days: await BookingSlotReservationModel.find().sort({ _id: 1 }).lean(),
    });
  const operation = (key: string) =>
    BookingSlotReservationClaimModel.findOne({ idempotencyKey: key }).orFail();
  const used = async () =>
    (await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed ?? 0;
  const parties = async () => {
    const creator = input();
    const joiner = { ...creator, partySize: 2, idempotencyKey: `${creator.idempotencyKey}-join` };
    const result = await service.reserveOrJoin(creator);
    await service.reserveOrJoin(joiner);
    return { creator, joiner, result };
  };

  it("records separate creator and actual-target joiner effects on original operations", async () => {
    const { creator, joiner, result } = await parties();
    expect((await operation(creator.idempotencyKey)).toObject()).toMatchObject({
      effect: {
        version: 1,
        role: "CREATOR",
        state: "APPLIED",
        actualReservationId: result.reservationId,
      },
    });
    expect((await operation(joiner.idempotencyKey)).toObject()).toMatchObject({
      partySize: 2,
      effect: { role: "JOINER", state: "APPLIED", actualReservationId: result.reservationId },
    });
    expect(await used()).toBe(3);
  });
  it.each(["creator", "joiner"] as const)(
    "releases %s once while preserving the other contribution",
    async (party) => {
      const f = await parties();
      const release = { ...f[party], reservationId: f.result.reservationId };
      expect(await service.release(release)).toEqual({ released: true, alreadyReleased: false });
      expect(await used()).toBe(party === "creator" ? 2 : 1);
      const before = await state();
      expect(await service.release(release)).toEqual({ released: false, alreadyReleased: true });
      expect(await state()).toBe(before);
      expect((await operation(release.idempotencyKey)).effect?.state).toBe("RELEASED");
      await expect(service.reserveOrJoin(f[party])).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
    },
  );
  it("removes the last interval but keeps both released effects and cannot affect a later interval", async () => {
    const f = await parties();
    await service.release({ ...f.creator, reservationId: f.result.reservationId });
    await service.release({ ...f.joiner, reservationId: f.result.reservationId });
    expect(await used()).toBe(0);
    const later = await service.reserveOrJoin({ ...f.creator, idempotencyKey: "later" });
    expect(String(later.reservationId)).not.toBe(String(f.result.reservationId));
    const before = await state();
    await service.release({ ...f.joiner, reservationId: f.result.reservationId });
    expect(await state()).toBe(before);
    expect(
      await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "RELEASED" }),
    ).toBe(2);
  });
  it("concurrent duplicate releases commit one decrement", async () => {
    const f = await parties();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.release({ ...f.joiner, reservationId: f.result.reservationId }),
      ),
    );
    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyReleased)).toHaveLength(3);
    expect(await used()).toBe(1);
  });
  it("concurrent identical joins elect one effect and return the same actual target", async () => {
    const creator = input();
    const result = await service.reserveOrJoin(creator);
    const join = { ...creator, idempotencyKey: "same-join" };
    // Both real transactional reads observe no claim before either insert.
    const find = BookingSlotReservationClaimModel.findOne.bind(BookingSlotReservationClaimModel);
    let remaining = 2;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.spyOn(BookingSlotReservationClaimModel, "findOne").mockImplementation((...args) => {
      const query = find(...args);
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
    const claim = repository.claimIdempotencyKey.bind(repository);
    const conflictCodes: number[] = [];
    vi.spyOn(repository, "claimIdempotencyKey").mockImplementation(async (...args) => {
      try {
        return await claim(...args);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "number")
          conflictCodes.push(error.code);
        throw error;
      }
    });
    const results = await Promise.all(Array.from({ length: 2 }, () => service.reserveOrJoin(join)));
    expect(results.every((r) => String(r.reservationId) === String(result.reservationId))).toBe(
      true,
    );
    expect(await used()).toBe(2);
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(2);
    expect(conflictCodes).toContain(112);
  });
  it("different parties competing for final seat cannot exceed capacity", async () => {
    const creator = { ...input(), capacityMax: 2 };
    await service.reserveOrJoin(creator);
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((idempotencyKey) =>
        service.reserveOrJoin({ ...creator, idempotencyKey }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await used()).toBe(2);
    expect(
      await BookingSlotReservationClaimModel.countDocuments({ "effect.state": "APPLIED" }),
    ).toBe(2);
  });
  it.each(["join", "release"])(
    "%s callback abort rolls back effect and occupancy together",
    async (kind) => {
      const f = await parties();
      const before = await state();
      const session = await mongoose.startSession();
      try {
        await expect(
          session.withTransaction(async () => {
            if (kind === "join")
              await service.reserveOrJoin({ ...f.creator, idempotencyKey: "abort-join" }, session);
            else
              await service.release(
                { ...f.joiner, reservationId: f.result.reservationId },
                session,
              );
            throw new Error("explicit precommit failure");
          }),
        ).rejects.toThrow("explicit precommit failure");
      } finally {
        await session.endSession();
      }
      expect(await state()).toBe(before);
    },
  );
  it.each(["join", "release"])(
    "%s effect persistence failure aborts its prior capacity write",
    async (kind) => {
      const f = await parties();
      const before = await state();
      vi.spyOn(repository, "recordEffect").mockRejectedValueOnce(new Error("effect failed"));
      if (kind === "join")
        await expect(
          service.reserveOrJoin({ ...f.creator, idempotencyKey: "failed-effect" }),
        ).rejects.toThrow("effect failed");
      else
        await expect(
          service.release({ ...f.joiner, reservationId: f.result.reservationId }),
        ).rejects.toThrow("effect failed");
      expect(await state()).toBe(before);
    },
  );
  it.each(["Business", "Staff", "party", "target", "timezone", "start", "key"])(
    "denies changed release %s without mutation",
    async (fault) => {
      const f = await parties();
      const changes =
        fault === "Business"
          ? { businessId: new Types.ObjectId() }
          : fault === "Staff"
            ? { staffMembershipId: new Types.ObjectId() }
            : fault === "party"
              ? { partySize: 1 }
              : fault === "target"
                ? { reservationId: new Types.ObjectId() }
                : fault === "timezone"
                  ? { timezone: "UTC" }
                  : fault === "start"
                    ? { startAt: new Date("2026-08-25T09:01:00Z") }
                    : { idempotencyKey: "missing-key" };
      const before = await state();
      await expect(
        service.release({ ...f.joiner, reservationId: f.result.reservationId, ...changes }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await state()).toBe(before);
    },
  );
  it("unkeyed release cannot consume new creator or joiner capacity", async () => {
    const f = await parties();
    const before = await state();
    await expect(
      service.release({
        ...f.joiner,
        idempotencyKey: undefined,
        reservationId: f.result.reservationId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toBe(before);
  });
  it("ordinary save and query writers cannot repoint or revive effects", async () => {
    const f = await parties();
    const claim = await operation(f.joiner.idempotencyKey);
    const before = await state();
    await expect(
      BookingSlotReservationClaimModel.updateOne(
        { _id: claim._id },
        { $set: { "effect.state": "RELEASED" } },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    claim.set("effect.actualReservationId", new Types.ObjectId());
    await expect(claim.save({ validateBeforeSave: false })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await state()).toBe(before);
  });
  it("ordinary deletion cannot erase membership evidence to reopen its key", async () => {
    const f = await parties();
    const claim = await operation(f.joiner.idempotencyKey);
    const before = await state();
    await expect(
      BookingSlotReservationClaimModel.deleteOne({ _id: claim._id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(claim.deleteOne()).rejects.toMatchObject({ statusCode: 409 });
    await expect(BookingSlotReservationClaimModel.deleteMany({})).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      BookingSlotReservationClaimModel.findOneAndDelete({ _id: claim._id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toBe(before);
  });
  it("cannot append invented applied state to an existing no-effect historical claim", async () => {
    const f = await parties();
    const claim = await operation(f.joiner.idempotencyKey);
    await BookingSlotReservationClaimModel.collection.updateOne(
      { _id: claim._id },
      { $unset: { effect: "" } },
    );
    const before = await state();
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(() =>
          repository.recordEffect(
            claim.idempotencyKey,
            {
              version: 1,
              role: "JOINER",
              state: "APPLIED",
              actualReservationId: f.result.reservationId,
            },
            session,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await session.endSession();
    }
    expect(await state()).toBe(before);
    await expect(service.reserveOrJoin(f.joiner)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("historical Group release is explicitly blocked without inventing per-party evidence", async () => {
    const f = await parties();
    // Privileged fixture-only removal simulates a pre-B3 Group, never a migration.
    await BookingSlotReservationClaimModel.collection.updateMany({}, { $unset: { effect: "" } });
    const before = await state();
    await expect(
      service.release({ ...f.creator, reservationId: f.result.reservationId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toBe(before);
  });
  it("historical absent occupancy cannot be reported as a proven per-party release", async () => {
    const f = await parties();
    await BookingSlotReservationClaimModel.collection.updateMany({}, { $unset: { effect: "" } });
    await BookingSlotReservationModel.collection.updateMany({}, { $set: { intervals: [] } });
    const before = await state();
    await expect(
      service.release({ ...f.creator, reservationId: f.result.reservationId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toBe(before);
  });
  it("a transiently unavailable committed effect stays pinned without another increment", async () => {
    const f = await parties();
    const before = await state();
    vi.spyOn(repository, "findOperation").mockResolvedValueOnce(null);
    await expect(service.reserveOrJoin(f.joiner)).rejects.toMatchObject({ statusCode: 409 });
    expect(await state()).toBe(before);
    expect(String((await service.reserveOrJoin(f.joiner)).reservationId)).toBe(
      String(f.result.reservationId),
    );
    expect(await state()).toBe(before);
  });
  it("inactive caller sessions cannot escape the atomic membership boundary", async () => {
    const session = await mongoose.startSession();
    try {
      await expect(service.reserveOrJoin(input(), session)).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      await session.endSession();
    }
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
  });
  it.each(["join", "release"])(
    "committed %s plus controlled lost return preserves effect for matching retry",
    async (kind) => {
      const f = await parties();
      const start = mongoose.startSession.bind(mongoose);
      vi.spyOn(mongoose, "startSession").mockImplementationOnce(async (...args) => {
        const session = await start(...args);
        const transaction = session.withTransaction.bind(session);
        vi.spyOn(session, "withTransaction").mockImplementationOnce(async (...parameters) => {
          await transaction(...parameters);
          throw new Error("controlled service-return loss after real commit");
        });
        return session;
      });
      const join = { ...f.creator, idempotencyKey: "lost-return" };
      const release = { ...f.joiner, reservationId: f.result.reservationId };
      await expect(
        kind === "join" ? service.reserveOrJoin(join) : service.release(release),
      ).rejects.toMatchObject({ statusCode: 503 });
      const before = await state();
      if (kind === "join") expect((await service.reserveOrJoin(join)).capacityUsed).toBe(4);
      else
        expect(await service.release(release)).toEqual({ released: false, alreadyReleased: true });
      expect(await state()).toBe(before);
    },
  );
});
