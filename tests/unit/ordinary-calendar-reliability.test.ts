import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P2.2.9 — the real ordinary Calendar consumer, driven against an in-memory journal repository
// (same CAS preconditions as the MongoDB one) and an in-memory Google Calendar. No database,
// no Google, no worker: deterministic clock and jitter.
vi.mock("../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => true,
  verifyOrdinaryCalendarDeliveryAuthority: async () => undefined,
}));

const { BookingModel } = await import("../../src/modules/booking/booking.model.js");
const { BusinessModel } = await import("../../src/modules/business/business.model.js");
const { PaymentAttemptModel } = await import("../../src/modules/payment/payment-attempt.model.js");
const { OrdinaryCalendarDispatch } = await import(
  "../../src/modules/booking/ordinary-calendar-dispatch.js"
);
const { PackageCalendarProviderError } = await import(
  "../../src/modules/booking/package-calendar-delivery.js"
);
const journalModule = await import("../../src/modules/booking/ordinary-calendar-journal.js");
const { ordinaryCalendarDesired, ordinaryCalendarRevision, ordinaryCalendarEventId } =
  journalModule;
const { classifyOrdinaryCalendarIncident, describeOrdinaryCalendarSync } = await import(
  "../../src/modules/booking/ordinary-calendar-incident.js"
);
const retry = await import("../../src/modules/booking/ordinary-calendar-retry.js");

type Journal =
  import("../../src/modules/booking/ordinary-calendar-journal.model.js").OrdinaryCalendarJournalDocument;
type Booking = import("../../src/modules/booking/booking.model.js").BookingDocument;
type Destination =
  import("../../src/modules/booking/ordinary-calendar-journal.model.js").OrdinaryCalendarDestination;

// --- deterministic world ---------------------------------------------------------------------
let now: number;
const clock = () => new Date(now);
const MIN = 60_000;

const destination: Destination = {
  integrationId: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
  generation: "gen-1",
  accountId: "acct-1",
  accountEmail: "owner@example.test",
  configuredCalendarId: "primary",
};

const copy = (row: Journal): Journal =>
  ({
    ...row,
    latest: { ...row.latest, desired: { ...row.latest.desired } },
    ...(row.request ? { request: { ...row.request } } : {}),
    ...(row.lease ? { lease: { ...row.lease } } : {}),
  }) as Journal;

