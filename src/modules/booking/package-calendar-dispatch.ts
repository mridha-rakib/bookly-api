import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import mongoose, { Types } from "mongoose";
import { z } from "zod";
import { BusinessModel } from "../business/business.model.js";
import { UserModel } from "../user/user.model.js";
import { releaseBatchCalendarTask } from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { batchConflict } from "./package-batch-contract.js";
import { PackageCalendarRepository } from "./package-calendar.repository.js";
import {
  type PackageCalendarOwner,
  readVerifiedCalendarOwner,
  verifyPackageCalendarProductionAuthority,
} from "./package-calendar-authority.js";
import {
  type CalendarDestination,
  type CalendarJournal,
  type CalendarTaskReference,
  calendarBookingIntent,
  calendarDestinationSchema,
  calendarJournalSchema,
  calendarTaskIdentity,
} from "./package-calendar-contract.js";
import {
  type PackageCalendarDeliveryPort,
  type PackageCalendarObservation,
  type PackageCalendarOutcome,
  PackageCalendarProviderError,
  packageCalendarEventId,
} from "./package-calendar-delivery.js";
import { readCalendarTaskAuthority } from "./package-calendar-membership.js";
import { PackageLifecycleOperations } from "./package-lifecycle-operation.js";

export type PackageCalendarDestinationProvider = {
  resolve(businessId: string): Promise<CalendarDestination>;
  assertCurrent(destination: CalendarDestination): Promise<void>;
  bind(
    destination: CalendarDestination,
    identity?: { bookingId: string; eventId: string },
  ): PackageCalendarDeliveryPort;
};
const decisionSchema = z
  .object({
    actorUserId: z.string().regex(/^[a-f0-9]{24}$/),
    decisionId: z.uuid(),
    expectedRevision: z.string().length(64),
    reason: z.string().min(1).max(1000),
    action: z.literal("RELEASE_EXACT_CALENDAR_TASK"),
  })
  .strict();
export type CalendarReleaseDecision = z.infer<typeof decisionSchema>;

/** Shared coordination for the existing batch and lifecycle tasks. No worker registration.
 * REQUEST_ISSUED is durably written BEFORE calling Google; it is never lease-stolen for a
 * second mutation. Expired/uncertain issuers permit observation only until acknowledged or
 * explicitly quiesced by an authorized operator. DB CAS is not a Google request fence. */
