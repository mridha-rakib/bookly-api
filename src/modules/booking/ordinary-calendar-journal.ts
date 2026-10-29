import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Types } from "mongoose";
import { logger } from "../../config/logger.js";
import { GoogleCalendarIntegrationModel } from "../integration/integration.model.js";
import type { BookingDocument } from "./booking.model.js";
import {
  type OrdinaryCalendarDesired,
  type OrdinaryCalendarDestination,
  type OrdinaryCalendarJournalDocument,
  OrdinaryCalendarJournalModel,
  type OrdinaryCalendarJournalState,
  type OrdinaryCalendarRequest,
} from "./ordinary-calendar-journal.model.js";
import {
  ordinaryCalendarAuthoritativeModeAvailable,
  verifyOrdinaryCalendarDeliveryAuthority,
} from "./ordinary-calendar-journal-authority.js";

/**
 * P4B-2A/2C — ordinary Booking Calendar desired-state contract.
 *
 * Authority comes from the committed Booking itself: a row is written only by the transaction
 * that creates (UPCOMING), reschedules or cancels the Booking, so a rolled-back Booking, an
 * unpaid attempt or a pending payment can never leave a row. No provider call happens here.
 *
 * P4B-2C (Owner Option C): the journal is persisted only together with the cutover. A new
 * Booking gets a row, and with it journal ownership, only when BOTH rollout authorities allow
 * it AND the journal collection's two indexes are confirmed. Otherwise nothing is written or
 * read inside the Booking transaction and the Booking keeps its pre-journal semantics with the
 * legacy best-effort path as its single writer. The decision is made once, in the creating
 * transaction, and is never revisited: rows are journal-owned for life, Bookings without a row
 * are legacy-owned for life. SHADOW rows are no longer written; any written by a pre-release
 * build stay legacy-owned and are never updated, claimed or delivered.
 */

/** Distinct from P2C's `b<hex>` so an ordinary and a Package event can never share an id.
 * `o` and hex digits are valid Google base32hex event-id characters. */
export const ordinaryCalendarEventId = (bookingId: Types.ObjectId): string =>
  `o${bookingId.toHexString()}`;

const CANCELLED = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS", "LATE_CANCELLATION"]);

/** First-Class Package Bookings belong to P2C. They never get an ordinary journal. */
export const isOrdinaryCalendarBooking = (
  booking: Pick<BookingDocument, "serviceLines">,
): boolean =>
  !booking.serviceLines.some((line) => line.pricingInput?.packageItemId || line.packageContext);

/** Same event content the existing best-effort creation path writes. Only UPCOMING is
 * PRESENT; a cancellation is ABSENT; every other status implies no Calendar change. */
export function ordinaryCalendarDesired(
  booking: BookingDocument,
): OrdinaryCalendarDesired | undefined {
  if (booking.status === "UPCOMING")
    return {
      kind: "PRESENT",
      summary: `Bookly — ${booking.reference}`,
      description: `Booking ${booking.reference} (${booking.serviceLines.length} service line(s))`,
      startAt: booking.schedule.startAt,
      endAt: booking.schedule.endAt,
      timezone: booking.schedule.timezone,
    };
  return CANCELLED.has(booking.status) ? { kind: "ABSENT" } : undefined;
}

export function ordinaryCalendarRevision(
  booking: BookingDocument,
  desired: OrdinaryCalendarDesired,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        bookingId: String(booking._id),
        status: booking.status,
        eventVersion: booking.eventHistory.length,
        rescheduleVersion: booking.rescheduleHistory.length,
        desired,
      }),
    )
    .digest("hex");
}

export class OrdinaryCalendarJournalConflictError extends Error {
  readonly code = "ORDINARY_CALENDAR_JOURNAL_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "OrdinaryCalendarJournalConflictError";
  }
}

const requireTransaction = (session: ClientSession) => {
  if (!session.inTransaction())
    throw new OrdinaryCalendarJournalConflictError(
      "Calendar intent requires the Booking transaction",
    );
};