/** In-memory twin of OrdinaryCalendarJournalRepository's CAS rules used by the consumer. */
class MemoryJournals {
  rows = new Map<string, Journal>();
  blocks: Array<{ state: string; reason: string; nextAttemptAt?: Date | undefined }> = [];
  acknowledgements: Array<{ state: string; nextAttemptAt?: Date | undefined }> = [];
  private n = 0;
  private row(id: Types.ObjectId | string) {
    const row = this.rows.get(String(id));
    if (!row) throw new Error("missing row");
    return row;
  }
  async findById(id: Types.ObjectId | string) {
    const row = this.rows.get(String(id));
    return row ? copy(row) : null;
  }
  async prepare(journal: Journal) {
    const row = this.row(journal._id);
    if (
      row.latest.sequence !== journal.latest.sequence ||
      !["PENDING", "RETRYABLE_FAILURE", "DISPATCH_PREPARED"].includes(row.state) ||
      (row.lease && row.lease.expiresAt.getTime() > now) ||
      (row.request && !row.request.settled)
    )
      return null;
    const token = `lease-${++this.n}`;
    row.state = "DISPATCH_PREPARED";
    row.lease = { token, expiresAt: new Date(now + 45_000) };
    return { journal: copy(row), token };
  }
  async issue(
    journal: Journal,
    token: string,
    request: { kind: "INSERT" | "PATCH" | "DELETE"; etag?: string },
  ) {
    const row = this.row(journal._id);
    if (
      row.state !== "DISPATCH_PREPARED" ||
      row.lease?.token !== token ||
      row.latest.sequence !== journal.latest.sequence ||
      (request.kind === "INSERT" && row.createIssued) ||
      (row.request && !row.request.settled)
    )
      return null;
    const next = {
      id: `req-${++this.n}`,
      kind: request.kind,
      sequence: row.latest.sequence,
      revision: row.latest.revision,
      issuedAt: new Date(now),
      settled: false,
      providerStarted: false,
      ...(request.etag ? { etag: request.etag } : {}),
    };
    row.state = "REQUEST_ISSUED";
    row.request = next;
    if (request.kind === "INSERT") row.createIssued = true;
    return { journal: copy(row), request: next };
  }
  async acknowledge(
    id: Types.ObjectId,
    requestId: string,
    outcome: {
      state: Journal["state"];
      definitiveNoEffect: boolean;
      reason?: string;
      nextAttemptAt?: Date;
    },
  ) {
    const row = this.row(id);
    if (row.request?.id !== requestId || row.request.settled) return false;
    this.acknowledgements.push({ state: outcome.state, nextAttemptAt: outcome.nextAttemptAt });
    const settled = outcome.definitiveNoEffect || outcome.state !== "UNKNOWN_OUTCOME";
    row.request.settled = settled;
    row.state =
      row.request.sequence === row.latest.sequence
        ? outcome.state
        : settled
          ? "PENDING"
          : "UNKNOWN_OUTCOME";
    if (outcome.definitiveNoEffect && row.request.kind === "INSERT") row.createIssued = false;
    if (outcome.reason) row.reason = outcome.reason;
    row.nextAttemptAt = outcome.nextAttemptAt ?? new Date(now);
    if (outcome.state === "RETRYABLE_FAILURE" || outcome.state === "UNKNOWN_OUTCOME")
      row.retryableFailures = (row.retryableFailures ?? 0) + 1;
    row.lease = undefined;
    return true;
  }
  async confirm(journal: Journal) {
    const row = this.row(journal._id);
    if (
      row.latest.sequence !== journal.latest.sequence ||
      row.latest.revision !== journal.latest.revision
    )
      return false;
    row.state = "CONFIRMED";
    row.confirmedSequence = row.latest.sequence;
    row.confirmedRevision = row.latest.revision;
    row.confirmedAt = new Date(now);
    if (row.request) row.request.settled = true;
    row.lease = undefined;
    row.nextAttemptAt = undefined;
    row.reason = undefined;
    row.retryableFailures = undefined;
    return true;
  }
  async block(journal: Journal, state: Journal["state"], reason: string, nextAttemptAt?: Date) {
    const row = this.row(journal._id);
    if (row.latest.sequence !== journal.latest.sequence) return false;
    const terminal = state === "BLOCKED_AUTHORITY" || state === "PERMANENT_FAILURE";
    this.blocks.push({ state, reason, nextAttemptAt });
    row.state = state;
    row.reason = reason;
    row.nextAttemptAt = terminal ? undefined : (nextAttemptAt ?? new Date(now));
    if (state === "RETRYABLE_FAILURE" || state === "UNKNOWN_OUTCOME")
      row.retryableFailures = (row.retryableFailures ?? 0) + 1;
    row.lease = undefined;
    return true;
  }
  async reopen(journal: Journal) {
    const row = this.row(journal._id);
    if (row.state !== "UNKNOWN_OUTCOME") return false;
    row.state = "RETRYABLE_FAILURE";
    return true;
  }
  async abandonUnstarted(id: Types.ObjectId, requestId: string) {
    const row = this.row(id);
    if (row.request?.id !== requestId || row.request.settled || row.request.providerStarted)
      return false;
    row.request.settled = true;
    row.state = "RETRYABLE_FAILURE";
    if (row.request.kind === "INSERT") row.createIssued = false;
    return true;
  }
}

type GoogleEvent = {
  status: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  marker: Record<string, string>;
  etag: string;
};
type Behaviour =
  | "OK"
  | "CREATE_THEN_TIMEOUT"
  | { error: InstanceType<typeof PackageCalendarProviderError> };