export class PackageCalendarDispatch {
  constructor(
    private readonly provider: PackageCalendarDestinationProvider,
    private readonly repository = new PackageCalendarRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async gate() {
    await verifyPackageBatchActivation();
    await verifyPackageCalendarProductionAuthority();
  }
  private async owner(actorUserId: string, businessId: string) {
    const user = await UserModel.findOne({
      _id: actorUserId,
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    })
      .read("primary")
      .maxTimeMS(2000);
    const business = await BusinessModel.findOne({ _id: businessId, ownerUserId: actorUserId })
      .read("primary")
      .maxTimeMS(2000);
    if (!user || !business) throw batchConflict();
  }

  async release(
    reference: CalendarTaskReference,
    input: CalendarReleaseDecision,
    ownerProof: PackageCalendarOwner,
  ) {
    await this.gate();
    const decision = decisionSchema.parse(input);
    const owner = await readVerifiedCalendarOwner(ownerProof);
    if (owner.userId !== decision.actorUserId) throw batchConflict();
    const authority = await readCalendarTaskAuthority(reference);
    const { booking, purchase } = authority;
    const businessId = String(booking.businessId);
    await this.owner(decision.actorUserId, businessId);
    const intended = calendarBookingIntent(booking);
    if (!authority.current || decision.expectedRevision !== intended.revision)
      throw batchConflict();
    const destination = calendarDestinationSchema.parse(await this.provider.resolve(businessId));
    if (destination.businessId !== businessId) throw batchConflict();
    const old =
      booking.packageCalendarDelivery === undefined
        ? undefined
        : calendarJournalSchema.parse(booking.packageCalendarDelivery);
    const taskId = calendarTaskIdentity(reference);
    if (old && !isDeepStrictEqual(old.destination, destination)) throw batchConflict();
    if (
      booking.googleCalendarEventId &&
      booking.googleCalendarEventId !== packageCalendarEventId(booking._id)
    )
      throw batchConflict(); // Explicit migration required for unmarked legacy event identity.
    const priorDecision = old?.decisions.find((entry) => entry.decisionId === decision.decisionId);
    if (old && priorDecision) {
      if (
        priorDecision.taskId !== taskId ||
        priorDecision.revision !== intended.revision ||
        priorDecision.actorUserId !== decision.actorUserId ||
        priorDecision.reason !== decision.reason
      )
        throw batchConflict();
      return old;
    }
    const now = this.clock();
    const next = calendarJournalSchema.parse({
      ...(old ?? {
        version: 1,
        businessId,
        bookingId: String(booking._id),
        customerUserId: String(purchase.preparation.customerUserId),
        businessClientId: String(purchase.preparation.businessClientId),
        packageProgressId: String(purchase.preparation.packageProgressId),
        purchaseClaimId: String(authority.claimId),
        destination,
        eventId: packageCalendarEventId(booking._id),
        createIssued: false,
        decisions: [],
      }),
      latest: {
        task: reference,
        taskId,
        ...intended,
        decisionId: decision.decisionId,
        actorUserId: decision.actorUserId,
        sessionFamilyId: owner.sessionFamilyId,
        releasedAt: now,
      },
      state: old?.request && !old.request.settled ? "UNKNOWN_OUTCOME" : "NOT_DISPATCHED",
      decisions: [
        ...(old?.decisions ?? []),
        {
          decisionId: decision.decisionId,
          actorUserId: decision.actorUserId,
          reason: decision.reason,
          taskId,
          revision: intended.revision,
          at: now,
          sessionFamilyId: owner.sessionFamilyId,
        },
      ],
    });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(
        async () => {
          if (!(await this.repository.compareAndSet(booking, old, next, { session })))
            throw batchConflict();
          if (reference.kind === "BATCH")
            await releaseBatchCalendarTask(
              new Types.ObjectId(reference.claimId),
              reference.key,
              now,
              session,
            );
          else
            await new PackageLifecycleOperations().releaseCalendarDelivery(
              new Types.ObjectId(reference.operationId),
              reference.index,
              now,
              session,
            );
        },
        { writeConcern: { w: "majority" } },
      );
    } finally {
      await session.endSession();
    }
    return next;
  }

  /** A reconnect to the SAME account/calendar is an explicit new owner decision. Different
   * destinations are never adopted automatically. Quiescence is a privileged incident
   * attestation, not something a timeout or GET 404 can establish. */
  async recover(
    input: {
      bookingId: string;
      businessId: string;
      actorUserId: string;
      requestId?: string;
      incidentReference: string;
      assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED";
    },
    ownerProof: PackageCalendarOwner,
  ) {
    await this.gate();
    const owner = await readVerifiedCalendarOwner(ownerProof);
    if (owner.userId !== input.actorUserId) throw batchConflict();
    await this.owner(input.actorUserId, input.businessId);
    if (
      !input.incidentReference.trim() ||
      input.assertion !== "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED"
    )
      throw batchConflict();
    const booking = await this.repository.read(input.bookingId, input.businessId);
    if (!booking) throw batchConflict();
    const old = calendarJournalSchema.parse(booking.packageCalendarDelivery);
    const authority = await readCalendarTaskAuthority(old.latest.task);
    if (!authority.booking._id.equals(booking._id)) throw batchConflict();
    if (old.request && !old.request.settled && input.requestId !== old.request.id)
      throw batchConflict();
    const destination = calendarDestinationSchema.parse(
      await this.provider.resolve(input.businessId),
    );
    if (
      destination.accountId !== old.destination.accountId ||
      destination.accountEmail !== old.destination.accountEmail ||
      destination.calendarId !== old.destination.calendarId ||
      destination.businessId !== old.businessId
    )
      throw batchConflict();
    // Observe using the explicitly reauthorized same destination. Observation does not by
    // itself authorize re-insertion: createIssued is never cleared by incident recovery.
    const observation = await this.provider.bind(destination).read(old.businessId, old.eventId);
    if (observation.outcome === "NOT_CONNECTED") throw batchConflict();
    await this.provider.assertCurrent(destination);
    const next: CalendarJournal = {
      ...old,
      destination,
      state: "RETRYABLE_FAILURE",
      ...(old.request ? { request: { ...old.request, settled: true } } : {}),
      recovery: {
        ...(old.request ? { requestId: old.request.id } : {}),
        actorUserId: input.actorUserId,
        incidentReference: input.incidentReference,
        assertion: input.assertion,
        at: this.clock(),
        sessionFamilyId: owner.sessionFamilyId,
      },
    };
    delete next.lease;
    if (!(await this.repository.compareAndSet(booking, old, next, { rebind: true })))
      throw batchConflict();
    return next;
  }

