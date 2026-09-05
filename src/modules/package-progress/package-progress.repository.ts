import type { ClientSession, Types } from "mongoose";

import { type PackageProgressDocument, PackageProgressModel } from "./package-progress.model.js";

export type CreatePackageProgressInput = Omit<
  PackageProgressDocument,
  "createdAt" | "updatedAt"
> & {
  _id: Types.ObjectId;
};

export class PackageProgressRepository {
  public async create(
    input: CreatePackageProgressInput,
    session?: ClientSession,
  ): Promise<PackageProgressDocument> {
    return new PackageProgressModel(input).save(session ? { session } : undefined);
  }

  /** Best-effort rollback of a purchase whose own Booking write failed after the entitlement
   * was already inserted (see BookingCreationService.finalizePackagePurchase's own comment) —
   * never called once a session may have been redeemed against this row. */
  public async deleteById(id: Types.ObjectId, session?: ClientSession): Promise<void> {
    await PackageProgressModel.deleteOne({ _id: id }, session ? { session } : undefined).exec();
  }

  /** Cross-business Customer-scoped read — "My Packages" detail (`/me/packages/:id`), scoped
   * ONLY by customerUserId (matches BookingRepository.findByIdForCustomer's own cross-business
   * shape: never a businessId in this URL). Anti-enumeration: both conditions in the SAME
   * query, never a fetch-then-compare. */
  public async findByIdForCustomer(
    id: Types.ObjectId | string,
    customerUserId: Types.ObjectId | string,
  ): Promise<PackageProgressDocument | null> {
    return PackageProgressModel.findOne({ _id: id, customerUserId }).exec();
  }

  /** Business-scoped Customer-owned read — the redemption endpoint's own lookup
   * (`/:businessId/bookings/packages/:packageProgressId/sessions`), scoped by BOTH businessId
   * AND customerUserId in the same query so a packageProgressId that exists but belongs to a
   * different business or a different customer is indistinguishable from an unknown id. */
  public async findByIdForCustomerAndBusiness(
    id: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
    customerUserId: Types.ObjectId | string,
  ): Promise<PackageProgressDocument | null> {
    return PackageProgressModel.findOne({ _id: id, businessId, customerUserId }).exec();
  }

  /** Cross-business "My Packages" list — mirrors BookingRepository.listForCustomer's own
   * cross-business, customerUserId-scoped shape. */
  public async listForCustomer(
    customerUserId: Types.ObjectId | string,
  ): Promise<PackageProgressDocument[]> {
    return PackageProgressModel.find({ customerUserId }).sort({ createdAt: -1 }).exec();
  }

  /**
   * THE atomic session-consumption primitive — a single `findOneAndUpdate` whose FILTER
   * re-asserts `remainingSessions >= 1` and whose UPDATE decrements it, one indivisible
   * storage-engine operation (the exact pattern this codebase already proved correct for
   * `BookingSlotReservationRepository.createInterval`'s capacity guard — see that model's own
   * doc comment). MongoDB serializes concurrent writes to the same document, so two genuinely
   * simultaneous redemption attempts against the LAST remaining session can never both succeed:
   * exactly one observes `remainingSessions: 1 -> 0` and wins; the other's filter no longer
   * matches (`remainingSessions: 0`) and this returns `null`. Never a naive
   * read-then-decrement-then-save — there is no read step at all before the guarded write.
   *
   * The returned document's `remainingSessions` (post-decrement) is what the caller uses to
   * derive this claim's `sessionIndex = totalSessions - remainingSessions` — safe precisely
   * because MongoDB's per-document write serialization guarantees no two concurrent successful
   * decrements ever observe the same post-decrement value.
   */
  public async claimSession(
    id: Types.ObjectId,
    session?: ClientSession,
  ): Promise<PackageProgressDocument | null> {
    return PackageProgressModel.findOneAndUpdate(
      { _id: id, remainingSessions: { $gte: 1 } },
      { $inc: { remainingSessions: -1 } },
      { returnDocument: "after", ...(session ? { session } : {}) },
    ).exec();
  }