/** In-memory Google Calendar for one Business connection. */
class MemoryGoogle {
  events = new Map<string, GoogleEvent>();
  calls: string[] = [];
  connected = true;
  readFailure: InstanceType<typeof PackageCalendarProviderError> | undefined;
  next: Behaviour = "OK";
  private etags = 0;
  constructor(private readonly journals: MemoryJournals) {}
  provider() {
    return {
      assertCurrent: async (_businessId: string, d: Destination) => {
        if (!this.connected || d.generation !== destination.generation)
          throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
      },
      currentDestination: async () => (this.connected ? destination : null),
      bind: (binding: {
        journalId: Types.ObjectId;
        bookingId: string;
        businessId: string;
        eventId: string;
      }) => {
        // The real port consumes the one-time send permission right before Google.
        const start = () => {
          const row = this.journals.rows.get(String(binding.journalId));
          if (row?.request) row.request.providerStarted = true;
        };
        const behave = () => {
          const b = this.next;
          this.next = "OK";
          if (typeof b === "object") throw b.error;
          return b;
        };
        return {
          read: async () => {
            this.calls.push(`GET ${binding.eventId}`);
            if (this.readFailure) throw this.readFailure;
            const e = this.events.get(binding.eventId);
            return e
              ? {
                  outcome: "FOUND" as const,
                  status: e.status,
                  startAt: e.startAt,
                  endAt: e.endAt,
                  marker: e.marker,
                  etag: e.etag,
                }
              : { outcome: "NOT_FOUND" as const };
          },
          insert: async (
            event: { startAt: Date; endAt: Date; timezone: string },
            _requestId: string,
          ) => {
            start();
            this.calls.push(`INSERT ${binding.eventId}`);
            const b = behave();
            if (this.events.has(binding.eventId)) return "ALREADY_EXISTS" as const;
            this.events.set(binding.eventId, {
              status: "confirmed",
              startAt: event.startAt,
              endAt: event.endAt,
              timezone: event.timezone,
              marker: { booklyBookingId: binding.bookingId, booklyBusinessId: binding.businessId },
              etag: `"e${++this.etags}"`,
            });
            if (b === "CREATE_THEN_TIMEOUT")
              throw new PackageCalendarProviderError("UNKNOWN_OUTCOME");
            return "CREATED" as const;
          },
          patchSchedule: async (
            s: { startAt: Date; endAt: Date; timezone: string },
            etag: string,
          ) => {
            start();
            this.calls.push(`PATCH ${binding.eventId}`);
            behave();
            const e = this.events.get(binding.eventId);
            if (!e) return "NOT_FOUND" as const;
            if (e.etag !== etag) return "PRECONDITION_FAILED" as const;
            Object.assign(e, {
              startAt: s.startAt,
              endAt: s.endAt,
              timezone: s.timezone,
              etag: `"e${++this.etags}"`,
            });
            return "UPDATED" as const;
          },
          remove: async (etag: string) => {
            start();
            this.calls.push(`DELETE ${binding.eventId}`);
            behave();
            const e = this.events.get(binding.eventId);
            if (e && e.etag !== etag) return "PRECONDITION_FAILED" as const;
            this.events.delete(binding.eventId);
            return "DELETED" as const;
          },
        };
      },
    };
  }
  writes() {
    return this.calls.filter((call) => !call.startsWith("GET"));
  }
}

// --- Bookings in the authoritative store ----------------------------------------------------
const businessId = new Types.ObjectId();
const bookings = new Map<string, Booking>();
let businessExists = true;