  private owned(observation: PackageCalendarObservation, journal: CalendarJournal) {
    return (
      observation.outcome === "FOUND" &&
      observation.marker.booklyBookingId === journal.bookingId &&
      observation.marker.booklyBusinessId === journal.businessId
    );
  }
  private matches(observation: PackageCalendarObservation, journal: CalendarJournal) {
    const d = journal.latest.desired;
    if (d.kind === "ABSENT")
      return (
        observation.outcome === "NOT_FOUND" ||
        (observation.outcome === "FOUND" && observation.status === "cancelled")
      );
    return (
      d.kind === "PRESENT" &&
      observation.outcome === "FOUND" &&
      this.owned(observation, journal) &&
      observation.status === "confirmed" &&
      observation.startAt?.getTime() === d.startAt.getTime() &&
      observation.endAt?.getTime() === d.endAt.getTime()
    );
  }

  private async saveState(
    journal: CalendarJournal,
    state: CalendarJournal["state"],
    reason: string,
  ) {
    const booking = await this.repository.read(journal.bookingId, journal.businessId);
    if (!booking) return false;
    const old = calendarJournalSchema.parse(booking.packageCalendarDelivery);
    if (
      old.latest.revision !== journal.latest.revision ||
      old.latest.taskId !== journal.latest.taskId
    )
      return false;
    const next = { ...old, state, reason };
    delete next.lease;
    return this.repository.compareAndSet(booking, old, next);
  }