/** The exact index shapes `ordinary-calendar-journal.model.ts` declares and the consumer uses. */
export const ORDINARY_CALENDAR_REQUIRED_INDEXES = [
  { key: { bookingId: 1 }, unique: true },
  { key: { mode: 1, state: 1, nextAttemptAt: 1 }, unique: false },
] as const;

type IndexDescription = { key?: Record<string, unknown>; unique?: boolean };

/**
 * P4B-2C — journal persistence readiness. Production disables autoIndex and some servers cannot
 * create a collection inside a transaction, so journal ownership is never offered until the
 * collection and both indexes exist. The check runs as its own command, never with the Booking
 * session, and any error means "not ready" (legacy ownership), never a Booking failure. A result
 * is reused for `recheckMs`; a not-ready result is logged as an incident.
 */
export class OrdinaryCalendarJournalReadiness {
  private readyUntil = 0;
  private notReadyUntil = 0;

  constructor(
    private readonly listIndexes: () => Promise<IndexDescription[]> = () =>
      OrdinaryCalendarJournalModel.collection.listIndexes().toArray() as Promise<
        IndexDescription[]
      >,
    private readonly now: () => number = () => Date.now(),
    private readonly recheckMs = 60_000,
  ) {}

  async isReady(): Promise<boolean> {
    const now = this.now();
    if (now < this.readyUntil) return true;
    if (now < this.notReadyUntil) return false;
    let ready = false;
    try {
      const indexes = await this.listIndexes();
      ready = ORDINARY_CALENDAR_REQUIRED_INDEXES.every((required) =>
        indexes.some(
          (index) =>
            isDeepStrictEqual(index.key, required.key) && Boolean(index.unique) === required.unique,
        ),
      );
    } catch {
      ready = false;
    }
    if (ready) this.readyUntil = now + this.recheckMs;
    else {
      this.notReadyUntil = now + this.recheckMs;
      logger.error(
        { event: "ORDINARY_CALENDAR_JOURNAL_NOT_READY" },
        "Ordinary Calendar journal collection or indexes are missing; new Bookings stay legacy-owned",
      );
    }
    return ready;
  }
}

const sharedReadiness = new OrdinaryCalendarJournalReadiness();

/** Journal ownership needs creation authority, delivery authority (a journal-owned Booking
 * with no permitted writer would never sync) and confirmed persistence readiness. */
export async function ordinaryCalendarJournalOwnershipAvailable(
  readiness: Pick<OrdinaryCalendarJournalReadiness, "isReady"> = sharedReadiness,
): Promise<boolean> {
  if (!(await ordinaryCalendarAuthoritativeModeAvailable())) return false;
  try {
    await verifyOrdinaryCalendarDeliveryAuthority();
  } catch {
    return false;
  }
  return readiness.isReady();
}

export type OrdinaryCalendarJournalPort = {
  recordCreatedInTransaction(
    booking: BookingDocument,
    session: ClientSession,
  ): Promise<OrdinaryCalendarJournalDocument | null>;
  recordMutationInTransaction(
    booking: BookingDocument,
    session: ClientSession,
  ): Promise<OrdinaryCalendarJournalDocument | null>;
  /** True when the existing best-effort path may still write this Booking's event. */
  legacySyncPermitted(booking: Pick<BookingDocument, "_id" | "businessId">): Promise<boolean>;
};