function booking(
  kind: "NORMAL" | "LEGACY_PACKAGE" | "FIRST_CLASS" = "NORMAL",
  start = "2026-01-15T08:00:00.000Z",
): Booking {
  const id = new Types.ObjectId();
  const line =
    kind === "NORMAL"
      ? { serviceSnapshot: { pricingMode: "FIXED" }, pricingInput: {} }
      : kind === "LEGACY_PACKAGE"
        ? {
            serviceSnapshot: { pricingMode: "PACKAGE" },
            pricingInput: { packageProgressId: new Types.ObjectId(), sessionIndex: 2 },
          }
        : {
            serviceSnapshot: { pricingMode: "PACKAGE" },
            pricingInput: { packageItemId: new Types.ObjectId() },
            packageContext: { role: "REDEMPTION" },
          };
  const startAt = new Date(start);
  const b = {
    _id: id,
    businessId,
    reference: `BK-${id.toHexString().slice(-6)}`,
    status: "UPCOMING",
    serviceLines: [line],
    schedule: {
      startAt,
      endAt: new Date(startAt.getTime() + 60 * MIN),
      timezone: "Europe/Nicosia",
    },
    customer: { businessClientId: new Types.ObjectId(), customerUserId: new Types.ObjectId() },
    eventHistory: [{}],
    rescheduleHistory: [],
    googleCalendarEventId: undefined,
  } as unknown as Booking;
  bookings.set(String(id), b);
  return b;
}

function record(journals: MemoryJournals, b: Booking, existing?: Journal): Journal {
  const desired = ordinaryCalendarDesired(b);
  if (!desired) throw new Error("no calendar intent");
  const latest = {
    sequence: (existing?.latest.sequence ?? 0) + 1,
    revision: ordinaryCalendarRevision(b, desired),
    desired,
    source: desired.kind === "ABSENT" ? "CANCELLED" : existing ? "RESCHEDULED" : "CREATED",
    bookingStatus: b.status,
    eventVersion: b.eventHistory.length,
    rescheduleVersion: b.rescheduleHistory.length,
    recordedAt: new Date(now),
  } as Journal["latest"];
  const row = (
    existing
      ? { ...journals.rows.get(String(existing._id)), latest, state: "PENDING" }
      : {
          _id: new Types.ObjectId(),
          version: 1,
          bookingId: b._id,
          businessId: b.businessId,
          businessClientId: b.customer.businessClientId,
          customerUserId: b.customer.customerUserId,
          mode: "AUTHORITATIVE",
          eventIdentity: { kind: "ALLOCATED", eventId: ordinaryCalendarEventId(b._id) },
          destination,
          latest,
          state: "PENDING",
          createIssued: false,
        }
  ) as Journal;
  journals.rows.set(String(row._id), row);
  return row;
}

function reschedule(b: Booking, start: string) {
  const startAt = new Date(start);
  b.schedule = { ...b.schedule, startAt, endAt: new Date(startAt.getTime() + 60 * MIN) };
  (b.rescheduleHistory as unknown[]).push({});
  (b.eventHistory as unknown[]).push({});
}
function cancel(b: Booking) {
  b.status = "CANCELLED_BY_CUSTOMER" as Booking["status"];
  (b.eventHistory as unknown[]).push({});
}

let journals: MemoryJournals;
let google: MemoryGoogle;
let dispatch: InstanceType<typeof OrdinaryCalendarDispatch>;
let bookingWrites: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  now = Date.parse("2026-01-10T10:00:00.000Z");
  bookings.clear();
  businessExists = true;
  journals = new MemoryJournals();
  google = new MemoryGoogle(journals);
  dispatch = new OrdinaryCalendarDispatch(google.provider(), clock, journals as never, () => 0.5);
  const chain = (value: () => unknown) => {
    const q = { read: () => q, maxTimeMS: () => q, exec: async () => value() };
    return q;
  };
  vi.spyOn(BookingModel, "findOne").mockImplementation(((filter: {
    _id: Types.ObjectId;
    businessId: Types.ObjectId;
  }) =>
    chain(() => {
      const b = bookings.get(String(filter._id));
      return b && String(b.businessId) === String(filter.businessId) ? b : null;
    })) as never);
  vi.spyOn(BusinessModel, "exists").mockImplementation((() => {
    const q = {
      read: () => q,
      maxTimeMS: async () => (businessExists ? { _id: businessId } : null),
    };
    return q;
  }) as never);
  bookingWrites = [
    vi.spyOn(BookingModel, "updateOne"),
    vi.spyOn(BookingModel, "updateMany"),
    vi.spyOn(BookingModel, "findOneAndUpdate"),
    vi.spyOn(PaymentAttemptModel, "updateOne"),
    vi.spyOn(PaymentAttemptModel, "findOneAndUpdate"),
    vi.spyOn(PaymentAttemptModel, "create"),
  ];
});
afterEach(() => {
  for (const spy of bookingWrites) expect(spy).not.toHaveBeenCalled(); // sync never touches money/Bookings
  vi.restoreAllMocks();
});

