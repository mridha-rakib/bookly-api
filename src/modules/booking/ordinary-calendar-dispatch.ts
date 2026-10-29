import type { Types } from "mongoose";
import { BusinessModel } from "../business/business.model.js";
import { UserModel } from "../user/user.model.js";
import { BookingModel } from "./booking.model.js";
import {
  isOrdinaryCalendarBooking,
  ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
  OrdinaryCalendarJournalConflictError,
  OrdinaryCalendarJournalRepository,
  type OrdinaryCalendarObservation,
  ordinaryCalendarDesired,
  ordinaryCalendarEventId,
  ordinaryCalendarRevision,
  planOrdinaryCalendarStep,
} from "./ordinary-calendar-journal.js";
import {
  type OrdinaryCalendarDestination,
  type OrdinaryCalendarJournalDocument,
  OrdinaryCalendarJournalModel,
  type OrdinaryCalendarJournalState,
} from "./ordinary-calendar-journal.model.js";
import { verifyOrdinaryCalendarDeliveryAuthority } from "./ordinary-calendar-journal-authority.js";
import {
  type PackageCalendarOwner,
  readVerifiedCalendarOwner,
} from "./package-calendar-authority.js";
import { PackageCalendarProviderError } from "./package-calendar-delivery.js";

/**
 * P4B-2B — the ordinary Booking Calendar consumer.
 *
 * Every provider write is derived from the durable journal, after the committed Booking is
 * re-read and its revision matches the journal's latest intent; never from an in-memory
 * Booking. Only AUTHORITATIVE (journal-owned) rows are processed; SHADOW rows and Bookings
 * without a row stay with the legacy best-effort path. P2C rules apply: REQUEST_ISSUED is
 * durable before the call, the send permission is consumed once, an unresolved request
 * quarantines newer writes, a 404 never authorizes a second insert, an unknown outcome is
 * never guessed, and provider acknowledgement alone never confirms (read-back does).
 * MongoDB CAS cannot revoke a request Google already received; no exactly-once claim is made.
 *
 * Package isolation: no Package task, release, PackageProgress, `packageCalendarDelivery`
 * field or `b<hex>` event id is read or written. The shared pieces are the Google client
 * helpers, their error classification and the Owner session check.
 */

export type OrdinaryCalendarBinding = {
  journalId: Types.ObjectId;
  bookingId: string;
  businessId: string;
  eventId: string;
  destination: OrdinaryCalendarDestination;
};

export type OrdinaryCalendarEventContent = {
  summary: string;
  description: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
};

/** Bound to ONE journal row and its recorded destination. Mutations consume the row's exact
 * send permission themselves (see consumeOrdinaryCalendarSendPermission). */
export type OrdinaryCalendarPort = {
  read(): Promise<OrdinaryCalendarObservation>;
  insert(
    event: OrdinaryCalendarEventContent,
    requestId: string,
  ): Promise<"CREATED" | "ALREADY_EXISTS">;
  patchSchedule(
    schedule: { startAt: Date; endAt: Date; timezone: string },
    etag: string,
    requestId: string,
  ): Promise<"UPDATED" | "NOT_FOUND" | "PRECONDITION_FAILED">;
  remove(etag: string, requestId: string): Promise<"DELETED" | "PRECONDITION_FAILED">;
};

export type OrdinaryCalendarProvider = {
  /** Throws a BLOCKED_AUTHORITY provider error unless `destination` is the current connection. */
  assertCurrent(businessId: string, destination: OrdinaryCalendarDestination): Promise<void>;
  /** The Business's current usable connection, for explicit recovery only. */
  currentDestination(businessId: string): Promise<OrdinaryCalendarDestination | null>;
  bind(binding: OrdinaryCalendarBinding): OrdinaryCalendarPort;
};

export const sameOrdinaryCalendarDestination = (
  a: OrdinaryCalendarDestination | undefined,
  b: OrdinaryCalendarDestination | undefined,
) =>
  Boolean(
    a &&
      b &&
      String(a.integrationId) === String(b.integrationId) &&
      a.generation === b.generation &&
      a.accountId === b.accountId &&
      a.accountEmail === b.accountEmail &&
      a.configuredCalendarId === b.configuredCalendarId,
  );