  /** Late responses may settle only their exact durable request. They never mark a newer
   * revision delivered. CAS retries here persist an acknowledgement, never repeat Google. */
  private async acknowledge(
    journal: CalendarJournal,
    settled: boolean,
    state: CalendarJournal["state"],
    noEffect = false,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const booking = await this.repository.read(journal.bookingId, journal.businessId);
      if (!booking) return false;
      const old = calendarJournalSchema.parse(booking.packageCalendarDelivery);
      if (!old.request || old.request.id !== journal.request?.id) return false;
      const next: CalendarJournal = {
        ...old,
        request: { ...old.request, settled },
        state,
        createIssued: noEffect && old.request.kind === "INSERT" ? false : old.createIssued,
      };
      delete next.lease;
      if (await this.repository.compareAndSet(booking, old, next)) return true;
    }
    return false;
  }

  async deliver(
    reference: CalendarTaskReference,
    reconciliationOnly = false,
  ): Promise<PackageCalendarOutcome | "SKIPPED"> {
    await this.gate();
    const authority = await readCalendarTaskAuthority(reference);
    if (!authority.current) return "SKIPPED";
    let booking = authority.booking;
    if (booking.packageCalendarDelivery === undefined) return "BLOCKED_UNVERIFIED";
    let journal = calendarJournalSchema.parse(booking.packageCalendarDelivery);
    // This is a current committed task, but its owner decision has not been recorded yet.
    // Keep it releasable; only a genuinely stale Booking revision is terminally SKIPPED.
    if (journal.latest.taskId !== calendarTaskIdentity(reference)) return "BLOCKED_UNVERIFIED";
    if (
      journal.bookingId !== String(booking._id) ||
      journal.businessId !== String(booking.businessId) ||
      journal.purchaseClaimId !== String(authority.claimId) ||
      journal.customerUserId !== String(authority.purchase.preparation.customerUserId) ||
      journal.businessClientId !== String(authority.purchase.preparation.businessClientId) ||
      journal.packageProgressId !== String(authority.purchase.preparation.packageProgressId) ||
      journal.destination.businessId !== journal.businessId ||
      journal.eventId !== packageCalendarEventId(booking._id) ||
      (booking.googleCalendarEventId !== undefined &&
        booking.googleCalendarEventId !== journal.eventId) ||
      journal.latest.revision !== calendarBookingIntent(booking).revision ||
      !isDeepStrictEqual(journal.latest.desired, calendarBookingIntent(booking).desired)
    )
      return "BLOCKED_UNVERIFIED";
    if (journal.latest.desired.kind === "UNCHANGED") return "SKIPPED";
    const port = this.provider.bind(journal.destination, {
      bookingId: journal.bookingId,
      eventId: journal.eventId,
    });
    try {
      await this.owner(journal.latest.actorUserId, journal.businessId);
      await this.provider.assertCurrent(journal.destination);
    } catch {
      await this.saveState(
        journal,
        "BLOCKED_AUTHORITY",
        "CONNECTION_GENERATION_OR_DESTINATION_CHANGED",
      );
      return "BLOCKED_UNVERIFIED";
    }
    if (journal.state === "PERMANENT_FAILURE") return "BLOCKED_UNVERIFIED";
    const unresolved = journal.request && !journal.request.settled;
    if (!unresolved) {
      if (journal.lease && journal.lease.expiresAt > this.clock()) return "RETRY";
      const prepared: CalendarJournal = {
        ...journal,
        state: "DISPATCH_PREPARED",
        lease: { token: randomUUID(), expiresAt: new Date(this.clock().getTime() + 45_000) },
      };
      if (!(await this.repository.compareAndSet(booking, journal, prepared))) return "RETRY";
      journal = prepared;
    }
    let observation: PackageCalendarObservation;
    try {
      observation = await port.read(journal.businessId, journal.eventId);
    } catch {
      await this.saveState(
        journal,
        unresolved ? "UNKNOWN_OUTCOME" : "RETRYABLE_FAILURE",
        "PROVIDER_READ_FAILED",
      );
      return "RETRY";
    }
    if (observation.outcome === "NOT_CONNECTED") {
      await this.saveState(journal, "BLOCKED_AUTHORITY", "CALENDAR_DISCONNECTED");
      return "BLOCKED_UNVERIFIED";
    }
    // A pending earlier mutation may still land AFTER this observation. Never attest a newer
    // revision or issue a competing write merely because its present state looks right.
    if (unresolved && journal.request?.revision !== journal.latest.revision) {
      await this.saveState(journal, "UNKNOWN_OUTCOME", "EARLIER_REQUEST_MAY_STILL_MUTATE_PROVIDER");
      return "BLOCKED_UNVERIFIED";
    }
    if (this.matches(observation, journal)) {
      // Persist identity only after authoritative observation; an acknowledgement is not enough.
      const fresh = await this.repository.read(journal.bookingId, journal.businessId);
      if (!fresh) return "RETRY";
      const old = calendarJournalSchema.parse(fresh.packageCalendarDelivery);
      if (
        old.latest.revision !== journal.latest.revision ||
        old.latest.taskId !== journal.latest.taskId ||
        calendarBookingIntent(fresh).revision !== journal.latest.revision
      )
        return "RETRY";
      await this.provider.assertCurrent(old.destination);
      const next: CalendarJournal = {
        ...old,
        state: "CONFIRMED_DELIVERED",
        confirmedRevision: old.latest.revision,
      };
      delete next.lease;
      return (await this.repository.compareAndSet(fresh, old, next, {
        persistEventId: old.latest.desired.kind === "PRESENT",
      }))
        ? "DONE"
        : "RETRY";
    }
    if (unresolved) {
      await this.saveState(
        journal,
        "UNKNOWN_OUTCOME",
        "UNRESOLVED_REQUEST_REQUIRES_QUIESCENCE_DECISION",
      );
      return "BLOCKED_UNVERIFIED";
    }
    if (reconciliationOnly) {
      await this.saveState(journal, "RETRYABLE_FAILURE", "WRITE_NOT_YET_OBSERVED");
      return "RETRY";
    }
    const d = journal.latest.desired;
    let kind: "INSERT" | "PATCH" | "DELETE";
    let etag: string | undefined;
    if (observation.outcome === "NOT_FOUND") {
      if (d.kind !== "PRESENT" || journal.createIssued) {
        await this.saveState(
          journal,
          "UNKNOWN_OUTCOME",
          "MISSING_EVENT_DOES_NOT_AUTHORIZE_RECREATE",
        );
        return "BLOCKED_UNVERIFIED";
      }
      kind = "INSERT";
    } else {
      if (
        !this.owned(observation, journal) ||
        observation.status !== "confirmed" ||
        !observation.etag
      ) {
        await this.saveState(
          journal,
          "PERMANENT_FAILURE",
          "EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED",
        );
        return "BLOCKED_UNVERIFIED";
      }
      etag = observation.etag;
      kind = d.kind === "ABSENT" ? "DELETE" : "PATCH";
    }
    await this.provider.assertCurrent(journal.destination);
    const freshAuthority = await readCalendarTaskAuthority(reference);
    booking = freshAuthority.booking;
    if (
      !freshAuthority.current ||
      calendarBookingIntent(booking).revision !== journal.latest.revision ||
      !journal.lease ||
      journal.lease.expiresAt <= this.clock()
    )
      return "RETRY";
    const issued: CalendarJournal = {
      ...journal,
      state: "REQUEST_ISSUED",
      createIssued: journal.createIssued || kind === "INSERT",
      request: {
        id: randomUUID(),
        kind,
        revision: journal.latest.revision,
        issuedAt: this.clock(),
        settled: false,
        ...(etag ? { etag } : {}),
      },
    };
    if (!(await this.repository.compareAndSet(booking, journal, issued))) return "RETRY";
    journal = issued;
    try {
      const result =
        kind === "INSERT" && d.kind === "PRESENT"
          ? await port.insert(
              journal.businessId,
              journal.eventId,
              d,
              { booklyBookingId: journal.bookingId, booklyBusinessId: journal.businessId },
              issued.request!.id,
            )
          : kind === "PATCH" && d.kind === "PRESENT"
            ? await port.patchSchedule(
                journal.businessId,
                journal.eventId,
                d,
                etag,
                issued.request!.id,
              )
            : await port.remove(journal.businessId, journal.eventId, etag, issued.request!.id);
      if (result === "NOT_CONNECTED")
        throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
      if (!(await this.acknowledge(journal, true, "RETRYABLE_FAILURE"))) return "RETRY";
      // Re-enter for read-back only on the SAME task/revision. The acknowledged request's
      // durable createIssued prevents any second insert, including after a missing read.
      if (result === "PRECONDITION_FAILED" || result === "NOT_FOUND") return "RETRY";
      return this.deliver(reference, true);
    } catch (error) {
      const classified = error instanceof PackageCalendarProviderError ? error : undefined;
      const state = classified?.kind ?? "UNKNOWN_OUTCOME";
      await this.acknowledge(
        journal,
        classified?.definitiveNoEffect === true,
        state,
        classified?.definitiveNoEffect === true,
      );
      return state === "RETRYABLE_FAILURE" || state === "UNKNOWN_OUTCOME"
        ? "RETRY"
        : "BLOCKED_UNVERIFIED";
    }
  }
}