const rowOf = (j: Journal) => journals.rows.get(String(j._id)) as Journal;

// --- tests --------------------------------------------------------------------------------------

describe("P2.2.9 retry policy", () => {
  it("backs off exponentially with bounded jitter and a 6 h ceiling", () => {
    const at = (previousFailures: number, random: number) =>
      retry.ordinaryCalendarRetryDelayMs({
        previousFailures,
        kind: "RETRYABLE",
        random: () => random,
      });
    expect([0, 1, 2, 3].map((n) => at(n, 0.5))).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
    expect(at(0, 0)).toBe(48_000); // -20%
    expect(at(0, 0.999999)).toBeLessThanOrEqual(72_000); // +20%
    expect(at(30, 0.999999)).toBe(6 * 60 * MIN);
    expect(
      retry.ordinaryCalendarRetryDelayMs({
        previousFailures: 0,
        kind: "UNCERTAIN",
        random: () => 0.5,
      }),
    ).toBe(15 * MIN);
  });

  it("honours a longer Retry-After (capped at 24 h) but never retries sooner than its own backoff", () => {
    const delay = (retryAfterMs: number) =>
      retry.ordinaryCalendarRetryDelayMs({
        previousFailures: 3,
        kind: "RETRYABLE",
        retryAfterMs,
        random: () => 0.5,
      });
    expect(delay(30 * MIN)).toBe(30 * MIN);
    expect(delay(10_000)).toBe(8 * MIN);
    expect(delay(48 * 60 * MIN)).toBe(24 * 60 * MIN);
  });

  it("stops after the configured number of consecutive failures", () => {
    expect(
      retry.ordinaryCalendarRetryExhausted(
        retry.ORDINARY_CALENDAR_RETRY_POLICY.maxConsecutiveFailures - 2,
      ),
    ).toBe(false);
    expect(
      retry.ordinaryCalendarRetryExhausted(
        retry.ORDINARY_CALENDAR_RETRY_POLICY.maxConsecutiveFailures - 1,
      ),
    ).toBe(true);
  });
});