/**
 * The one-time send permission. A port calls this immediately before Google: the row must
 * hold exactly this unsettled, unstarted REQUEST_ISSUED request for its current sequence,
 * revision, destination and desired content. Winning `markProviderStarted` is the permission;
 * `abandonUnstarted` competes for the same CAS, so an abandoned request can never be sent.
 */
export async function consumeOrdinaryCalendarSendPermission(
  binding: OrdinaryCalendarBinding,
  mutation: {
    kind: "INSERT" | "PATCH" | "DELETE";
    requestId: string;
    etag?: string;
    event?: {
      startAt: Date;
      endAt: Date;
      timezone: string;
      summary?: string;
      description?: string;
    };
  },
): Promise<void> {
  await verifyOrdinaryCalendarDeliveryAuthority();
  const denied = () => new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
  const journal = await OrdinaryCalendarJournalModel.findById(binding.journalId)
    .read("primary")
    .exec();
  const request = journal?.request;
  if (
    !journal ||
    !request ||
    journal.mode !== "AUTHORITATIVE" ||
    journal.state !== "REQUEST_ISSUED" ||
    String(journal.bookingId) !== binding.bookingId ||
    String(journal.businessId) !== binding.businessId ||
    journal.eventIdentity.kind !== "ALLOCATED" ||
    journal.eventIdentity.eventId !== binding.eventId ||
    request.id !== mutation.requestId ||
    request.kind !== mutation.kind ||
    request.settled ||
    request.providerStarted ||
    request.sequence !== journal.latest.sequence ||
    request.revision !== journal.latest.revision ||
    !sameOrdinaryCalendarDestination(journal.destination, binding.destination) ||
    (mutation.kind !== "INSERT" && (!mutation.etag || request.etag !== mutation.etag))
  )
    throw denied();
  const desired = journal.latest.desired;
  if (mutation.kind === "DELETE") {
    if (desired.kind !== "ABSENT") throw denied();
  } else if (
    desired.kind !== "PRESENT" ||
    !mutation.event ||
    mutation.event.startAt.getTime() !== desired.startAt.getTime() ||
    mutation.event.endAt.getTime() !== desired.endAt.getTime() ||
    mutation.event.timezone !== desired.timezone ||
    (mutation.kind === "INSERT" &&
      (mutation.event.summary !== desired.summary ||
        mutation.event.description !== desired.description))
  ) {
    throw denied();
  }
  if (!(await new OrdinaryCalendarJournalRepository().markProviderStarted(journal._id, request.id)))
    throw new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
}

export type OrdinaryCalendarDeliveryOutcome = "DONE" | "RETRY" | "BLOCKED" | "SKIPPED";

const RETRY_DELAY_MS = 2 * 60_000;
const UNKNOWN_DELAY_MS = 15 * 60_000;
const KEEPS_PRESENT_EVENT = new Set([
  "COMPLETED",
  "PENDING",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
  "NO_SHOW_CHARGED",
]);

type BookingAuthority =
  | { kind: "OK"; journal: OrdinaryCalendarJournalDocument }
  | { kind: "STALE" }
  | { kind: "BLOCK"; state: OrdinaryCalendarJournalState; reason: string };

const classify = (error: unknown) =>
  error instanceof PackageCalendarProviderError
    ? { state: error.kind as OrdinaryCalendarJournalState, noEffect: error.definitiveNoEffect }
    : { state: "UNKNOWN_OUTCOME" as const, noEffect: false };

export class OrdinaryCalendarDispatch {
  constructor(
    private readonly provider: OrdinaryCalendarProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly repository = new OrdinaryCalendarJournalRepository(clock),
  ) {}

  private later(ms: number) {
    return new Date(this.clock().getTime() + ms);
  }