  /** Appends the audit-trail entry for a session claimSession just reserved capacity for.
   * Always called immediately after a successful claimSession, in the SAME transaction — never
   * re-guards the count (that already happened atomically above). */
  public async recordScheduledSession(
    id: Types.ObjectId,
    sessionIndex: number,
    bookingId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    await PackageProgressModel.updateOne(
      { _id: id },
      { $push: { sessions: { sessionIndex, bookingId, status: "SCHEDULED" } } },
      session ? { session } : undefined,
    ).exec();
  }

  /**
   * The single terminal-status resolution hook for a Package-linked session's Booking —
   * replaces the old restore-only `restoreSessionOnCancellation` (Phase 4B correction: a LATE
   * cancellation or genuine no-show must FORFEIT the session, never restore it — see
   * package-progress.rules.ts's own doc comment for the full RESTORE/FORFEIT mapping, which is
   * the ONLY place that decision is made; this method just executes whichever the caller already
   * decided). `$elemMatch` in the filter (not two separate dotted-path conditions) is what
   * guarantees `bookingId` and `status: "SCHEDULED"` are checked against the SAME array element
   * before the positional `$` updates it — the exact concern booking-slot-reservation.model.ts's
   * own doc comment raises about naive multi-condition array filters. Idempotent either way: if
   * the session is no longer "SCHEDULED" (already resolved by an earlier call, or already
   * COMPLETED), the filter matches nothing and this is a safe no-op — matching
   * BookingSlotReservationService.release's own "already released is a successful no-op"
   * convention, never an error on retry.
   */
  public async resolveSessionOnTerminalStatus(
    bookingId: Types.ObjectId,
    outcome: "RESTORE" | "FORFEIT",
    session?: ClientSession,
  ): Promise<void> {
    const update =
      outcome === "RESTORE"
        ? { $inc: { remainingSessions: 1 }, $set: { "sessions.$.status": "CANCELLED" as const } }
        : { $set: { "sessions.$.status": "FORFEITED" as const } };

    await PackageProgressModel.updateOne(
      { sessions: { $elemMatch: { bookingId, status: "SCHEDULED" } } },
      update,
      session ? { session } : undefined,
    ).exec();
  }

  /** Completion hook — marks the session consumed. Purely informational (`completedSessions`
   * never feeds back into `remainingSessions`); same idempotent `$elemMatch`-guarded shape as
   * resolveSessionOnTerminalStatus above. */
  public async markSessionCompleted(
    bookingId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    await PackageProgressModel.updateOne(
      { sessions: { $elemMatch: { bookingId, status: "SCHEDULED" } } },
      { $inc: { completedSessions: 1 }, $set: { "sessions.$.status": "COMPLETED" } },
      session ? { session } : undefined,
    ).exec();
  }

  /**
   * Voids a completely-unused Package (BookingLifecycleService.voidUnusedPackage's own doc
   * comment has the full eligibility rule — this method only performs the atomic write once
   * eligibility has already been proven). Guarded on `voidedAt` not already being set, so a
   * retried/duplicate void request is a safe no-op rather than a double-refund risk at this
   * layer (the caller still checks the returned document to distinguish "voided just now" from
   * "already voided" — see that method). Returns the updated document, or `null` if it was
   * already voided.
   */
  public async voidPackage(
    id: Types.ObjectId,
    session?: ClientSession,
  ): Promise<PackageProgressDocument | null> {
    return PackageProgressModel.findOneAndUpdate(
      { _id: id, voidedAt: { $exists: false } },
      { $set: { voidedAt: new Date() } },
      { returnDocument: "after", ...(session ? { session } : {}) },
    ).exec();
  }

  /** True if this Service has at least one Package entitlement still owed real, usable sessions
   * — a not-yet-voided row with `remainingSessions > 0` (approved rule: this is what blocks
   * archiving the Service, and separately what blocks removing the last eligible staff member —
   * see ServiceService.archiveService / StaffService's own callers). A `remainingSessions <= 0`
   * (fully depleted) or already-`voidedAt` entitlement owes nothing further and never blocks. */
  public async hasOutstandingEntitlementsForService(
    businessId: Types.ObjectId | string,
    serviceId: Types.ObjectId | string,
  ): Promise<boolean> {
    return PackageProgressModel.exists({
      businessId,
      serviceId,
      remainingSessions: { $gt: 0 },
      voidedAt: { $exists: false },
    }).then((doc) => doc !== null);
  }
}