describe("P2.2.9 Booking lifecycle → Google Calendar", () => {
  it("Normal Booking: creates exactly one event with the deterministic id and confirms by read-back", async () => {
    const b = booking("NORMAL");
    const j = record(journals, b);
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([`INSERT o${b._id.toHexString()}`]);
    const event = google.events.get(`o${b._id.toHexString()}`);
    expect(event).toMatchObject({
      startAt: b.schedule.startAt,
      endAt: b.schedule.endAt,
      timezone: "Europe/Nicosia",
    });
    expect(rowOf(j)).toMatchObject({
      state: "CONFIRMED",
      confirmedSequence: 1,
      confirmedAt: new Date(now),
    });

    // Repeated delivery of the same state: no provider call at all, still one event.
    google.calls = [];
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.calls).toEqual([]);
    expect(google.events.size).toBe(1);
  });

  it("Legacy Package Booking uses the same reliable path; First-Class is never handled here", async () => {
    const legacy = booking("LEGACY_PACKAGE");
    expect(await dispatch.deliver(record(journals, legacy)._id)).toBe("DONE");
    expect(google.events.has(`o${legacy._id.toHexString()}`)).toBe(true);

    const firstClass = booking("FIRST_CLASS");
    expect(journalModule.isOrdinaryCalendarBooking(firstClass)).toBe(false);
    google.calls = [];
    // Even a forged row for a First-Class Booking is refused before any provider call.
    const forged = record(journals, { ...firstClass, status: "UPCOMING" } as Booking);
    expect(await dispatch.deliver(forged._id)).toBe("BLOCKED");
    expect(rowOf(forged)).toMatchObject({
      state: "PERMANENT_FAILURE",
      reason: "NOT_AN_ORDINARY_BOOKING",
    });
    expect(google.calls).toEqual([]);
  });

  it("reschedule PATCHes the same event (ETag-conditional) — never a second event", async () => {
    const b = booking();
    const j = record(journals, b);
    await dispatch.deliver(j._id);
    reschedule(b, "2026-01-16T09:30:00.000Z");
    record(journals, b, rowOf(j));
    google.calls = [];
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([`PATCH o${b._id.toHexString()}`]);
    expect(google.events.size).toBe(1);
    expect(google.events.get(`o${b._id.toHexString()}`)?.startAt.toISOString()).toBe(
      "2026-01-16T09:30:00.000Z",
    );
  });

  it("cancellation deletes the event; redelivery never recreates it", async () => {
    const b = booking();
    const j = record(journals, b);
    await dispatch.deliver(j._id);
    cancel(b);
    record(journals, b, rowOf(j));
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.events.size).toBe(0);
    google.calls = [];
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([]);
  });

  it("cancelled before any create was issued: settled with zero provider calls (no resurrection)", async () => {
    const b = booking();
    const j = record(journals, b);
    cancel(b);
    record(journals, b, rowOf(j));
    google.connected = false; // even while disconnected
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.calls).toEqual([]);
    expect(rowOf(j).state).toBe("CONFIRMED");
  });

  it("a stale delivery never overwrites a newer Booking time", async () => {
    const b = booking();
    const j = record(journals, b);
    await dispatch.deliver(j._id);
    // The Booking committed a reschedule, but the journal row has not recorded it yet.
    reschedule(b, "2026-01-20T12:00:00.000Z");
    google.calls = [];
    rowOf(j).state = "PENDING";
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j)).toMatchObject({
      state: "BLOCKED_AUTHORITY",
      reason: "BOOKING_JOURNAL_REVISION_MISMATCH",
    });
    expect(google.writes()).toEqual([]);
    expect(google.events.get(`o${b._id.toHexString()}`)?.startAt.toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("reschedule racing cancellation: the latest Booking state (cancelled) wins", async () => {
    const b = booking();
    const j = record(journals, b);
    await dispatch.deliver(j._id);
    reschedule(b, "2026-01-16T09:30:00.000Z");
    record(journals, b, rowOf(j));
    cancel(b);
    record(journals, b, rowOf(j));
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([
      `INSERT o${b._id.toHexString()}`,
      `DELETE o${b._id.toHexString()}`,
    ]);
    expect(google.events.size).toBe(0);
  });
});