  /** The committed Booking is the authority; the journal must describe its current revision. */
  private async verifyCommittedBooking(
    journal: OrdinaryCalendarJournalDocument,
  ): Promise<BookingAuthority> {
    const block = (state: OrdinaryCalendarJournalState, reason: string): BookingAuthority => ({
      kind: "BLOCK",
      state,
      reason,
    });
    const booking = await BookingModel.findOne({
      _id: journal.bookingId,
      businessId: journal.businessId,
    })
      .read("primary")
      .maxTimeMS(2000)
      .exec();
    if (!booking) return block("PERMANENT_FAILURE", "BOOKING_NOT_FOUND_FOR_BUSINESS");
    if (!isOrdinaryCalendarBooking(booking))
      return block("PERMANENT_FAILURE", "NOT_AN_ORDINARY_BOOKING");
    if (
      String(booking.customer.businessClientId) !== String(journal.businessClientId ?? "") ||
      String(booking.customer.customerUserId ?? "") !== String(journal.customerUserId ?? "")
    )
      return block("PERMANENT_FAILURE", "BOOKING_IDENTITY_MISMATCH");
    // Another writer linked an event to a journal-owned Booking: never write alongside it.
    if (booking.googleCalendarEventId)
      return block("PERMANENT_FAILURE", "LEGACY_EVENT_LINK_PRESENT");
    if (!(await BusinessModel.exists({ _id: journal.businessId }).read("primary").maxTimeMS(2000)))
      return block("PERMANENT_FAILURE", "BUSINESS_NOT_FOUND");
    const desired = ordinaryCalendarDesired(booking);
    if (!desired)
      // Completion and no-show keep the last recorded event, exactly like the legacy path.
      return journal.latest.desired.kind === "PRESENT" && KEEPS_PRESENT_EVENT.has(booking.status)
        ? { kind: "OK", journal }
        : block("PERMANENT_FAILURE", "BOOKING_STATUS_WITHOUT_CALENDAR_INTENT");
    const revision = ordinaryCalendarRevision(booking, desired);
    if (revision === journal.latest.revision) return { kind: "OK", journal };
    // The Booking may have committed a newer mutation after the journal was read.
    const fresh = await this.repository.findById(journal._id);
    if (fresh && fresh.latest.revision === revision) return { kind: "OK", journal: fresh };
    if (!fresh || fresh.latest.sequence !== journal.latest.sequence) return { kind: "STALE" };
    return block("BLOCKED_AUTHORITY", "BOOKING_JOURNAL_REVISION_MISMATCH");
  }

  private async destinationCurrent(journal: OrdinaryCalendarJournalDocument) {
    if (!journal.destination) return false;
    try {
      await this.provider.assertCurrent(String(journal.businessId), journal.destination);
      return true;
    } catch {
      return false;
    }
  }

  private async observe(journal: OrdinaryCalendarJournalDocument, port: OrdinaryCalendarPort) {
    try {
      return await port.read();
    } catch (error) {
      const { state } = classify(error);
      if (state === "BLOCKED_AUTHORITY")
        await this.repository.block(journal, state, "PROVIDER_READ_DENIED");
      else {
        const uncertain = journal.state === "REQUEST_ISSUED" || journal.state === "UNKNOWN_OUTCOME";
        await this.repository.block(
          journal,
          uncertain ? "UNKNOWN_OUTCOME" : "RETRYABLE_FAILURE",
          "PROVIDER_READ_FAILED",
          this.later(uncertain ? UNKNOWN_DELAY_MS : RETRY_DELAY_MS),
        );
      }
      return undefined;
    }
  }

  private async confirmCurrent(
    journal: OrdinaryCalendarJournalDocument,
  ): Promise<OrdinaryCalendarDeliveryOutcome> {
    const authority = await this.verifyCommittedBooking(journal);
    if (authority.kind !== "OK" || authority.journal.latest.sequence !== journal.latest.sequence)
      return "RETRY";
    return (await this.repository.confirm(authority.journal)) ? "DONE" : "RETRY";
  }

