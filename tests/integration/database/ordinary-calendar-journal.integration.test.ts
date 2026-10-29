import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Both rollout authorities are default-denied in source; only these engineering tests toggle
// them. P4B-2C: a row (journal ownership) needs creation AND delivery authority AND readiness.
const authority = vi.hoisted(() => ({ enabled: true, delivery: true }));
vi.mock("../../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => authority.enabled,
  verifyOrdinaryCalendarDeliveryAuthority: async () => {
    if (!authority.delivery) throw new Error("delivery not authorized in this suite");
  },
}));

import type { BookingDocument } from "../../../src/modules/booking/booking.model.js";
import {
  OrdinaryCalendarJournal,
  OrdinaryCalendarJournalConflictError,
  OrdinaryCalendarJournalReadiness,
  OrdinaryCalendarJournalRepository,
  ordinaryCalendarEventId,
} from "../../../src/modules/booking/ordinary-calendar-journal.js";
import { OrdinaryCalendarJournalModel } from "../../../src/modules/booking/ordinary-calendar-journal.model.js";
import { GoogleCalendarIntegrationModel } from "../../../src/modules/integration/integration.model.js";
import { buildBooking } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("P4B-2A ordinary Calendar journal", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
    await OrdinaryCalendarJournalModel.init(); // The targeted indexes the readiness check requires.
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    authority.enabled = true;
    authority.delivery = true;
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const journal = new OrdinaryCalendarJournal();
  const repository = new OrdinaryCalendarJournalRepository();

  const inTxn = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  };

  const connect = async (businessId: Types.ObjectId, overrides: Record<string, unknown> = {}) =>
    GoogleCalendarIntegrationModel.collection.insertOne({
      businessId,
      googleAccountEmail: "owner@example.com",
      googleAccountId: "acct-1",
      calendarId: "primary",
      connectionGeneration: "11111111-1111-4111-8111-111111111111",
      encryptedAccessToken: "x",
      encryptedRefreshToken: "y",
      tokenExpiresAt: new Date(),
      status: "CONNECTED",
      connectedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as never);

  const reschedule = (booking: BookingDocument, minutes: number): BookingDocument =>
    ({
      ...booking,
      schedule: {
        ...booking.schedule,
        startAt: new Date(booking.schedule.startAt.getTime() + minutes * 60_000),
        endAt: new Date(booking.schedule.endAt.getTime() + minutes * 60_000),
      },
      rescheduleHistory: [...booking.rescheduleHistory, {} as never],
      eventHistory: [...booking.eventHistory, {} as never],
    }) as BookingDocument;

  const cancel = (booking: BookingDocument): BookingDocument =>
    ({
      ...booking,
      status: "CANCELLED_BY_BUSINESS",
      eventHistory: [...booking.eventHistory, {} as never],
    }) as BookingDocument;

  it("a committed ordinary creation records one journal-owned intent bound to the connected destination", async () => {
    const booking = buildBooking();
    await connect(booking.businessId);
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const rows = await OrdinaryCalendarJournalModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookingId: booking._id,
      businessId: booking.businessId,
      mode: "AUTHORITATIVE",
      eventIdentity: { kind: "ALLOCATED", eventId: ordinaryCalendarEventId(booking._id) },
      state: "PENDING",
      createIssued: false,
      destination: {
        accountId: "acct-1",
        generation: "11111111-1111-4111-8111-111111111111",
        configuredCalendarId: "primary",
      },
      latest: {
        sequence: 1,
        source: "CREATED",
        bookingStatus: "UPCOMING",
        desired: { kind: "PRESENT" },
      },
    });
    expect(rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
    expect(await journal.legacySyncPermitted(booking)).toBe(false);
  });

  it("P4B-2C Option C: with either switch off or the journal unprovisioned, nothing is written", async () => {
    const cases: Array<[string, () => void, OrdinaryCalendarJournal]> = [
      [
        "creation switch off",
        () => {
          authority.enabled = false;
        },
        journal,
      ],
      [
        "delivery switch off",
        () => {
          authority.delivery = false;
        },
        journal,
      ],
      [
        "indexes missing",
        () => undefined,
        new OrdinaryCalendarJournal(undefined, { isReady: async () => false }),
      ],
    ];
    for (const [, arrange, recorder] of cases) {
      authority.enabled = true;
      authority.delivery = true;
      arrange();
      const booking = buildBooking();
      await connect(booking.businessId);
      expect(
        await inTxn((session) => recorder.recordCreatedInTransaction(booking, session)),
      ).toBeNull();
      // Later mutations of a legacy-owned Booking gain no journal write either.
      authority.enabled = true;
      authority.delivery = true;
      expect(
        await inTxn((session) => journal.recordMutationInTransaction(cancel(booking), session)),
      ).toBeNull();
      expect(await journal.legacySyncPermitted(booking)).toBe(true);
    }
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
  });

  it("readiness requires both exact indexes, treats errors as not ready, and caches its answer", async () => {
    let calls = 0;
    let now = 0;
    const indexes = [
      { key: { _id: 1 } },
      { key: { bookingId: 1 }, unique: true },
      { key: { mode: 1, state: 1, nextAttemptAt: 1 } },
    ];
    const ready = new OrdinaryCalendarJournalReadiness(
      async () => {
        calls += 1;
        return indexes;
      },
      () => now,
      1_000,
    );
    expect(await ready.isReady()).toBe(true);
    expect(await ready.isReady()).toBe(true);
    expect(calls).toBe(1);
    const notUnique = new OrdinaryCalendarJournalReadiness(
      async () => [{ key: { bookingId: 1 } }, { key: { mode: 1, state: 1, nextAttemptAt: 1 } }],
      () => now,
      1_000,
    );
    expect(await notUnique.isReady()).toBe(false);
    const missing = new OrdinaryCalendarJournalReadiness(async () => [
      { key: { bookingId: 1 }, unique: true },
    ]);
    expect(await missing.isReady()).toBe(false);
    let fail = true;
    const failing = new OrdinaryCalendarJournalReadiness(
      async () => {
        if (fail) throw new Error("ns not found");
        return indexes;
      },
      () => now,
      1_000,
    );
    expect(await failing.isReady()).toBe(false);
    fail = false;
    expect(await failing.isReady()).toBe(false); // Not-ready answer is reused until rechecked.
    now = 2_000;
    expect(await failing.isReady()).toBe(true);
    // The real collection provisioned by `init()` above satisfies the real check.
    expect(await new OrdinaryCalendarJournalReadiness().isReady()).toBe(true);
  });

  it("an aborted Booking transaction leaves no intent, and an outside call is refused", async () => {
    const booking = buildBooking();
    await expect(
      inTxn(async (session) => {
        await journal.recordCreatedInTransaction(booking, session);
        throw new Error("booking rollback");
      }),
    ).rejects.toThrow("booking rollback");
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
    const session = await mongoose.startSession();
    try {
      await expect(journal.recordCreatedInTransaction(booking, session)).rejects.toBeInstanceOf(
        OrdinaryCalendarJournalConflictError,
      );
    } finally {
      await session.endSession();
    }
  });

  it("a lost-acknowledgement replay of the same creation keeps exactly one row; a different one conflicts", async () => {
    const booking = buildBooking();
    const first = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const replay = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    expect(String(replay?._id)).toBe(String(first?._id));
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(1);
    await expect(
      inTxn((session) => journal.recordCreatedInTransaction(reschedule(booking, 30), session)),
    ).rejects.toBeInstanceOf(OrdinaryCalendarJournalConflictError);
  });

  it("records no destination for a disconnected, errored, legacy or foreign connection", async () => {
    const plain = buildBooking();
    await inTxn((session) => journal.recordCreatedInTransaction(plain, session));
    const errored = buildBooking();
    await connect(errored.businessId, { status: "ERROR" });
    await inTxn((session) => journal.recordCreatedInTransaction(errored, session));
    const legacy = buildBooking();
    await connect(legacy.businessId, {
      connectionGeneration: undefined,
      googleAccountId: undefined,
    });
    await inTxn((session) => journal.recordCreatedInTransaction(legacy, session));
    const foreign = buildBooking();
    await connect(new Types.ObjectId());
    await inTxn((session) => journal.recordCreatedInTransaction(foreign, session));
    const rows = await OrdinaryCalendarJournalModel.find({}).lean();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.destination === undefined)).toBe(true);
  });

  it("never journals a First-Class Package Booking or a non-UPCOMING creation", async () => {
    const firstClass = buildBooking();
    firstClass.serviceLines[0]!.pricingInput = { packageItemId: new Types.ObjectId() } as never;
    expect(
      await inTxn((session) => journal.recordCreatedInTransaction(firstClass, session)),
    ).toBeNull();
    const pending = buildBooking({ status: "PENDING" as never });
    expect(
      await inTxn((session) => journal.recordCreatedInTransaction(pending, session)),
    ).toBeNull();
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
  });

  it("orders creation, reschedule and cancellation, deduplicates replay and never reopens a cancellation", async () => {
    const booking = buildBooking();
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const moved = reschedule(booking, 60);
    const second = await inTxn((session) => journal.recordMutationInTransaction(moved, session));
    expect(second?.latest).toMatchObject({
      sequence: 2,
      source: "RESCHEDULED",
      desired: { kind: "PRESENT", startAt: moved.schedule.startAt },
    });
    const replay = await inTxn((session) => journal.recordMutationInTransaction(moved, session));
    expect(replay?.latest.sequence).toBe(2);
    const cancelled = cancel(moved);
    const third = await inTxn((session) => journal.recordMutationInTransaction(cancelled, session));
    expect(third?.latest).toMatchObject({
      sequence: 3,
      source: "CANCELLED",
      desired: { kind: "ABSENT" },
    });
    await expect(
      inTxn((session) => journal.recordMutationInTransaction(reschedule(moved, 30), session)),
    ).rejects.toBeInstanceOf(OrdinaryCalendarJournalConflictError);
    expect((await OrdinaryCalendarJournalModel.findOne({}).lean())?.latest.sequence).toBe(3);
  });

  it("a rolled-back mutation leaves the previous desired state", async () => {
    const booking = buildBooking();
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    await expect(
      inTxn(async (session) => {
        await journal.recordMutationInTransaction(cancel(booking), session);
        throw new Error("cancellation rollback");
      }),
    ).rejects.toThrow("cancellation rollback");
    expect((await OrdinaryCalendarJournalModel.findOne({}).lean())?.latest).toMatchObject({
      sequence: 1,
      desired: { kind: "PRESENT" },
    });
  });

  it("never migrates a historical Booking and never crosses Business boundaries", async () => {
    const historical = buildBooking({ googleCalendarEventId: "legacy-random-id" } as never);
    expect(
      await inTxn((session) => journal.recordMutationInTransaction(cancel(historical), session)),
    ).toBeNull();
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(0);
    expect(await journal.legacySyncPermitted(historical)).toBe(true);

    const booking = buildBooking();
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const foreign = { ...cancel(booking), businessId: new Types.ObjectId() } as BookingDocument;
    expect(
      await inTxn((session) => journal.recordMutationInTransaction(foreign, session)),
    ).toBeNull();
    expect((await OrdinaryCalendarJournalModel.findOne({}).lean())?.latest.sequence).toBe(1);
  });

  it("an OAuth reconnect never silently rebinds the recorded destination", async () => {
    const booking = buildBooking();
    await connect(booking.businessId);
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    await GoogleCalendarIntegrationModel.updateOne(
      { businessId: booking.businessId },
      {
        $set: {
          connectionGeneration: "22222222-2222-4222-8222-222222222222",
          googleAccountId: "acct-2",
        },
      },
    );
    await inTxn((session) => journal.recordMutationInTransaction(reschedule(booking, 15), session));
    expect((await OrdinaryCalendarJournalModel.findOne({}).lean())?.destination).toMatchObject({
      accountId: "acct-1",
      generation: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("concurrent mutations serialize: no recorded revision is lost", async () => {
    const booking = buildBooking();
    await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const results = await Promise.allSettled([
      inTxn((session) => journal.recordMutationInTransaction(reschedule(booking, 30), session)),
      inTxn((session) => journal.recordMutationInTransaction(reschedule(booking, 90), session)),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    expect((await OrdinaryCalendarJournalModel.findOne({}).lean())?.latest.sequence).toBe(
      1 + fulfilled,
    );
  });

  it("an AUTHORITATIVE creation allocates the ordinary id and switches the legacy path off", async () => {
    authority.enabled = true;
    const booking = buildBooking();
    await connect(booking.businessId);
    const row = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    expect(row).toMatchObject({
      mode: "AUTHORITATIVE",
      state: "PENDING",
      eventIdentity: { kind: "ALLOCATED", eventId: ordinaryCalendarEventId(booking._id) },
    });
    expect(row?.nextAttemptAt).toBeInstanceOf(Date);
    expect(await journal.legacySyncPermitted(booking)).toBe(false);

    const unconnected = buildBooking();
    const blocked = await inTxn((session) =>
      journal.recordCreatedInTransaction(unconnected, session),
    );
    expect(blocked).toMatchObject({
      mode: "AUTHORITATIVE",
      state: "BLOCKED_AUTHORITY",
      reason: "CALENDAR_NOT_CONNECTED_AT_CREATION",
    });

    // A Booking that somehow already carries a legacy link is never taken over.
    const linked = buildBooking({ googleCalendarEventId: "legacy-random-id" } as never);
    expect(
      await inTxn((session) => journal.recordCreatedInTransaction(linked, session)),
    ).toBeNull();
    expect(await journal.legacySyncPermitted(linked)).toBe(true);
  });

  it("a pre-release SHADOW row stays legacy-owned: never claimed, updated or delivered", async () => {
    const booking = buildBooking();
    await connect(booking.businessId);
    const [row] = await OrdinaryCalendarJournalModel.create([
      {
        version: 1,
        bookingId: booking._id,
        businessId: booking.businessId,
        mode: "SHADOW",
        eventIdentity: { kind: "LEGACY_PATH" },
        state: "PENDING",
        createIssued: false,
        latest: {
          sequence: 1,
          revision: "a".repeat(64),
          desired: {
            kind: "PRESENT",
            summary: "s",
            description: "d",
            startAt: booking.schedule.startAt,
            endAt: booking.schedule.endAt,
            timezone: booking.schedule.timezone,
          },
          source: "CREATED",
          bookingStatus: "UPCOMING",
          eventVersion: 0,
          rescheduleVersion: 0,
          recordedAt: new Date(),
        },
      },
    ]);
    expect(await repository.prepare(row!)).toBeNull();
    expect(
      await inTxn((session) => journal.recordMutationInTransaction(cancel(booking), session)),
    ).toBeNull();
    expect((await OrdinaryCalendarJournalModel.findById(row!._id).lean())?.latest.sequence).toBe(1);
    expect(await journal.legacySyncPermitted(booking)).toBe(true);
    expect(await repository.listDue(10)).toHaveLength(0);
  });

  it("consumer primitives: one claim, one insert, one send permission, exact acknowledgement", async () => {
    authority.enabled = true;
    const booking = buildBooking();
    await connect(booking.businessId);
    const row = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));

    const claim = await repository.prepare(row!);
    expect(claim).not.toBeNull();
    expect(await repository.prepare(row!)).toBeNull(); // Duplicate claim while the lease is live.
    expect(
      await repository.issue(claim!.journal, "00000000-0000-4000-8000-00000000dead", {
        kind: "INSERT",
      }),
    ).toBeNull(); // Stale or foreign worker.
    expect(await repository.issue(claim!.journal, claim!.token, { kind: "PATCH" })).toBeNull(); // No ETag.
    const issued = await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" });
    expect(issued?.journal).toMatchObject({ state: "REQUEST_ISSUED", createIssued: true });
    expect(await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" })).toBeNull(); // No second insert.

    expect(await repository.markProviderStarted(row!._id, issued!.request.id)).toBe(true);
    expect(await repository.markProviderStarted(row!._id, issued!.request.id)).toBe(false);

    // Response lost: unknown outcome keeps the request unresolved and blocks re-dispatch.
    expect(
      await repository.acknowledge(row!._id, issued!.request.id, {
        state: "UNKNOWN_OUTCOME",
        definitiveNoEffect: false,
      }),
    ).toBe(true);
    let current = await repository.findByBookingId(booking._id);
    expect(current?.request).toMatchObject({ settled: false });
    expect(await repository.prepare(current!)).toBeNull();

    // A reschedule during the unresolved insert supersedes the desired state, keeps uncertainty.
    current = await inTxn((session) =>
      journal.recordMutationInTransaction(reschedule(booking, 45), session),
    );
    expect(current).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      latest: { sequence: 2 },
      request: { id: issued!.request.id, sequence: 1, settled: false },
    });
    // An observation cannot confirm the newer sequence while the older request is unresolved.
    expect(await repository.confirm(current!)).toBe(false);
  });

  it("a late answer settles only its own request and never confirms a newer revision", async () => {
    authority.enabled = true;
    const booking = buildBooking();
    await connect(booking.businessId);
    const row = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const claim = await repository.prepare(row!);
    const issued = await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" });
    await inTxn((session) => journal.recordMutationInTransaction(reschedule(booking, 45), session));

    expect(
      await repository.acknowledge(row!._id, "00000000-0000-4000-8000-000000000bad", {
        state: "RETRYABLE_FAILURE",
        definitiveNoEffect: false,
      }),
    ).toBe(false);
    expect(
      await repository.acknowledge(row!._id, issued!.request.id, {
        state: "RETRYABLE_FAILURE",
        definitiveNoEffect: false,
      }),
    ).toBe(true);
    const after = await repository.findByBookingId(booking._id);
    expect(after).toMatchObject({
      state: "PENDING",
      createIssued: true,
      latest: { sequence: 2 },
      request: { settled: true, sequence: 1 },
    });
    expect(after?.confirmedSequence).toBeUndefined();
    expect(await repository.confirm(after!)).toBe(true);
    expect(await repository.findByBookingId(booking._id)).toMatchObject({
      state: "CONFIRMED",
      confirmedSequence: 2,
    });
  });

  it("only a definitive no-effect answer may clear the issued-insert fence", async () => {
    authority.enabled = true;
    const booking = buildBooking();
    await connect(booking.businessId);
    const row = await inTxn((session) => journal.recordCreatedInTransaction(booking, session));
    const claim = await repository.prepare(row!);
    const issued = await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" });
    expect(
      await repository.acknowledge(row!._id, issued!.request.id, {
        state: "RETRYABLE_FAILURE",
        definitiveNoEffect: true,
      }),
    ).toBe(true);
    expect(await repository.findByBookingId(booking._id)).toMatchObject({
      createIssued: false,
      state: "RETRYABLE_FAILURE",
      request: { settled: true },
    });
  });
});