export class OrdinaryCalendarJournal implements OrdinaryCalendarJournalPort {
  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly readiness: Pick<OrdinaryCalendarJournalReadiness, "isReady"> = sharedReadiness,
  ) {}

  async recordCreatedInTransaction(booking: BookingDocument, session: ClientSession) {
    requireTransaction(session);
    if (!isOrdinaryCalendarBooking(booking) || booking.status !== "UPCOMING") return null;
    // A pre-existing link can only come from another writer; never take it over.
    if (booking.googleCalendarEventId) return null;
    const desired = ordinaryCalendarDesired(booking);
    if (desired?.kind !== "PRESENT") return null;
    // Option C: with either switch off or the journal not provisioned, nothing is written or
    // read in this transaction and the Booking stays legacy-owned.
    if (!(await ordinaryCalendarJournalOwnershipAvailable(this.readiness))) return null;
    const revision = ordinaryCalendarRevision(booking, desired);

    const existing = await OrdinaryCalendarJournalModel.findOne({ bookingId: booking._id })
      .session(session)
      .exec();
    if (existing) {
      // Replay inside a retried caller: only the identical committed creation is accepted.
      if (
        !existing.businessId.equals(booking.businessId) ||
        existing.latest.source !== "CREATED" ||
        existing.latest.revision !== revision
      )
        throw new OrdinaryCalendarJournalConflictError(
          "Calendar journal already exists for another intent",
        );
      return existing;
    }

    const integration = await GoogleCalendarIntegrationModel.findOne({
      businessId: booking.businessId,
    })
      .session(session)
      .exec();
    const destination: OrdinaryCalendarDestination | undefined =
      integration &&
      integration.status === "CONNECTED" &&
      integration.businessId.equals(booking.businessId) &&
      integration.connectionGeneration &&
      integration.googleAccountId &&
      integration.calendarId
        ? {
            integrationId: integration._id,
            generation: integration.connectionGeneration,
            accountId: integration.googleAccountId,
            accountEmail: integration.googleAccountEmail,
            configuredCalendarId: integration.calendarId,
          }
        : undefined;
    const now = this.clock();
    const row: Omit<OrdinaryCalendarJournalDocument, "_id" | "createdAt" | "updatedAt"> = {
      version: 1,
      bookingId: booking._id,
      businessId: booking.businessId,
      ...(booking.customer.customerUserId
        ? { customerUserId: booking.customer.customerUserId }
        : {}),
      ...(booking.customer.businessClientId
        ? { businessClientId: booking.customer.businessClientId }
        : {}),
      mode: "AUTHORITATIVE",
      eventIdentity: { kind: "ALLOCATED", eventId: ordinaryCalendarEventId(booking._id) },
      ...(destination ? { destination } : {}),
      latest: {
        sequence: 1,
        revision,
        desired,
        source: "CREATED",
        bookingStatus: booking.status,
        eventVersion: booking.eventHistory.length,
        rescheduleVersion: booking.rescheduleHistory.length,
        recordedAt: now,
      },
      // Not connected: an explicit, visible state, never a pretend-synchronized Booking.
      state: destination ? "PENDING" : "BLOCKED_AUTHORITY",
      ...(destination ? { nextAttemptAt: now } : { reason: "CALENDAR_NOT_CONNECTED_AT_CREATION" }),
      createIssued: false,
    };
    const [created] = await OrdinaryCalendarJournalModel.create([row], { session });
    if (!created)
      throw new OrdinaryCalendarJournalConflictError("Calendar journal was not created");
    return created;
  }

  async recordMutationInTransaction(booking: BookingDocument, session: ClientSession) {
    requireTransaction(session);
    const journal = await OrdinaryCalendarJournalModel.findOne({
      bookingId: booking._id,
      businessId: booking.businessId,
    })
      .session(session)
      .exec();
    // Historical, First-Class and pre-release SHADOW Bookings are legacy-owned: nothing is
    // migrated or updated here, so their mutations gain no journal write dependency.
    if (!journal || journal.mode !== "AUTHORITATIVE") return null;
    const desired = ordinaryCalendarDesired(booking);
    if (!desired) return journal;
    const revision = ordinaryCalendarRevision(booking, desired);
    if (journal.latest.revision === revision) return journal; // Same logical mutation replayed.
    if (journal.latest.desired.kind === "ABSENT")
      throw new OrdinaryCalendarJournalConflictError(
        "A cancelled Booking cannot change its Calendar intent",
      );

    const unresolved = Boolean(journal.request && !journal.request.settled);
    // No insert was ever issued, so no event can exist anywhere: a cancellation is settled by
    // the consumer without a provider call, even while the Calendar is disconnected.
    const neverWritten = !journal.createIssued && (!journal.request || journal.request.settled);
    const cancelledBeforeAnyWrite = neverWritten && desired.kind === "ABSENT";
    const state: OrdinaryCalendarJournalState = unresolved
      ? "UNKNOWN_OUTCOME"
      : cancelledBeforeAnyWrite
        ? "PENDING"
        : journal.state === "BLOCKED_AUTHORITY" || journal.state === "PERMANENT_FAILURE"
          ? journal.state
          : "PENDING";
    const now = this.clock();
    const updated = await OrdinaryCalendarJournalModel.findOneAndUpdate(
      {
        _id: journal._id,
        "latest.sequence": journal.latest.sequence,
        "latest.revision": journal.latest.revision,
      },
      {
        $set: {
          latest: {
            sequence: journal.latest.sequence + 1,
            revision,
            desired,
            source: desired.kind === "ABSENT" ? "CANCELLED" : "RESCHEDULED",
            bookingStatus: booking.status,
            eventVersion: booking.eventHistory.length,
            rescheduleVersion: booking.rescheduleHistory.length,
            recordedAt: now,
          },
          state,
          ...(unresolved
            ? { reason: "EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER" }
            : cancelledBeforeAnyWrite
              ? { reason: "CANCELLED_BEFORE_ANY_CALENDAR_WRITE" }
              : {}),
          // Unresolved rows are revisited too, so a lost-response request can be reconciled.
          ...(state === "PENDING" || state === "UNKNOWN_OUTCOME" ? { nextAttemptAt: now } : {}),
        },
        // A prepared-but-not-issued worker loses its lease; its issue CAS then fails.
        $unset: { lease: 1 },
      },
      { session, returnDocument: "after", runValidators: true },
    ).exec();
    if (!updated)
      throw new OrdinaryCalendarJournalConflictError("Calendar journal changed concurrently");
    return updated;
  }

  async legacySyncPermitted(booking: Pick<BookingDocument, "_id" | "businessId">) {
    try {
      const journal = await OrdinaryCalendarJournalModel.findOne({ bookingId: booking._id })
        .select("mode businessId")
        .read("primary")
        .maxTimeMS(2000)
        .lean()
        .exec();
      return !journal || journal.mode === "SHADOW";
    } catch (error) {
      // Unknown ownership: skipping one best-effort call is safer than a second writer.
      logger.warn(
        {
          bookingId: String(booking._id),
          errorCategory: error instanceof Error ? error.name : "UNKNOWN",
        },
        "Calendar journal unreadable; skipping best-effort Calendar sync",
      );
      return false;
    }
  }
}