  /** Observation-only handling for an unresolved request or a settled ambiguity. */
  private async reconcile(journal: OrdinaryCalendarJournalDocument, port: OrdinaryCalendarPort) {
    const observation = await this.observe(journal, port);
    if (!observation) return "RETRY" as const;
    const step = planOrdinaryCalendarStep(journal, observation, true);
    if (step.action === "CONFIRM") return this.confirmCurrent(journal);
    if (step.action === "BLOCK") {
      await this.repository.block(
        journal,
        step.state,
        step.reason,
        step.state === "UNKNOWN_OUTCOME" ? this.later(UNKNOWN_DELAY_MS) : undefined,
      );
      return "BLOCKED" as const;
    }
    if (step.action === "NONE") return "SKIPPED" as const;
    // The provider now permits a conditional write again; return the row to dispatch.
    await this.repository.reopen(journal);
    return "RETRY" as const;
  }

  async deliver(
    journalId: Types.ObjectId | string,
    depth = 0,
  ): Promise<OrdinaryCalendarDeliveryOutcome> {
    await verifyOrdinaryCalendarDeliveryAuthority();
    let journal = await this.repository.findById(journalId);
    if (!journal || journal.mode !== "AUTHORITATIVE") return "SKIPPED";
    if (journal.state === "CONFIRMED" && journal.confirmedSequence === journal.latest.sequence)
      return "DONE";
    if (journal.state === "BLOCKED_AUTHORITY" || journal.state === "PERMANENT_FAILURE")
      return "BLOCKED";

    const authority = await this.verifyCommittedBooking(journal);
    if (authority.kind === "STALE") return "RETRY";
    if (authority.kind === "BLOCK") {
      await this.repository.block(journal, authority.state, authority.reason);
      return "BLOCKED";
    }
    journal = authority.journal;
    const eventId = journal.eventIdentity.eventId;
    if (
      journal.eventIdentity.kind !== "ALLOCATED" ||
      eventId !== ordinaryCalendarEventId(journal.bookingId)
    ) {
      await this.repository.block(journal, "PERMANENT_FAILURE", "EVENT_IDENTITY_NOT_ALLOCATED");
      return "BLOCKED";
    }
    // P4B-2C — cancelled before any insert was ever issued: no event can exist in any calendar,
    // so ABSENT is already true. Settled without a provider call, even while disconnected.
    if (
      journal.latest.desired.kind === "ABSENT" &&
      !journal.createIssued &&
      (!journal.request || journal.request.settled)
    )
      return this.confirmCurrent(journal);
    if (!journal.destination || !(await this.destinationCurrent(journal))) {
      await this.repository.block(
        journal,
        "BLOCKED_AUTHORITY",
        journal.destination
          ? "CONNECTION_GENERATION_OR_DESTINATION_CHANGED"
          : "CALENDAR_NOT_CONNECTED_AT_CREATION",
      );
      return "BLOCKED";
    }
    const port = this.provider.bind({
      journalId: journal._id,
      bookingId: String(journal.bookingId),
      businessId: String(journal.businessId),
      eventId,
      destination: journal.destination,
    });

    const request = journal.request;
    if (request && !request.settled) {
      // A young request may belong to a live issuer that will acknowledge it.
      if (request.issuedAt.getTime() > this.clock().getTime() - ORDINARY_CALENDAR_ISSUER_WINDOW_MS)
        return "RETRY";
      if (!request.providerStarted) {
        // The issuer stopped before consuming its send permission: provably no provider effect.
        await this.repository.abandonUnstarted(journal._id, request.id);
        return depth < 1 ? this.deliver(journalId, depth + 1) : "RETRY";
      }
      return this.reconcile(journal, port);
    }
    if (journal.state === "UNKNOWN_OUTCOME") return this.reconcile(journal, port);

    const claim = await this.repository.prepare(journal);
    if (!claim) return "RETRY"; // Another worker holds a live claim.
    journal = claim.journal;
    const observation = await this.observe(journal, port);
    if (!observation) return "RETRY";
    const step = planOrdinaryCalendarStep(journal, observation, true);
    if (step.action === "NONE") return "SKIPPED";
    if (step.action === "CONFIRM") return this.confirmCurrent(journal);
    if (step.action === "BLOCK") {
      await this.repository.block(
        journal,
        step.state,
        step.reason,
        step.state === "UNKNOWN_OUTCOME" ? this.later(UNKNOWN_DELAY_MS) : undefined,
      );
      return "BLOCKED";
    }

    // Re-check committed authority and destination immediately before the durable issue: a
    // newer Booking revision since the observation is never written from this claim.
    const latest = await this.verifyCommittedBooking(journal);
    if (
      latest.kind !== "OK" ||
      latest.journal.latest.sequence !== journal.latest.sequence ||
      !(await this.destinationCurrent(journal))
    )
      return "RETRY";
    const issued = await this.repository.issue(
      journal,
      claim.token,
      step.action === "INSERT" ? { kind: "INSERT" } : { kind: step.action, etag: step.etag },
    );
    if (!issued) return "RETRY";
    const desired = issued.journal.latest.desired;
    const requestId = issued.request.id;

    let answer: string;
    try {
      if (step.action === "INSERT" && desired.kind === "PRESENT")
        answer = await port.insert(
          {
            summary: desired.summary,
            description: desired.description,
            startAt: desired.startAt,
            endAt: desired.endAt,
            timezone: desired.timezone,
          },
          requestId,
        );
      else if (step.action === "PATCH" && desired.kind === "PRESENT")
        answer = await port.patchSchedule(
          { startAt: desired.startAt, endAt: desired.endAt, timezone: desired.timezone },
          step.etag,
          requestId,
        );
      else if (step.action === "DELETE" && desired.kind === "ABSENT")
        answer = await port.remove(step.etag, requestId);
      else throw new PackageCalendarProviderError("PERMANENT_FAILURE", true);
    } catch (error) {
      const outcome = classify(error);
      await this.repository.acknowledge(journal._id, requestId, {
        state: outcome.state,
        definitiveNoEffect: outcome.noEffect,
        reason: `PROVIDER_${outcome.state}`,
        nextAttemptAt: this.later(
          outcome.state === "UNKNOWN_OUTCOME" ? UNKNOWN_DELAY_MS : RETRY_DELAY_MS,
        ),
      });
      return outcome.state === "RETRYABLE_FAILURE" || outcome.state === "UNKNOWN_OUTCOME"
        ? "RETRY"
        : "BLOCKED";
    }

    // 412 and a PATCH 404 are definitive "not applied" answers. Everything else (including a
    // 409 for an existing id) must be read back before anything is confirmed.
    const notApplied = answer === "PRECONDITION_FAILED" || answer === "NOT_FOUND";
    await this.repository.acknowledge(
      journal._id,
      requestId,
      notApplied
        ? {
            state: "RETRYABLE_FAILURE",
            definitiveNoEffect: true,
            reason: answer === "NOT_FOUND" ? "EVENT_MISSING_AT_PATCH" : "ETAG_PRECONDITION_FAILED",
          }
        : { state: "PENDING", definitiveNoEffect: false, reason: "AWAITING_READ_BACK" },
    );
    return depth < 1 ? this.deliver(journalId, depth + 1) : "RETRY";
  }