describe("P2.2.9 duplicates, uncertainty and crashes", () => {
  it("ambiguous create (Google created it, the answer was lost) is reconciled by read — one event, one insert", async () => {
    const b = booking();
    const j = record(journals, b);
    google.next = "CREATE_THEN_TIMEOUT";
    expect(await dispatch.deliver(j._id)).toBe("RETRY");
    expect(rowOf(j)).toMatchObject({
      state: "UNKNOWN_OUTCOME",
      createIssued: true,
      retryableFailures: 1,
    });
    expect(journals.acknowledgements.at(-1)?.nextAttemptAt?.getTime()).toBe(now + 15 * MIN);

    now += 16 * MIN;
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([`INSERT o${b._id.toHexString()}`]);
    expect(google.events.size).toBe(1);
    expect(rowOf(j).retryableFailures).toBeUndefined();
  });

  it("a missing event after an issued create never authorizes a second insert", async () => {
    const b = booking();
    const j = record(journals, b);
    google.next = "CREATE_THEN_TIMEOUT";
    await dispatch.deliver(j._id);
    google.events.clear(); // e.g. Google lost it / it was removed by hand
    now += 16 * MIN;
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(google.writes()).toEqual([`INSERT o${b._id.toHexString()}`]);
    expect(classifyOrdinaryCalendarIncident(rowOf(j), clock(), 2 * MIN)?.recoveryRequired).toBe(
      true,
    );
  });

  it("concurrent deliveries of one Booking issue a single insert", async () => {
    const b = booking();
    const j = record(journals, b);
    const results = await Promise.all([
      dispatch.deliver(j._id),
      dispatch.deliver(j._id),
      dispatch.deliver(j._id),
    ]);
    expect(results).toContain("DONE");
    expect(google.writes()).toEqual([`INSERT o${b._id.toHexString()}`]);
  });

  it("a worker that crashed after recording the request but before calling Google is recovered without duplicates", async () => {
    const b = booking();
    const j = record(journals, b);
    const claim = await journals.prepare(rowOf(j));
    if (!claim) throw new Error("claim expected");
    await journals.issue(claim.journal, claim.token, { kind: "INSERT" }); // then the process died
    expect(await dispatch.deliver(j._id)).toBe("RETRY"); // a live issuer may still answer
    now += 3 * MIN;
    // Provably unsent (send permission never consumed) → abandoned → inserted once; the
    // read-back confirmation happens on the next pass.
    expect(await dispatch.deliver(j._id)).toBe("RETRY");
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.writes()).toEqual([`INSERT o${b._id.toHexString()}`]);
  });
});

describe("P2.2.9 failure handling", () => {
  it("transient failure with Retry-After: no effect recorded, retried no sooner than Google asked", async () => {
    const b = booking();
    const j = record(journals, b);
    google.next = { error: new PackageCalendarProviderError("RETRYABLE_FAILURE", true, 30 * MIN) };
    expect(await dispatch.deliver(j._id)).toBe("RETRY");
    expect(rowOf(j)).toMatchObject({
      state: "RETRYABLE_FAILURE",
      createIssued: false,
      retryableFailures: 1,
    });
    expect(rowOf(j).nextAttemptAt?.getTime()).toBe(now + 30 * MIN);
    now += 31 * MIN;
    expect(await dispatch.deliver(j._id)).toBe("DONE");
    expect(google.events.size).toBe(1);
  });

  it("backs off exponentially from the durable failure count", async () => {
    const b = booking();
    const j = record(journals, b);
    rowOf(j).retryableFailures = 3;
    google.next = { error: new PackageCalendarProviderError("RETRYABLE_FAILURE", true) };
    await dispatch.deliver(j._id);
    expect(rowOf(j).nextAttemptAt?.getTime()).toBe(now + 8 * MIN);
  });

  it("the retry budget is bounded: the last allowed failure becomes an Owner-visible recovery incident", async () => {
    const b = booking();
    const j = record(journals, b);
    rowOf(j).retryableFailures = retry.ORDINARY_CALENDAR_RETRY_POLICY.maxConsecutiveFailures - 1;
    google.next = { error: new PackageCalendarProviderError("RETRYABLE_FAILURE", true) };
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j)).toMatchObject({
      state: "BLOCKED_AUTHORITY",
      reason: "RETRY_LIMIT_REACHED",
      nextAttemptAt: undefined,
    });
    expect(classifyOrdinaryCalendarIncident(rowOf(j), clock(), 2 * MIN)).toMatchObject({
      category: "PROVIDER_RETRY_LIMIT_REACHED",
      recoveryRequired: true,
    });
    google.calls = [];
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED"); // no further Google calls
    expect(google.calls).toEqual([]);
  });

  it("an exhausted budget on repeated failed reads also stops", async () => {
    const b = booking();
    const j = record(journals, b);
    rowOf(j).retryableFailures = retry.ORDINARY_CALENDAR_RETRY_POLICY.maxConsecutiveFailures - 1;
    google.readFailure = new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
    expect(await dispatch.deliver(j._id)).toBe("RETRY");
    expect(rowOf(j)).toMatchObject({ state: "BLOCKED_AUTHORITY", reason: "RETRY_LIMIT_REACHED" });
  });

  it("permanent authorization failure (401/403) blocks immediately — never retried", async () => {
    const b = booking();
    const j = record(journals, b);
    google.readFailure = new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
    await dispatch.deliver(j._id);
    expect(rowOf(j)).toMatchObject({
      state: "BLOCKED_AUTHORITY",
      reason: "PROVIDER_READ_DENIED",
      nextAttemptAt: undefined,
    });
    expect(google.writes()).toEqual([]);
  });

  it("revoked / disconnected / reconnected-elsewhere connection: blocked with no Google write", async () => {
    const b = booking();
    const j = record(journals, b);
    google.connected = false;
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j)).toMatchObject({
      state: "BLOCKED_AUTHORITY",
      reason: "CONNECTION_GENERATION_OR_DESTINATION_CHANGED",
    });
    expect(google.calls).toEqual([]);
    expect(describeOrdinaryCalendarSync(rowOf(j), clock(), 2 * MIN).status).toBe(
      "RECOVERY_REQUIRED",
    );
  });
});

