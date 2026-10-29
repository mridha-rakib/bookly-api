import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Both ordinary Calendar authorities are default-denied in source; these tests toggle them.
const authority = vi.hoisted(() => ({ authoritative: true, delivery: true }));
vi.mock("../../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => authority.authoritative,
  verifyOrdinaryCalendarDeliveryAuthority: async () => {
    if (!authority.delivery) throw new Error("ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE");
  },
}));

import { logger } from "../../../src/config/logger.js";
import { type BookingDocument, BookingModel } from "../../../src/modules/booking/booking.model.js";
import {
  consumeOrdinaryCalendarSendPermission,
  OrdinaryCalendarDispatch,
  type OrdinaryCalendarProvider,
  sameOrdinaryCalendarDestination,
} from "../../../src/modules/booking/ordinary-calendar-dispatch.js";
import {
  classifyOrdinaryCalendarIncident,
  describeOrdinaryCalendarSync,
} from "../../../src/modules/booking/ordinary-calendar-incident.js";
import {
  ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
  OrdinaryCalendarJournal,
  OrdinaryCalendarJournalRepository,
  ordinaryCalendarEventId,
} from "../../../src/modules/booking/ordinary-calendar-journal.js";
import {
  type OrdinaryCalendarDestination,
  OrdinaryCalendarJournalModel,
} from "../../../src/modules/booking/ordinary-calendar-journal.model.js";
import { OrdinaryCalendarWorker } from "../../../src/modules/booking/ordinary-calendar-worker.js";
import {
  PackageCalendarOwnerAuthority,
  verifyPackageCalendarProductionAuthority,
} from "../../../src/modules/booking/package-calendar-authority.js";
import { PackageCalendarProviderError } from "../../../src/modules/booking/package-calendar-delivery.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { GoogleCalendarIntegrationModel } from "../../../src/modules/integration/integration.model.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { buildBooking } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type FakeEvent = {
  status: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  summary?: string;
  marker: { booklyBookingId?: string; booklyBusinessId?: string };
  etag: string;
};
type Failure = { error: Error; apply: boolean };

/** In-memory Google Calendar. Mutations consume the REAL journal send permission first,
 * exactly like IntegrationService.ordinaryCalendarProvider, then apply Google semantics:
 * id-collision 409, If-Match 412, delete leaves a cancelled tombstone. */
class FakeGoogle {
  events = new Map<string, FakeEvent>();
  calls: string[] = [];
  current: OrdinaryCalendarDestination | null = null;
  failures: Partial<Record<"read" | "insert" | "patch" | "remove", Failure>> = {};
  onRead?: () => Promise<void>;
  afterRead?: () => void;
  private version = 0;

  private etag() {
    this.version += 1;
    return `"etag-${this.version}"`;
  }
  private take(op: keyof FakeGoogle["failures"]) {
    const failure = this.failures[op];
    delete this.failures[op];
    return failure;
  }
  count(op: string) {
    return this.calls.filter((call) => call === op).length;
  }

  provider(): OrdinaryCalendarProvider {
    const assertCurrent = async (_businessId: string, destination: OrdinaryCalendarDestination) => {
      if (!sameOrdinaryCalendarDestination(this.current ?? undefined, destination))
        throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
    };
    return {
      currentDestination: async () => this.current,
      assertCurrent,
      bind: (binding) => {
        const send = async <T>(
          kind: "INSERT" | "PATCH" | "DELETE",
          op: "insert" | "patch" | "remove",
          mutation: Parameters<typeof consumeOrdinaryCalendarSendPermission>[1],
          apply: () => T,
        ): Promise<T> => {
          try {
            await assertCurrent(binding.businessId, binding.destination);
            await consumeOrdinaryCalendarSendPermission(binding, { ...mutation, kind });
          } catch (error) {
            throw error instanceof PackageCalendarProviderError
              ? new PackageCalendarProviderError(error.kind, true)
              : new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
          }
          this.calls.push(op);
          const failure = this.take(op);
          if (failure && !failure.apply) throw failure.error;
          const result = apply();
          if (failure) throw failure.error; // Applied at Google, response lost.
          return result;
        };
        return {
          read: async () => {
            this.calls.push("read");
            await this.onRead?.();
            const failure = this.take("read");
            if (failure) throw failure.error;
            if (!sameOrdinaryCalendarDestination(this.current ?? undefined, binding.destination))
              return { outcome: "NOT_CONNECTED" as const };
            const event = this.events.get(binding.eventId);
            const observed = event
              ? {
                  outcome: "FOUND" as const,
                  status: event.status,
                  startAt: event.startAt,
                  endAt: event.endAt,
                  marker: { ...event.marker },
                  etag: event.etag,
                }
              : { outcome: "NOT_FOUND" as const };
            this.afterRead?.();
            return observed;
          },
          insert: (event, requestId) =>
            send("INSERT", "insert", { kind: "INSERT", requestId, event }, () => {
              if (this.events.has(binding.eventId)) return "ALREADY_EXISTS" as const;
              this.events.set(binding.eventId, {
                status: "confirmed",
                startAt: event.startAt,
                endAt: event.endAt,
                timezone: event.timezone,
                summary: event.summary,
                etag: this.etag(),
                marker: {
                  booklyBookingId: binding.bookingId,
                  booklyBusinessId: binding.businessId,
                },
              });
              return "CREATED" as const;
            }),
          patchSchedule: (schedule, etag, requestId) =>
            send("PATCH", "patch", { kind: "PATCH", requestId, etag, event: schedule }, () => {
              const event = this.events.get(binding.eventId);
              if (!event) return "NOT_FOUND" as const;
              if (event.etag !== etag) return "PRECONDITION_FAILED" as const;
              Object.assign(event, {
                startAt: schedule.startAt,
                endAt: schedule.endAt,
                timezone: schedule.timezone,
                etag: this.etag(),
              });
              return "UPDATED" as const;
            }),
          remove: (etag, requestId) =>
            send("DELETE", "remove", { kind: "DELETE", requestId, etag }, () => {
              const event = this.events.get(binding.eventId);
              if (!event) return "DELETED" as const;
              if (event.etag !== etag) return "PRECONDITION_FAILED" as const;
              Object.assign(event, { status: "cancelled", etag: this.etag() });
              return "DELETED" as const;
            }),
        };
      },
    };
  }
}