  /**
   * Explicit Business Owner recovery for ONE Booking and, when unresolved, ONE exact request.
   * The Owner proof is the verified Bearer/sid session capability shared with P2C (session
   * authority only; no Package purchase authority is involved). Quiescence and provider
   * settlement are an attested incident decision, never inferred from a timeout or a 404.
   * `createIssued` is never cleared here, so recovery cannot authorize a duplicate insert.
   *
   * Destination rules:
   *  - unchanged connection: allowed;
   *  - `rebindToCurrentConnection`: a new connection of the SAME account, e-mail and calendar;
   *  - `bindUnusedDestination` (P4B-2C): the Booking never had any Calendar write
   *    (no insert issued, no unresolved request), so no event can exist anywhere and binding it
   *    to the Owner's current connection cannot duplicate one. This is the only way a Booking
   *    created while disconnected, or one whose old account is gone before its first write, is
   *    later synchronized, and only by this explicit per-Booking Owner decision.
   * A different account or calendar is otherwise always refused.
   */
  async recover(
    input: {
      bookingId: string;
      businessId: string;
      actorUserId: string;
      requestId?: string;
      incidentReference: string;
      assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED" | "NO_UNRESOLVED_REQUEST";
      rebindToCurrentConnection?: boolean;
      bindUnusedDestination?: boolean;
    },
    ownerProof: PackageCalendarOwner,
  ) {
    await verifyOrdinaryCalendarDeliveryAuthority();
    const refuse = (message: string) => new OrdinaryCalendarJournalConflictError(message);
    const owner = await readVerifiedCalendarOwner(ownerProof);
    const id = /^[a-f0-9]{24}$/;
    if (
      owner.userId !== input.actorUserId ||
      !id.test(input.bookingId) ||
      !id.test(input.businessId)
    )
      throw refuse("Recovery actor or target is invalid");
    const [user, business] = await Promise.all([
      UserModel.findOne({ _id: input.actorUserId, role: "BUSINESS_OWNER", status: "ACTIVE" })
        .read("primary")
        .maxTimeMS(2000),
      BusinessModel.findOne({ _id: input.businessId, ownerUserId: input.actorUserId })
        .read("primary")
        .maxTimeMS(2000),
    ]);
    if (!user || !business)
      throw refuse("Only the Business Owner may recover its Calendar delivery");
    const incidentReference = input.incidentReference.trim();
    if (!incidentReference || incidentReference.length > 200)
      throw refuse("An incident reference is required");

    const journal = await OrdinaryCalendarJournalModel.findOne({
      bookingId: input.bookingId,
      businessId: input.businessId,
    })
      .read("primary")
      .exec();
    if (!journal || journal.mode !== "AUTHORITATIVE" || journal.eventIdentity.kind !== "ALLOCATED")
      throw refuse("Only a journal-owned Booking can be recovered");
    const unresolved = journal.request && !journal.request.settled ? journal.request : undefined;
    if (
      unresolved
        ? input.requestId !== unresolved.id ||
          input.assertion !== "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED"
        : input.requestId !== undefined || input.assertion !== "NO_UNRESOLVED_REQUEST"
    )
      throw refuse("Recovery must name the exact unresolved request and attest its settlement");

    const old = journal.destination;
    const current = await this.provider.currentDestination(input.businessId);
    if (!current) throw refuse("The Business has no usable Calendar connection");
    const neverWritten = !journal.createIssued && !unresolved;
    let binding: "UNCHANGED" | "SAME_ACCOUNT_REBIND" | "UNUSED_DESTINATION_BIND";
    if (old && sameOrdinaryCalendarDestination(old, current)) binding = "UNCHANGED";
    else if (
      old &&
      input.rebindToCurrentConnection &&
      current.accountId === old.accountId &&
      current.accountEmail === old.accountEmail &&
      current.configuredCalendarId === old.configuredCalendarId
    )
      binding = "SAME_ACCOUNT_REBIND";
    else if (input.bindUnusedDestination && neverWritten) binding = "UNUSED_DESTINATION_BIND";
    else if (!old)
      throw refuse(
        "This Booking never had a Calendar destination; an explicit unused-destination bind is required",
      );
    else throw refuse("A different Google account or calendar is never adopted automatically");

    const observation = await this.provider
      .bind({
        journalId: journal._id,
        bookingId: String(journal.bookingId),
        businessId: String(journal.businessId),
        eventId: journal.eventIdentity.eventId,
        destination: current,
      })
      .read();
    if (observation.outcome === "NOT_CONNECTED")
      throw refuse("The Calendar connection cannot be observed");
    await this.provider.assertCurrent(input.businessId, current);
    const recovered = await this.repository.recover(journal, {
      destination: current,
      record: {
        actorUserId: user._id,
        sessionFamilyId: owner.sessionFamilyId,
        incidentReference,
        assertion: input.assertion,
        binding,
        ...(unresolved ? { requestId: unresolved.id } : {}),
        ...(old ? { previousGeneration: old.generation } : {}),
        generation: current.generation,
        at: this.clock(),
      },
    });
    if (!recovered) throw refuse("The journal changed during recovery");
    return this.repository.findById(journal._id);
  }
}