// --- Consumer primitives (P4B-2B). Exact-record CAS only; no provider call, no registration. --

/** An issued request younger than this may still belong to a live issuer; it is not touched. */
export const ORDINARY_CALENDAR_ISSUER_WINDOW_MS = 2 * 60_000;

export class OrdinaryCalendarJournalRepository {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  findByBookingId(bookingId: Types.ObjectId | string) {
    return OrdinaryCalendarJournalModel.findOne({ bookingId }).read("primary").exec();
  }

  findById(id: Types.ObjectId | string) {
    return OrdinaryCalendarJournalModel.findById(id).read("primary").exec();
  }

  /** P4B-2B — bounded due scan. Uses `{mode, state, nextAttemptAt}` exactly; SHADOW rows and
   * terminal BLOCKED/PERMANENT rows (which need an explicit decision) are never selected. */
  listDue(limit: number) {
    return OrdinaryCalendarJournalModel.find({
      mode: "AUTHORITATIVE",
      state: {
        $in: [
          "PENDING",
          "RETRYABLE_FAILURE",
          "DISPATCH_PREPARED",
          "REQUEST_ISSUED",
          "UNKNOWN_OUTCOME",
        ],
      },
      nextAttemptAt: { $lte: this.clock() },
    })
      .sort({ nextAttemptAt: 1 })
      .limit(Math.max(1, Math.min(limit, 100)))
      .read("primary")
      .exec();
  }