describe("P4B-2B ordinary Calendar delivery", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
    await OrdinaryCalendarJournalModel.init(); // The targeted indexes journal ownership requires.
  }, 120_000);
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const advance = (ms: number) => {
    offset += ms;
  };
  let google: FakeGoogle;
  let dispatch: OrdinaryCalendarDispatch;
  const journal = new OrdinaryCalendarJournal();
  const repository = new OrdinaryCalendarJournalRepository(clock);
  const ownerId = new Types.ObjectId();

  beforeEach(async () => {
    await clearIsolatedDatabase();
    authority.authoritative = true;
    authority.delivery = true;
    offset = 0;
    google = new FakeGoogle();
    dispatch = new OrdinaryCalendarDispatch(google.provider(), clock, repository);
  });

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

  const destinationFor = (
    businessId: Types.ObjectId,
    row: { _id: Types.ObjectId },
    overrides = {},
  ) => ({
    integrationId: row._id,
    generation: "11111111-1111-4111-8111-111111111111",
    accountId: "acct-1",
    accountEmail: "owner@example.com",
    configuredCalendarId: "primary",
    ...overrides,
  });

  /** A committed, connected, journal-owned ordinary Booking. */
  const seed = async (overrides: Partial<BookingDocument> = {}) => {
    const booking = buildBooking(overrides);
    await BusinessModel.collection.insertOne({
      _id: booking.businessId,
      ownerUserId: ownerId,
      name: "Salon",
    } as never);
    const integrationId = new Types.ObjectId();
    await GoogleCalendarIntegrationModel.collection.insertOne({
      _id: integrationId,
      businessId: booking.businessId,
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
    } as never);
    google.current = destinationFor(booking.businessId, { _id: integrationId });
    const row = await inTxn(async (session) => {
      await BookingModel.collection.insertOne(booking as never, { session });
      return journal.recordCreatedInTransaction(booking, session);
    });
    return { booking, row: row!, integrationId };
  };

  const commit = (next: BookingDocument) =>
    inTxn(async (session) => {
      await BookingModel.collection.replaceOne({ _id: next._id }, next as never, { session });
      return journal.recordMutationInTransaction(next, session);
    });
  const reschedule = (booking: BookingDocument, minutes: number): BookingDocument =>
    ({
      ...booking,
      schedule: {
        ...booking.schedule,
        startAt: new Date(booking.schedule.startAt.getTime() + minutes * 60_000),
        endAt: new Date(booking.schedule.endAt.getTime() + minutes * 60_000),
      },
      rescheduleHistory: [...booking.rescheduleHistory, { at: new Date() } as never],
      eventHistory: [...booking.eventHistory, { at: new Date() } as never],
    }) as BookingDocument;
  const cancel = (booking: BookingDocument): BookingDocument =>
    ({
      ...booking,
      status: "CANCELLED_BY_BUSINESS",
      eventHistory: [...booking.eventHistory, { at: new Date() } as never],
    }) as BookingDocument;
  const read = (bookingId: Types.ObjectId) => repository.findByBookingId(bookingId);

  const ownerProof = async () => {
    await UserModel.collection.insertOne({
      _id: ownerId,
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      normalizedEmail: "owner@example.com",
    } as never);
    return new PackageCalendarOwnerAuthority(
      {
        verifyAccessToken: async () => ({
          sub: String(ownerId),
          sid: "sid-1",
          role: "BUSINESS_OWNER",
        }),
        isAccessTokenSessionLive: async () => true,
      } as never,
      {
        findById: async () => ({ _id: ownerId, role: "BUSINESS_OWNER", status: "ACTIVE" }),
      } as never,
    ).authenticate("Bearer test-token");
  };

  it("creates the committed Booking's event once with exact times, zone and ownership marker", async () => {
    const { booking } = await seed();
    // Issue → send → acknowledge → read-back in one pass; the acknowledgement alone is not DONE.
    expect(await dispatch.deliver((await read(booking._id))!._id)).toBe("DONE");
    expect(google.calls).toEqual(["read", "insert", "read"]);
    const event = google.events.get(ordinaryCalendarEventId(booking._id));
    expect(event).toMatchObject({
      status: "confirmed",
      startAt: booking.schedule.startAt,
      endAt: booking.schedule.endAt,
      timezone: booking.schedule.timezone,
      summary: `Bookly — ${booking.reference}`,
      marker: {
        booklyBookingId: String(booking._id),
        booklyBusinessId: String(booking.businessId),
      },
    });
    expect(await read(booking._id)).toMatchObject({
      state: "CONFIRMED",
      confirmedSequence: 1,
      createIssued: true,
    });
    expect(await dispatch.deliver((await read(booking._id))!._id)).toBe("DONE");
    expect(google.count("insert")).toBe(1);
    // The journal never writes the Booking's legacy link.
    expect(
      (await BookingModel.findById(booking._id).lean())?.googleCalendarEventId,
    ).toBeUndefined();
  });

  it("applies a reschedule with If-Match, then a cancellation, each confirmed by read-back", async () => {
    const { booking } = await seed();
    const id = (await read(booking._id))!._id;
    await dispatch.deliver(id);
    await dispatch.deliver(id);
    const moved = reschedule(booking, 90);
    await commit(moved);
    await dispatch.deliver(id);
    expect(await dispatch.deliver(id)).toBe("DONE");
    expect(google.events.get(ordinaryCalendarEventId(booking._id))?.startAt).toEqual(
      moved.schedule.startAt,
    );
    expect(await read(booking._id)).toMatchObject({ confirmedSequence: 2 });
    await commit(cancel(moved));
    await dispatch.deliver(id);
    expect(await dispatch.deliver(id)).toBe("DONE");
    expect(google.events.get(ordinaryCalendarEventId(booking._id))?.status).toBe("cancelled");
    expect(await read(booking._id)).toMatchObject({
      confirmedSequence: 3,
      latest: { desired: { kind: "ABSENT" } },
    });
    expect([google.count("insert"), google.count("patch"), google.count("remove")]).toEqual([
      1, 1, 1,
    ]);
  });

  it("never journals a legacy-owned Booking, and the ownership chosen at creation survives switch changes", async () => {
    authority.authoritative = false;
    const legacy = await seed();
    expect(legacy.row).toBeNull(); // P4B-2C Option C: no SHADOW row, no journal dependency.
    expect(await repository.listDue(50)).toHaveLength(0);
    authority.authoritative = true; // Switching later never adopts an existing Booking.
    expect(await commit(reschedule(legacy.booking, 30))).toBeNull();
    expect(await read(legacy.booking._id)).toBeNull();
    expect(await journal.legacySyncPermitted(legacy.booking)).toBe(true);

    await clearIsolatedDatabase();
    const owned = await seed();
    authority.authoritative = false;
    await commit(cancel(owned.booking));
    expect((await read(owned.booking._id))?.mode).toBe("AUTHORITATIVE");
    expect(await journal.legacySyncPermitted(owned.booking)).toBe(false);
    expect(google.calls).toHaveLength(0);
  });

  it("refuses a journal-owned Booking that another writer linked, a foreign tenant or a Package line", async () => {
    const linked = await seed();
    await BookingModel.updateOne(
      { _id: linked.booking._id },
      { $set: { googleCalendarEventId: "legacy-random-id" } },
    );
    expect(await dispatch.deliver(linked.row._id)).toBe("BLOCKED");
    expect(await read(linked.booking._id)).toMatchObject({
      state: "PERMANENT_FAILURE",
      reason: "LEGACY_EVENT_LINK_PRESENT",
    });

    await clearIsolatedDatabase();
    const foreign = await seed();
    await BookingModel.collection.updateOne(
      { _id: foreign.booking._id },
      { $set: { businessId: new Types.ObjectId() } },
    );
    expect(await dispatch.deliver(foreign.row._id)).toBe("BLOCKED");
    expect((await read(foreign.booking._id))?.reason).toBe("BOOKING_NOT_FOUND_FOR_BUSINESS");

    await clearIsolatedDatabase();
    const firstClass = await seed();
    await BookingModel.collection.updateOne(
      { _id: firstClass.booking._id },
      { $set: { "serviceLines.0.pricingInput.packageItemId": new Types.ObjectId() } },
    );
    expect(await dispatch.deliver(firstClass.row._id)).toBe("BLOCKED");
    expect((await read(firstClass.booking._id))?.reason).toBe("NOT_AN_ORDINARY_BOOKING");
    const raw = await BookingModel.collection.findOne({ _id: firstClass.booking._id });
    expect(raw?.["packageCalendarDelivery"]).toBeUndefined();
    expect(google.count("insert")).toBe(0);
  });

  it("a lost insert response is recovered by observation only, never by a second insert", async () => {
    const { booking, row } = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("UNKNOWN_OUTCOME"),
      apply: true,
    };
    expect(await dispatch.deliver(row._id)).toBe("RETRY");
    expect(await read(booking._id)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      request: { settled: false, providerStarted: true },
    });
    expect(await dispatch.deliver(row._id)).toBe("RETRY"); // Possibly still a live issuer.
    advance(3 * 60_000);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.count("insert")).toBe(1);
  });

  it("an unknown insert that never landed stays quarantined: a 404 never authorizes recreation", async () => {
    const { booking, row } = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("UNKNOWN_OUTCOME"),
      apply: false,
    };
    await dispatch.deliver(row._id);
    advance(3 * 60_000);
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(await read(booking._id)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      createIssued: true,
      reason: "UNRESOLVED_REQUEST_REQUIRES_QUIESCENCE_DECISION",
    });
    advance(20 * 60_000);
    await dispatch.deliver(row._id);
    expect(google.count("insert")).toBe(1);
  });

  it("a worker that crashed before consuming its send permission is safely superseded", async () => {
    const { booking, row } = await seed();
    const claim = await repository.prepare(row);
    await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" }); // Then the process died.
    advance(3 * 60_000);
    await dispatch.deliver(row._id);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.count("insert")).toBe(1);
    expect((await read(booking._id))?.reason).toBeUndefined();
  });

  it("an expired pre-dispatch lease is taken over and the stale holder cannot issue", async () => {
    const { row } = await seed();
    const stale = await repository.prepare(row, 1_000); // Then that worker died.
    expect(await dispatch.deliver(row._id)).toBe("RETRY"); // Its lease is still live.
    advance(5_000);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(await repository.issue(stale!.journal, stale!.token, { kind: "INSERT" })).toBeNull();
    expect(google.count("insert")).toBe(1);
  });

  it("concurrent workers produce exactly one insert", async () => {
    const { row } = await seed();
    await Promise.all([
      dispatch.deliver(row._id),
      dispatch.deliver(row._id),
      dispatch.deliver(row._id),
    ]);
    await dispatch.deliver(row._id);
    expect(google.count("insert")).toBe(1);
    expect((await repository.findById(row._id))?.state).toBe("CONFIRMED");
  });

  it("a reschedule during an uncertain create is quarantined until an exact Owner recovery", async () => {
    const { booking, row } = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("UNKNOWN_OUTCOME"),
      apply: true,
    };
    await dispatch.deliver(row._id);
    const moved = reschedule(booking, 60);
    await commit(moved);
    advance(3 * 60_000);
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect((await read(booking._id))?.reason).toBe("EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER");
    expect(google.count("patch")).toBe(0);

    const proof = await ownerProof();
    const pending = await read(booking._id);
    await expect(
      dispatch.recover(
        {
          bookingId: String(booking._id),
          businessId: String(booking.businessId),
          actorUserId: String(ownerId),
          incidentReference: "INC-1",
          assertion: "NO_UNRESOLVED_REQUEST",
        },
        proof,
      ),
    ).rejects.toThrow("exact unresolved request");
    const recovered = await dispatch.recover(
      {
        bookingId: String(booking._id),
        businessId: String(booking.businessId),
        actorUserId: String(ownerId),
        requestId: pending!.request!.id,
        incidentReference: "INC-1",
        assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED",
      },
      proof,
    );
    expect(recovered).toMatchObject({
      state: "RETRYABLE_FAILURE",
      createIssued: true,
      request: { settled: true },
      recoveries: [{ incidentReference: "INC-1", sessionFamilyId: "sid-1" }],
    });
    await dispatch.deliver(row._id);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.events.get(ordinaryCalendarEventId(booking._id))?.startAt).toEqual(
      moved.schedule.startAt,
    );
    expect(google.count("insert")).toBe(1);
  });

  it("an ETag mismatch is a definitive no-effect answer and is retried against a fresh read", async () => {
    const { booking, row } = await seed();
    await dispatch.deliver(row._id);
    await dispatch.deliver(row._id);
    await commit(reschedule(booking, 30));
    // An Owner edit lands between our read and our PATCH, so the observed ETag is stale.
    google.afterRead = () => {
      google.afterRead = undefined;
      google.events.get(ordinaryCalendarEventId(booking._id))!.etag = '"owner-edit"';
    };
    // 412 → definitive no effect → fresh read → PATCH with the new ETag; read-back next pass.
    expect(await dispatch.deliver(row._id)).toBe("RETRY");
    expect(google.count("patch")).toBe(2);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(await read(booking._id)).toMatchObject({ confirmedSequence: 2 });
    expect(google.count("insert")).toBe(1);
  });

  it("an externally deleted event is never recreated by a later reschedule", async () => {
    const { booking, row } = await seed();
    await dispatch.deliver(row._id);
    await dispatch.deliver(row._id);
    google.events.delete(ordinaryCalendarEventId(booking._id));
    await commit(reschedule(booking, 30));
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect((await read(booking._id))?.reason).toBe("MISSING_EVENT_DOES_NOT_AUTHORIZE_RECREATE");
    expect(google.count("insert")).toBe(1);
  });

  it("a reconnect blocks; only the same account and calendar may be rebound by the Owner", async () => {
    const { booking, row, integrationId } = await seed();
    google.current = destinationFor(
      booking.businessId,
      { _id: integrationId },
      { generation: "22222222-2222-4222-8222-222222222222" },
    );
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect((await read(booking._id))?.state).toBe("BLOCKED_AUTHORITY");
    const proof = await ownerProof();
    const target = {
      bookingId: String(booking._id),
      businessId: String(booking.businessId),
      actorUserId: String(ownerId),
      incidentReference: "INC-2",
      assertion: "NO_UNRESOLVED_REQUEST" as const,
    };
    await expect(dispatch.recover(target, proof)).rejects.toThrow("never adopted automatically");
    const otherAccount = destinationFor(
      booking.businessId,
      { _id: integrationId },
      { generation: "33333333-3333-4333-8333-333333333333", accountId: "acct-2" },
    );
    google.current = otherAccount;
    await expect(
      dispatch.recover({ ...target, rebindToCurrentConnection: true }, proof),
    ).rejects.toThrow("never adopted automatically");
    google.current = destinationFor(
      booking.businessId,
      { _id: integrationId },
      { generation: "22222222-2222-4222-8222-222222222222" },
    );
    const rebound = await dispatch.recover({ ...target, rebindToCurrentConnection: true }, proof);
    expect(rebound?.destination?.generation).toBe("22222222-2222-4222-8222-222222222222");
    expect(rebound?.recoveries?.[0]).toMatchObject({
      previousGeneration: "11111111-1111-4111-8111-111111111111",
    });
    await dispatch.deliver(row._id);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
  });

  it("a disconnected Business blocks before any provider call", async () => {
    const { booking, row } = await seed();
    google.current = null;
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(await read(booking._id)).toMatchObject({
      state: "BLOCKED_AUTHORITY",
      reason: "CONNECTION_GENERATION_OR_DESTINATION_CHANGED",
    });
    expect(google.calls).toHaveLength(0);
  });

  it("a rate-limited insert had no effect and is retried later", async () => {
    const { booking, row } = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("RETRYABLE_FAILURE", true),
      apply: false,
    };
    expect(await dispatch.deliver(row._id)).toBe("RETRY");
    expect(await read(booking._id)).toMatchObject({
      state: "RETRYABLE_FAILURE",
      createIssued: false,
    });
    await dispatch.deliver(row._id);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.count("insert")).toBe(2);
    expect(google.events.size).toBe(1);
  });

  it("a newer Booking revision committed after observation is never written from the old claim", async () => {
    const { booking, row } = await seed();
    const moved = reschedule(booking, 120);
    google.onRead = async () => {
      google.onRead = undefined;
      await commit(moved);
    };
    expect(await dispatch.deliver(row._id)).toBe("RETRY");
    expect(google.count("insert")).toBe(0);
    await dispatch.deliver(row._id);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.events.get(ordinaryCalendarEventId(booking._id))?.startAt).toEqual(
      moved.schedule.startAt,
    );
  });

  it("an unowned event already holding the id is never adopted or modified", async () => {
    const { booking, row } = await seed();
    google.events.set(ordinaryCalendarEventId(booking._id), {
      status: "confirmed",
      startAt: new Date(0),
      endAt: new Date(1),
      timezone: "UTC",
      marker: {},
      etag: '"foreign"',
    });
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(await read(booking._id)).toMatchObject({
      state: "PERMANENT_FAILURE",
      reason: "EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED",
    });
    expect(google.calls.filter((call) => call !== "read")).toHaveLength(0);
  });

  it("a send permission cannot be consumed without its exact issued request", async () => {
    const { booking, row } = await seed();
    const binding = {
      journalId: row._id,
      bookingId: String(booking._id),
      businessId: String(booking.businessId),
      eventId: ordinaryCalendarEventId(booking._id),
      destination: row.destination!,
    };
    const event = {
      startAt: booking.schedule.startAt,
      endAt: booking.schedule.endAt,
      timezone: booking.schedule.timezone,
      summary: `Bookly — ${booking.reference}`,
      description: `Booking ${booking.reference} (1 service line(s))`,
    };
    await expect(
      consumeOrdinaryCalendarSendPermission(binding, {
        kind: "INSERT",
        requestId: "00000000-0000-4000-8000-000000000000",
        event,
      }),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY" });
    const claim = await repository.prepare(row);
    const issued = await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" });
    await consumeOrdinaryCalendarSendPermission(binding, {
      kind: "INSERT",
      requestId: issued!.request.id,
      event,
    });
    await expect(
      consumeOrdinaryCalendarSendPermission(binding, {
        kind: "INSERT",
        requestId: issued!.request.id,
        event,
      }),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY" });
  });

  it("the worker processes only due journal-owned rows, stops on request, and is default-denied", async () => {
    const owned = await seed();
    authority.authoritative = false;
    const legacy = buildBooking();
    expect(
      await inTxn((session) => journal.recordCreatedInTransaction(legacy, session)),
    ).toBeNull();
    const worker = new OrdinaryCalendarWorker(dispatch, repository, { batchSize: 10 });
    expect(await worker.runOnce(() => true)).toMatchObject({ scanned: 1, done: 0, retry: 0 });
    expect(google.calls).toHaveLength(0);
    expect(await worker.runOnce()).toMatchObject({ scanned: 1, done: 1 });
    expect(await worker.runOnce()).toMatchObject({ scanned: 0 });
    expect((await read(owned.booking._id))?.state).toBe("CONFIRMED");
    authority.delivery = false;
    await expect(worker.runOnce()).rejects.toThrow("ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE");
    await expect(dispatch.deliver(owned.row._id)).rejects.toThrow(
      "ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE",
    );
    expect(await OrdinaryCalendarJournalModel.countDocuments({})).toBe(1);
  });

  // --- P4B-2C: disconnected integrations, monitoring, shutdown and Package isolation ----------

  const connectIntegration = async (
    businessId: Types.ObjectId,
    overrides: Partial<OrdinaryCalendarDestination> = {},
  ) => {
    const integrationId = new Types.ObjectId();
    const destination = destinationFor(businessId, { _id: integrationId }, overrides);
    await GoogleCalendarIntegrationModel.collection.deleteMany({ businessId });
    await GoogleCalendarIntegrationModel.collection.insertOne({
      _id: integrationId,
      businessId,
      googleAccountEmail: destination.accountEmail,
      googleAccountId: destination.accountId,
      calendarId: destination.configuredCalendarId,
      connectionGeneration: destination.generation,
      encryptedAccessToken: "x",
      encryptedRefreshToken: "y",
      tokenExpiresAt: new Date(),
      status: "CONNECTED",
      connectedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    google.current = destination;
    return destination;
  };

  /** A journal-owned Booking created while the Business had no Calendar connection. */
  const seedDisconnected = async () => {
    const booking = buildBooking();
    await BusinessModel.collection.insertOne({
      _id: booking.businessId,
      ownerUserId: ownerId,
      name: "Salon",
    } as never);
    const row = await inTxn(async (session) => {
      await BookingModel.collection.insertOne(booking as never, { session });
      return journal.recordCreatedInTransaction(booking, session);
    });
    return { booking, row: row! };
  };
  const status = async (bookingId: Types.ObjectId) =>
    describeOrdinaryCalendarSync(
      await read(bookingId),
      clock(),
      ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
    );

  it("a Booking created while disconnected is visible as NOT_CONNECTED and syncs only after an explicit Owner bind", async () => {
    const { booking, row } = await seedDisconnected();
    expect(row).toMatchObject({
      mode: "AUTHORITATIVE",
      state: "BLOCKED_AUTHORITY",
      reason: "CALENDAR_NOT_CONNECTED_AT_CREATION",
    });
    expect((await status(booking._id)).status).toBe("NOT_CONNECTED");
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(await repository.listDue(10)).toHaveLength(0);

    // Connecting Google later sends nothing on its own: a new token is not destination authority.
    const destination = await connectIntegration(booking.businessId);
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(google.calls).toHaveLength(0);

    const proof = await ownerProof();
    const target = {
      bookingId: String(booking._id),
      businessId: String(booking.businessId),
      actorUserId: String(ownerId),
      incidentReference: "INC-3",
      assertion: "NO_UNRESOLVED_REQUEST" as const,
    };
    await expect(dispatch.recover(target, proof)).rejects.toThrow(
      "explicit unused-destination bind",
    );
    await expect(
      dispatch.recover({ ...target, rebindToCurrentConnection: true }, proof),
    ).rejects.toThrow("explicit unused-destination bind");
    const bound = await dispatch.recover({ ...target, bindUnusedDestination: true }, proof);
    expect(bound).toMatchObject({
      state: "RETRYABLE_FAILURE",
      createIssued: false,
      destination: { generation: destination.generation, accountId: destination.accountId },
      recoveries: [{ binding: "UNUSED_DESTINATION_BIND", incidentReference: "INC-3" }],
    });
    expect(bound?.recoveries?.[0]?.previousGeneration).toBeUndefined();
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.count("insert")).toBe(1);
    expect((await status(booking._id)).status).toBe("SYNCED");
  });

  it("a Booking cancelled while disconnected and never written settles without any provider call", async () => {
    const { booking, row } = await seedDisconnected();
    await commit(cancel(booking));
    expect(await read(booking._id)).toMatchObject({
      state: "PENDING",
      reason: "CANCELLED_BEFORE_ANY_CALENDAR_WRITE",
    });
    expect(await repository.listDue(10)).toHaveLength(1);
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.calls).toHaveLength(0);
    expect(await read(booking._id)).toMatchObject({
      state: "CONFIRMED",
      latest: { desired: { kind: "ABSENT" } },
    });
  });

  it("an existing event is never moved to a different account, even by an explicit unused-destination bind", async () => {
    const { booking, row, integrationId } = await seed();
    await dispatch.deliver(row._id);
    expect(google.count("insert")).toBe(1);
    // The Owner reconnects a different Google account; the old credentials are gone.
    await connectIntegration(booking.businessId, {
      accountId: "acct-2",
      accountEmail: "other@example.com",
      generation: "44444444-4444-4444-8444-444444444444",
    });
    await commit(cancel(booking)); // Cancelled while the original account is unavailable.
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    expect(await status(booking._id)).toMatchObject({
      status: "RECOVERY_REQUIRED",
      incident: "CONNECTION_OR_DESTINATION_MISMATCH",
    });
    const proof = await ownerProof();
    const target = {
      bookingId: String(booking._id),
      businessId: String(booking.businessId),
      actorUserId: String(ownerId),
      incidentReference: "INC-4",
      assertion: "NO_UNRESOLVED_REQUEST" as const,
    };
    await expect(
      dispatch.recover({ ...target, bindUnusedDestination: true }, proof),
    ).rejects.toThrow("never adopted automatically");
    await expect(
      dispatch.recover({ ...target, rebindToCurrentConnection: true }, proof),
    ).rejects.toThrow("never adopted automatically");
    expect(google.calls.filter((call) => call !== "read")).toEqual(["insert"]);

    // Reconnecting the ORIGINAL account lets the Owner rebind, and the cancellation is applied.
    google.current = destinationFor(
      booking.businessId,
      { _id: integrationId },
      { generation: "55555555-5555-4555-8555-555555555555" },
    );
    expect(
      (await dispatch.recover({ ...target, rebindToCurrentConnection: true }, proof))
        ?.recoveries?.[0],
    ).toMatchObject({
      binding: "SAME_ACCOUNT_REBIND",
      previousGeneration: "11111111-1111-4111-8111-111111111111",
    });
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.events.get(ordinaryCalendarEventId(booking._id))?.status).toBe("cancelled");
  });

  it("a destination lost before the first write may be bound to the Owner's new account explicitly", async () => {
    const { booking, row } = await seed();
    const replacement = await connectIntegration(booking.businessId, {
      accountId: "acct-9",
      accountEmail: "new@example.com",
      generation: "66666666-6666-4666-8666-666666666666",
    });
    expect(await dispatch.deliver(row._id)).toBe("BLOCKED");
    const proof = await ownerProof();
    const bound = await dispatch.recover(
      {
        bookingId: String(booking._id),
        businessId: String(booking.businessId),
        actorUserId: String(ownerId),
        incidentReference: "INC-5",
        assertion: "NO_UNRESOLVED_REQUEST",
        bindUnusedDestination: true,
      },
      proof,
    );
    expect(bound?.destination).toMatchObject({
      accountId: "acct-9",
      generation: replacement.generation,
    });
    expect(await dispatch.deliver(row._id)).toBe("DONE");
    expect(google.count("insert")).toBe(1);
  });

  it("classifies durable incidents and counts repeated retryable failures until confirmation", async () => {
    const retrying = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("RETRYABLE_FAILURE", true),
      apply: false,
    };
    await dispatch.deliver(retrying.row._id);
    let current = await read(retrying.booking._id);
    expect(current?.retryableFailures).toBe(1);
    expect(
      classifyOrdinaryCalendarIncident(current!, clock(), ORDINARY_CALENDAR_ISSUER_WINDOW_MS),
    ).toMatchObject({ category: "PROVIDER_RETRYING", recoveryRequired: false });
    await dispatch.deliver(retrying.row._id);
    current = await read(retrying.booking._id);
    expect(current?.state).toBe("CONFIRMED");
    expect(current?.retryableFailures).toBeUndefined();
    expect(
      classifyOrdinaryCalendarIncident(current!, clock(), ORDINARY_CALENDAR_ISSUER_WINDOW_MS),
    ).toBeNull();

    await clearIsolatedDatabase();
    const unknown = await seed();
    google.failures.insert = {
      error: new PackageCalendarProviderError("UNKNOWN_OUTCOME"),
      apply: false,
    };
    await dispatch.deliver(unknown.row._id);
    expect(
      classifyOrdinaryCalendarIncident(
        (await read(unknown.booking._id))!,
        clock(),
        ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
      ),
    ).toMatchObject({ category: "PROVIDER_OUTCOME_UNKNOWN", recoveryRequired: true });

    const stuckRow = await seed();
    const claim = await repository.prepare(stuckRow.row);
    await repository.issue(claim!.journal, claim!.token, { kind: "INSERT" });
    expect(
      classifyOrdinaryCalendarIncident(
        (await read(stuckRow.booking._id))!,
        clock(),
        ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
      ),
    ).toBeNull();
    advance(3 * 60_000);
    expect(
      classifyOrdinaryCalendarIncident(
        (await read(stuckRow.booking._id))!,
        clock(),
        ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
      ),
    ).toMatchObject({ category: "REQUEST_STUCK_BEYOND_OBSERVATION_WINDOW" });

    const linked = await seed();
    await BookingModel.updateOne(
      { _id: linked.booking._id },
      { $set: { googleCalendarEventId: "legacy-random-id" } },
    );
    await dispatch.deliver(linked.row._id);
    expect(
      classifyOrdinaryCalendarIncident(
        (await read(linked.booking._id))!,
        clock(),
        ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
      ),
    ).toMatchObject({ category: "BOOKING_AUTHORITY_CHECK_FAILED", recoveryRequired: true });

    const categories = (await repository.listIncidents(50, ORDINARY_CALENDAR_ISSUER_WINDOW_MS))
      .map(
        (row) =>
          classifyOrdinaryCalendarIncident(row, clock(), ORDINARY_CALENDAR_ISSUER_WINDOW_MS)
            ?.category,
      )
      .sort();
    expect(categories).toEqual([
      "BOOKING_AUTHORITY_CHECK_FAILED",
      "PROVIDER_OUTCOME_UNKNOWN",
      "REQUEST_STUCK_BEYOND_OBSERVATION_WINDOW",
    ]);
  });

  it("a worker stopped mid-batch reports the remaining due rows and logs an incident summary", async () => {
    const first = await seed();
    await clearIsolatedDatabase();
    await seed();
    await seed();
    void first;
    const warn = vi.spyOn(logger, "warn");
    let delivered = 0;
    const worker = new OrdinaryCalendarWorker(
      {
        deliver: async (id) => {
          delivered += 1;
          return dispatch.deliver(id);
        },
      },
      repository,
      { batchSize: 10 },
      clock,
    );
    const counts = await worker.runOnce(() => delivered >= 1);
    expect(counts).toMatchObject({ scanned: 2, done: 1, interrupted: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ORDINARY_CALENDAR_WORKER_STOPPED_WITH_DUE_WORK",
        remaining: 1,
      }),
      expect.any(String),
    );
    // The interrupted row is still due and completes on the next pass.
    expect(await worker.runOnce()).toMatchObject({ scanned: 1, done: 1, interrupted: 0 });
    google.failures.insert = {
      error: new PackageCalendarProviderError("UNKNOWN_OUTCOME"),
      apply: false,
    };
    const third = await seed();
    await worker.runOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ORDINARY_CALENDAR_INCIDENTS",
        incidents: expect.objectContaining({ PROVIDER_OUTCOME_UNKNOWN: 1 }),
      }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/token|Bearer|encrypted/i);
    void third;
    warn.mockRestore();
  });

  it("enabling ordinary delivery never grants Package Calendar production authority", async () => {
    await expect(verifyPackageCalendarProductionAuthority()).rejects.toMatchObject({
      code: "PACKAGE_CALENDAR_WRITE_AUTHORITY_UNAVAILABLE",
    });
  });
});