describe("P2.2.9 isolation", () => {
  it("a journal row naming another Business's Booking is refused before any provider call", async () => {
    const b = booking();
    const j = record(journals, b);
    rowOf(j).businessId = new Types.ObjectId(); // forged / foreign mapping
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j)).toMatchObject({
      state: "PERMANENT_FAILURE",
      reason: "BOOKING_NOT_FOUND_FOR_BUSINESS",
    });
    expect(google.calls).toEqual([]);
  });

  it("an existing event not owned by this Booking/Business is never modified", async () => {
    const b = booking();
    const j = record(journals, b);
    google.events.set(`o${b._id.toHexString()}`, {
      status: "confirmed",
      startAt: new Date(0),
      endAt: new Date(1),
      timezone: "UTC",
      marker: {
        booklyBookingId: String(new Types.ObjectId()),
        booklyBusinessId: String(businessId),
      },
      etag: '"x"',
    });
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j)).toMatchObject({
      state: "PERMANENT_FAILURE",
      reason: "EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED",
    });
    expect(google.writes()).toEqual([]);
  });

  it("a Booking already linked by the legacy path is never written by the journal (no second writer)", async () => {
    const b = booking();
    const j = record(journals, b);
    (b as { googleCalendarEventId?: string }).googleCalendarEventId = "legacy-event";
    expect(await dispatch.deliver(j._id)).toBe("BLOCKED");
    expect(rowOf(j).reason).toBe("LEGACY_EVENT_LINK_PRESENT");
    expect(google.calls).toEqual([]);
  });
});

describe("P2.2.9 Europe/Nicosia DST", () => {
  it("sends the exact instants across winter, summer and the DST change, with the Booking's timezone", async () => {
    // Cyprus: UTC+2 in winter, UTC+3 from 29 Mar 2026 (03:00 local).
    for (const [start, wall] of [
      ["2026-01-15T08:00:00.000Z", "10:00"],
      ["2026-07-15T07:00:00.000Z", "10:00"],
      ["2026-03-28T23:30:00.000Z", "01:30"], // the night of the change, before it
      ["2026-03-29T01:30:00.000Z", "04:30"], // after it
    ] as const) {
      const b = booking("NORMAL", start);
      await dispatch.deliver(record(journals, b)._id);
      const event = google.events.get(`o${b._id.toHexString()}`);
      expect(event?.startAt.toISOString()).toBe(start);
      expect(event?.timezone).toBe("Europe/Nicosia");
      expect(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Nicosia",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(event?.startAt),
      ).toBe(wall);
    }
  });

  it("a cross-midnight appointment keeps both instants", async () => {
    const b = booking("NORMAL", "2026-06-30T20:30:00.000Z"); // 23:30 → 00:30 local
    await dispatch.deliver(record(journals, b)._id);
    const event = google.events.get(`o${b._id.toHexString()}`);
    expect(event?.endAt.toISOString()).toBe("2026-06-30T21:30:00.000Z");
  });
});