  /** Claims dispatch of the CURRENT sequence. A live lease or an unresolved request refuses.
   * A crashed pre-dispatch claim (DISPATCH_PREPARED with an expired lease) may be taken over:
   * its holder can no longer `issue`, because issuing requires the live lease token. */
  async prepare(journal: OrdinaryCalendarJournalDocument, leaseMs = 45_000) {
    const now = this.clock();
    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const prepared = await OrdinaryCalendarJournalModel.findOneAndUpdate(
      {
        _id: journal._id,
        mode: "AUTHORITATIVE",
        "eventIdentity.kind": "ALLOCATED",
        "latest.sequence": journal.latest.sequence,
        state: { $in: ["PENDING", "RETRYABLE_FAILURE", "DISPATCH_PREPARED"] },
        $and: [
          { $or: [{ lease: { $exists: false } }, { "lease.expiresAt": { $lte: now } }] },
          { $or: [{ request: { $exists: false } }, { "request.settled": true }] },
        ],
      },
      {
        $set: { state: "DISPATCH_PREPARED", lease: { token, expiresAt }, nextAttemptAt: expiresAt },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
    return prepared ? { journal: prepared, token } : null;
  }

  /** A request whose send permission was never consumed provably reached no provider: the
   * port calls Google only after `markProviderStarted` wins. Exclusive with that CAS. */
  async abandonUnstarted(journalId: Types.ObjectId, requestId: string) {
    const current = await OrdinaryCalendarJournalModel.findOne({
      _id: journalId,
      "request.id": requestId,
    }).exec();
    if (!current?.request) return false;
    const abandoned = await OrdinaryCalendarJournalModel.updateOne(
      {
        _id: journalId,
        "request.id": requestId,
        "request.settled": false,
        "request.providerStarted": false,
      },
      {
        $set: {
          "request.settled": true,
          state: "RETRYABLE_FAILURE",
          reason: "ISSUER_STOPPED_BEFORE_PROVIDER_CALL",
          nextAttemptAt: this.clock(),
          ...(current.request.kind === "INSERT" ? { createIssued: false } : {}),
        },
        $unset: { lease: 1 },
      },
    ).exec();
    return abandoned.modifiedCount === 1;
  }

  /** A settled ambiguity (e.g. an expected event was missing) whose provider state changed so
   * that a conditional write is again possible returns to ordinary dispatch. */
  async reopen(journal: OrdinaryCalendarJournalDocument) {
    const reopened = await OrdinaryCalendarJournalModel.updateOne(
      {
        _id: journal._id,
        state: "UNKNOWN_OUTCOME",
        "latest.sequence": journal.latest.sequence,
        $or: [{ request: { $exists: false } }, { "request.settled": true }],
      },
      { $set: { state: "RETRYABLE_FAILURE", nextAttemptAt: this.clock() } },
    ).exec();
    return reopened.modifiedCount === 1;
  }

  /** Explicit Owner recovery for an exact Booking and request. Never clears `createIssued`. */
  async recover(
    journal: OrdinaryCalendarJournalDocument,
    input: {
      destination: OrdinaryCalendarDestination;
      record: NonNullable<OrdinaryCalendarJournalDocument["recoveries"]>[number];
    },
  ) {
    const previous = journal.destination;
    const recovered = await OrdinaryCalendarJournalModel.updateOne(
      {
        _id: journal._id,
        mode: "AUTHORITATIVE",
        "latest.sequence": journal.latest.sequence,
        createIssued: journal.createIssued,
        ...(previous
          ? {
              "destination.generation": previous.generation,
              "destination.accountId": previous.accountId,
            }
          : { destination: { $exists: false } }),
        ...(journal.request
          ? { "request.id": journal.request.id, "request.settled": journal.request.settled }
          : { request: { $exists: false } }),
      },
      {
        $set: {
          destination: input.destination,
          state: "RETRYABLE_FAILURE",
          reason: "RECOVERED_BY_OWNER",
          nextAttemptAt: this.clock(),
          ...(journal.request ? { "request.settled": true } : {}),
        },
        $push: { recoveries: input.record },
        $unset: { lease: 1 },
      },
      { runValidators: true },
    ).exec();
    return recovered.modifiedCount === 1;
  }

  /** Durably records the request BEFORE any provider call. Fails for a stale lease, a newer
   * sequence or a request that is not settled. */
  async issue(
    journal: OrdinaryCalendarJournalDocument,
    token: string,
    request: { kind: OrdinaryCalendarRequest["kind"]; etag?: string | undefined },
  ) {
    const now = this.clock();
    if (request.kind !== "INSERT" && !request.etag) return null;
    const next: OrdinaryCalendarRequest = {
      id: randomUUID(),
      kind: request.kind,
      sequence: journal.latest.sequence,
      revision: journal.latest.revision,
      issuedAt: now,
      settled: false,
      providerStarted: false,
      ...(request.etag ? { etag: request.etag } : {}),
    };
    const issued = await OrdinaryCalendarJournalModel.findOneAndUpdate(
      {
        _id: journal._id,
        mode: "AUTHORITATIVE",
        state: "DISPATCH_PREPARED",
        "latest.sequence": journal.latest.sequence,
        "latest.revision": journal.latest.revision,
        "lease.token": token,
        "lease.expiresAt": { $gt: now },
        ...(request.kind === "INSERT" ? { createIssued: false } : {}),
        $or: [{ request: { $exists: false } }, { "request.settled": true }],
      },
      {
        $set: {
          state: "REQUEST_ISSUED",
          request: next,
          // Revisited for reconciliation if the issuer never acknowledges.
          nextAttemptAt: new Date(now.getTime() + ORDINARY_CALENDAR_ISSUER_WINDOW_MS),
          ...(request.kind === "INSERT" ? { createIssued: true } : {}),
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
    return issued ? { journal: issued, request: next } : null;
  }

  /** Send permission: consumed exactly once per durable request, immediately before the call. */
  async markProviderStarted(journalId: Types.ObjectId, requestId: string) {
    const started = await OrdinaryCalendarJournalModel.updateOne(
      {
        _id: journalId,
        state: "REQUEST_ISSUED",
        "request.id": requestId,
        "request.settled": false,
        "request.providerStarted": false,
      },
      { $set: { "request.providerStarted": true } },
    ).exec();
    return started.modifiedCount === 1;
  }

  /** Settles only the exact request. A late answer never confirms a newer sequence. */
  async acknowledge(
    journalId: Types.ObjectId,
    requestId: string,
    outcome: {
      state: OrdinaryCalendarJournalState;
      definitiveNoEffect: boolean;
      reason?: string;
      nextAttemptAt?: Date;
    },
  ) {
    const current = await OrdinaryCalendarJournalModel.findOne({
      _id: journalId,
      "request.id": requestId,
    }).exec();
    if (!current?.request) return false;
    const settled = outcome.definitiveNoEffect || outcome.state !== "UNKNOWN_OUTCOME";
    const acknowledged = await OrdinaryCalendarJournalModel.updateOne(
      { _id: journalId, "request.id": requestId, "request.settled": false },
      {
        $set: {
          "request.settled": settled,
          state:
            current.request.sequence === current.latest.sequence
              ? outcome.state
              : settled
                ? "PENDING"
                : "UNKNOWN_OUTCOME",
          ...(outcome.definitiveNoEffect && current.request.kind === "INSERT"
            ? { createIssued: false }
            : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          nextAttemptAt: outcome.nextAttemptAt ?? this.clock(),
        },
        // P4B-2C — repeated 429/5xx visibility; reset only by a confirmed observation.
        ...(outcome.state === "RETRYABLE_FAILURE" || outcome.state === "UNKNOWN_OUTCOME"
          ? { $inc: { retryableFailures: 1 } }
          : {}),
        $unset: { lease: 1 },
      },
    ).exec();
    return acknowledged.modifiedCount === 1;
  }

  /** Only an authoritative observation of the CURRENT sequence may confirm it. */
  async confirm(journal: OrdinaryCalendarJournalDocument) {
    const request = journal.request;
    // An unsettled request may be settled by this observation only for the SAME sequence.
    if (request && !request.settled && request.sequence !== journal.latest.sequence) return false;
    const confirmed = await OrdinaryCalendarJournalModel.updateOne(
      {
        _id: journal._id,
        mode: "AUTHORITATIVE",
        "latest.sequence": journal.latest.sequence,
        "latest.revision": journal.latest.revision,
        ...(request
          ? { "request.id": request.id, "request.settled": request.settled }
          : { request: { $exists: false } }),
      },
      {
        $set: {
          state: "CONFIRMED",
          confirmedSequence: journal.latest.sequence,
          confirmedRevision: journal.latest.revision,
          ...(request ? { "request.settled": true } : {}),
        },
        $unset: { lease: 1, nextAttemptAt: 1, reason: 1, retryableFailures: 1 },
      },
    ).exec();
    return confirmed.modifiedCount === 1;
  }

  /** BLOCKED_AUTHORITY and PERMANENT_FAILURE leave the due scan until an explicit decision;
   * other states are revisited at `nextAttemptAt`. */
  async block(
    journal: OrdinaryCalendarJournalDocument,
    state: OrdinaryCalendarJournalState,
    reason: string,
    nextAttemptAt?: Date,
  ) {
    const terminal = state === "BLOCKED_AUTHORITY" || state === "PERMANENT_FAILURE";
    const blocked = await OrdinaryCalendarJournalModel.updateOne(
      { _id: journal._id, "latest.sequence": journal.latest.sequence },
      {
        $set: {
          state,
          reason,
          ...(!terminal ? { nextAttemptAt: nextAttemptAt ?? this.clock() } : {}),
        },
        ...(state === "RETRYABLE_FAILURE" ? { $inc: { retryableFailures: 1 } } : {}),
        $unset: { lease: 1, ...(terminal ? { nextAttemptAt: 1 } : {}) },
      },
    ).exec();
    return blocked.modifiedCount === 1;
  }

  /** P4B-2C — bounded incident scan for monitoring. Uses the `{mode, state, nextAttemptAt}`
   * index prefix; never selects SHADOW or legacy rows. Read-only. */
  listIncidents(limit: number, stuckAfterMs: number) {
    const cutoff = new Date(this.clock().getTime() - stuckAfterMs);
    return OrdinaryCalendarJournalModel.find({
      mode: "AUTHORITATIVE",
      $or: [
        { state: { $in: ["UNKNOWN_OUTCOME", "BLOCKED_AUTHORITY", "PERMANENT_FAILURE"] } },
        { state: "REQUEST_ISSUED", "request.issuedAt": { $lte: cutoff } },
        { state: "RETRYABLE_FAILURE", retryableFailures: { $gte: 1 } },
      ],
    })
      .limit(Math.max(1, Math.min(limit, 200)))
      .read("primary")
      .exec();
  }
}

// --- Pure step planner: the provider-uncertainty contract a P4B-2B consumer must follow. ------

export type OrdinaryCalendarObservation =
  | { outcome: "NOT_CONNECTED" }
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "FOUND";
      status: string;
      startAt: Date | null;
      endAt: Date | null;
      marker: { booklyBookingId?: string; booklyBusinessId?: string };
      etag?: string;
    };

export type OrdinaryCalendarStep =
  | { action: "NONE"; reason: string }
  | { action: "BLOCK"; state: OrdinaryCalendarJournalState; reason: string }
  | { action: "CONFIRM" }
  | { action: "INSERT" }
  | { action: "PATCH" | "DELETE"; etag: string };

type JournalView = Pick<
  OrdinaryCalendarJournalDocument,
  | "mode"
  | "eventIdentity"
  | "destination"
  | "latest"
  | "state"
  | "createIssued"
  | "request"
  | "bookingId"
  | "businessId"
>;

const owned = (o: Extract<OrdinaryCalendarObservation, { outcome: "FOUND" }>, j: JournalView) =>
  o.marker.booklyBookingId === String(j.bookingId) &&
  o.marker.booklyBusinessId === String(j.businessId);

const matches = (o: OrdinaryCalendarObservation, j: JournalView) => {
  const d = j.latest.desired;
  if (d.kind === "ABSENT")
    return o.outcome === "NOT_FOUND" || (o.outcome === "FOUND" && o.status === "cancelled");
  return (
    o.outcome === "FOUND" &&
    owned(o, j) &&
    o.status === "confirmed" &&
    o.startAt?.getTime() === d.startAt.getTime() &&
    o.endAt?.getTime() === d.endAt.getTime()
  );
};

/**
 * Decides the next step from the journal and ONE provider observation of the bound destination.
 * Rules (same as P2C): a GET 404 never authorizes a second insert once one was issued; an
 * unresolved request for an older sequence blocks every newer write, because a database CAS
 * cannot revoke an in-flight Google request; an unowned, cancelled or ETag-less event is never
 * modified; a changed connection generation or destination blocks until an explicit decision.
 */
export function planOrdinaryCalendarStep(
  journal: JournalView,
  observation: OrdinaryCalendarObservation,
  destinationCurrent: boolean,
): OrdinaryCalendarStep {
  if (journal.mode !== "AUTHORITATIVE")
    return { action: "NONE", reason: "SHADOW_JOURNAL_LEGACY_PATH_OWNS_PROVIDER_WRITES" };
  if (journal.eventIdentity.kind !== "ALLOCATED")
    return { action: "BLOCK", state: "PERMANENT_FAILURE", reason: "EVENT_IDENTITY_NOT_ALLOCATED" };
  if (journal.state === "PERMANENT_FAILURE")
    return { action: "BLOCK", state: "PERMANENT_FAILURE", reason: journal.state };
  if (!journal.destination || !destinationCurrent)
    return {
      action: "BLOCK",
      state: "BLOCKED_AUTHORITY",
      reason: "CONNECTION_GENERATION_OR_DESTINATION_CHANGED",
    };
  if (observation.outcome === "NOT_CONNECTED")
    return { action: "BLOCK", state: "BLOCKED_AUTHORITY", reason: "CALENDAR_DISCONNECTED" };
  const unresolved = Boolean(journal.request && !journal.request.settled);
  if (unresolved && journal.request?.sequence !== journal.latest.sequence)
    return {
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER",
    };
  if (matches(observation, journal)) return { action: "CONFIRM" };
  if (unresolved)
    return {
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "UNRESOLVED_REQUEST_REQUIRES_QUIESCENCE_DECISION",
    };
  const d = journal.latest.desired;
  if (observation.outcome === "NOT_FOUND") {
    if (d.kind === "PRESENT" && !journal.createIssued) return { action: "INSERT" };
    return {
      action: "BLOCK",
      state: "UNKNOWN_OUTCOME",
      reason: "MISSING_EVENT_DOES_NOT_AUTHORIZE_RECREATE",
    };
  }
  if (!owned(observation, journal) || observation.status !== "confirmed" || !observation.etag)
    return {
      action: "BLOCK",
      state: "PERMANENT_FAILURE",
      reason: "EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED",
    };
  return { action: d.kind === "ABSENT" ? "DELETE" : "PATCH", etag: observation.etag };
}
