import { type ClientSession, Types } from "mongoose";

import {
  type BusinessClientDocument,
  type BusinessClientFinancialRelationship,
  BusinessClientModel,
} from "./client.model.js";

/** Bounds only the window between the first claim and binding a PaymentAttempt (which happens
 * before any provider dispatch). Generous: it covers server-side pricing + Stripe Tax compute. */
export const FIRST_CLAIM_PRE_DISPATCH_LEASE_MS = 15 * 60_000;

export type FirstClaimIdentity = {
  idempotencyKey: string;
  bookingId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
};

type RelationshipRow = BusinessClientDocument & {
  financialRelationship: BusinessClientFinancialRelationship;
};

const STATE = "financialRelationship.state";
const PENDING_KEY = "financialRelationship.pending.idempotencyKey";
const PENDING_ATTEMPT = "financialRelationship.pending.paymentAttemptId";
const REVISION = "financialRelationship.revision";

/**
 * P1 — the ONLY writer of BusinessClient.financialRelationship. Every method is one atomic,
 * conditional single-document update (MongoDB per-document atomicity); none read-then-write.
 * The relationship row itself is the BusinessClient (unique per `{businessId, linkedUserId}`),
 * so there is exactly one authoritative relationship per customer+business pair.
 */
export class FinancialRelationshipRepository {
  /**
   * Lazy, additive legacy initialization — never a global backfill. Each branch is conditioned
   * on BOTH "no v2 state yet" and the `activatedAt` value at write time, so the interpretation
   * is taken atomically from the row itself:
   *   activatedAt present -> CONSUMED (an already-returning customer stays returning)
   *   activatedAt absent  -> ELIGIBLE
   * Audit basis for trusting `activatedAt` (see the P1 report): its only writer was
   * ClientRepository.markActivated, called only inside the customer booking/package-purchase
   * persistence transaction after a successful upfront charge — never for MANUAL bookings and
   * never for package Session 2+ redemptions.
   */
  public async ensureInitialized(clientId: Types.ObjectId): Promise<RelationshipRow> {
    const now = new Date();
    for (const legacyActivated of [true, false]) {
      await BusinessClientModel.updateOne(
        {
          _id: clientId,
          financialRelationship: { $exists: false },
          activatedAt: { $exists: legacyActivated },
        },
        {
          $set: {
            financialRelationship: {
              version: 2,
              state: legacyActivated ? "CONSUMED" : "ELIGIBLE",
              revision: 0,
              initializedFrom: legacyActivated ? "LEGACY_ACTIVATED" : "LEGACY_UNACTIVATED",
              stateChangedAt: now,
            },
          },
        },
      ).exec();
    }
    const row = await BusinessClientModel.findById(clientId).exec();
    if (!row?.financialRelationship) {
      throw new Error("BusinessClient financial relationship could not be initialized");
    }
    return row as RelationshipRow;
  }

  public async findByClientId(clientId: Types.ObjectId | string): Promise<RelationshipRow | null> {
    const row = await BusinessClientModel.findById(clientId).exec();
    return row?.financialRelationship ? (row as RelationshipRow) : null;
  }

  /** The atomic first claim: ELIGIBLE -> FIRST_PENDING. Exactly one concurrent caller can match. */
  public async claimFirst(
    clientId: Types.ObjectId,
    identity: FirstClaimIdentity,
  ): Promise<RelationshipRow | null> {
    const now = new Date();
    return (await BusinessClientModel.findOneAndUpdate(
      { _id: clientId, "financialRelationship.version": 2, [STATE]: "ELIGIBLE" },
      {
        $set: {
          [STATE]: "FIRST_PENDING",
          "financialRelationship.stateChangedAt": now,
          "financialRelationship.pending": {
            ...identity,
            claimedAt: now,
            claimLeaseExpiresAt: new Date(now.getTime() + FIRST_CLAIM_PRE_DISPATCH_LEASE_MS),
          },
        },
        $inc: { [REVISION]: 1 },
      },
      { returnDocument: "after", runValidators: true },
    ).exec()) as RelationshipRow | null;
  }

  /**
   * Binds the owning operation's PaymentAttempt BEFORE any provider dispatch. Fails (false) if
   * the claim is no longer this operation's FIRST_PENDING claim — the caller must then abort
   * without calling the provider. Idempotent for the same attempt.
   */
  public async bindPaymentAttempt(
    clientId: Types.ObjectId,
    idempotencyKey: string,
    paymentAttemptId: Types.ObjectId | string,
  ): Promise<boolean> {
    const attemptId = new Types.ObjectId(paymentAttemptId);
    const result = await BusinessClientModel.updateOne(
      {
        _id: clientId,
        [STATE]: "FIRST_PENDING",
        [PENDING_KEY]: idempotencyKey,
        $or: [{ [PENDING_ATTEMPT]: { $exists: false } }, { [PENDING_ATTEMPT]: attemptId }],
      },
      { $set: { [PENDING_ATTEMPT]: attemptId } },
    ).exec();
    return result.matchedCount === 1;
  }

  /**
   * FIRST_PENDING -> CONSUMED, inside the booking-persistence transaction. Conditioned on the
   * same logical operation AND the same bound PaymentAttempt (or no attempt at all for a
   * zero-upfront FIRST). A false return means ownership was lost: the caller must abort the
   * transaction so no Booking commits without consuming.
   */
  public async consumeFirst(
    clientId: Types.ObjectId,
    input: {
      idempotencyKey: string;
      bookingId: Types.ObjectId;
      productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
      paymentAttemptId?: Types.ObjectId | string | undefined;
      financialTransactionId?: Types.ObjectId | undefined;
    },
    session?: ClientSession,
  ): Promise<boolean> {
    const now = new Date();
    const result = await BusinessClientModel.updateOne(
      {
        _id: clientId,
        [STATE]: "FIRST_PENDING",
        [PENDING_KEY]: input.idempotencyKey,
        "financialRelationship.pending.bookingId": input.bookingId,
        [PENDING_ATTEMPT]: input.paymentAttemptId
          ? new Types.ObjectId(input.paymentAttemptId)
          : { $exists: false },
      },
      {
        $set: {
          [STATE]: "CONSUMED",
          "financialRelationship.stateChangedAt": now,
          "financialRelationship.consumed": {
            idempotencyKey: input.idempotencyKey,
            bookingId: input.bookingId,
            productKind: input.productKind,
            ...(input.financialTransactionId
              ? { financialTransactionId: input.financialTransactionId }
              : {}),
            consumedAt: now,
          },
        },
        $unset: { "financialRelationship.pending": 1 },
        $inc: { [REVISION]: 1 },
      },
      session ? { session } : {},
    ).exec();
    if (result.modifiedCount !== 1) return false;

    // Legacy compatibility marker only (analytics/"new customers" reads). Never cleared on a
    // later restoration and never read for financial classification once v2 state exists.
    await BusinessClientModel.updateOne(
      { _id: clientId, activatedAt: { $exists: false } },
      { $set: { activatedAt: now, activatedByBookingId: input.bookingId } },
      session ? { session } : {},
    ).exec();
    return true;
  }

  /**
   * FIRST_PENDING -> ELIGIBLE for a proven pre-money failure of the SAME operation:
   *  - `unbound`: no PaymentAttempt was ever bound, so no provider dispatch happened (the owner
   *    must bind before dispatching). Optionally also requires the pre-dispatch lease to have
   *    expired (recovery path for an abandoned/crashed owner).
   *  - `failedAttempt`: the bound PaymentAttempt is terminally FAILED (verified by the caller).
   */
  public async releaseFirstClaim(
    clientId: Types.ObjectId,
    input: {
      idempotencyKey: string;
      reason: "PRE_MONEY_FAILURE" | "PRE_DISPATCH_ABANDONED";
      expectedRevision?: number | undefined;
      requireLeaseExpiredBefore?: Date | undefined;
    } & (
      | { unbound: true; paymentAttemptId?: undefined }
      | { unbound?: false; paymentAttemptId: Types.ObjectId | string }
    ),
  ): Promise<boolean> {
    const now = new Date();
    const result = await BusinessClientModel.updateOne(
      {
        _id: clientId,
        [STATE]: "FIRST_PENDING",
        [PENDING_KEY]: input.idempotencyKey,
        [PENDING_ATTEMPT]: input.unbound
          ? { $exists: false }
          : new Types.ObjectId(input.paymentAttemptId),
        ...(input.expectedRevision !== undefined ? { [REVISION]: input.expectedRevision } : {}),
        ...(input.requireLeaseExpiredBefore
          ? {
              "financialRelationship.pending.claimLeaseExpiresAt": {
                $lte: input.requireLeaseExpiredBefore,
              },
            }
          : {}),
      },
      {
        $set: {
          [STATE]: "ELIGIBLE",
          "financialRelationship.stateChangedAt": now,
          "financialRelationship.lastRelease": {
            idempotencyKey: input.idempotencyKey,
            reason: input.reason,
            ...(input.paymentAttemptId
              ? { paymentAttemptId: new Types.ObjectId(input.paymentAttemptId) }
              : {}),
            releasedAt: now,
          },
        },
        $unset: { "financialRelationship.pending": 1 },
        $inc: { [REVISION]: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  /** FIRST_PENDING -> RESTORATION_PENDING: the provider charge succeeded but Bookly's booking
   * persistence failed and P0 compensation is required. The claim stays unavailable until the
   * exact full compensation refund is confirmed. */
  public async markRestorationPending(
    clientId: Types.ObjectId,
    input: {
      idempotencyKey: string;
      paymentAttemptId: Types.ObjectId | string;
      expectedRevision: number;
      refundOperationId?: Types.ObjectId | undefined;
    },
  ): Promise<boolean> {
    const now = new Date();
    const result = await BusinessClientModel.updateOne(
      {
        _id: clientId,
        [STATE]: "FIRST_PENDING",
        [PENDING_KEY]: input.idempotencyKey,
        [PENDING_ATTEMPT]: new Types.ObjectId(input.paymentAttemptId),
        [REVISION]: input.expectedRevision,
      },
      {
        $set: {
          [STATE]: "RESTORATION_PENDING",
          "financialRelationship.stateChangedAt": now,
          "financialRelationship.pending.restorationRequiredAt": now,
          ...(input.refundOperationId
            ? {
                "financialRelationship.pending.restorationRefundOperationId":
                  input.refundOperationId,
              }
            : {}),
        },
        $inc: { [REVISION]: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  /** RESTORATION_PENDING -> ELIGIBLE, only after the caller verified the exact full
   * compensation refund for THIS operation's PaymentAttempt. */
  public async restoreAfterCompensation(
    clientId: Types.ObjectId,
    input: {
      idempotencyKey: string;
      paymentAttemptId: Types.ObjectId | string;
      refundOperationId: Types.ObjectId;
      expectedRevision: number;
    },
  ): Promise<boolean> {
    const now = new Date();
    const result = await BusinessClientModel.updateOne(
      {
        _id: clientId,
        [STATE]: "RESTORATION_PENDING",
        [PENDING_KEY]: input.idempotencyKey,
        [PENDING_ATTEMPT]: new Types.ObjectId(input.paymentAttemptId),
        [REVISION]: input.expectedRevision,
      },
      {
        $set: {
          [STATE]: "ELIGIBLE",
          "financialRelationship.stateChangedAt": now,
          "financialRelationship.lastRelease": {
            idempotencyKey: input.idempotencyKey,
            reason: "COMPENSATION_REFUNDED",
            paymentAttemptId: new Types.ObjectId(input.paymentAttemptId),
            refundOperationId: input.refundOperationId,
            releasedAt: now,
          },
        },
        $unset: { "financialRelationship.pending": 1 },
        $inc: { [REVISION]: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  /** Recovery scan: rows with an unresolved first claim, least-recently reconciled first
   * (never-reconciled rows sort first), so a claim that legitimately cannot resolve yet — e.g.
   * an abandoned requires_action PaymentIntent — rotates behind newer ones instead of starving
   * them. */
  public async listPending(limit: number): Promise<RelationshipRow[]> {
    return (await BusinessClientModel.find({ [PENDING_KEY]: { $exists: true } })
      .sort({ "financialRelationship.pending.lastReconciledAt": 1 })
      .limit(limit)
      .exec()) as RelationshipRow[];
  }

  /** Advances the recovery cursor for this exact pending operation. Not a state transition:
   * never touches `state`/`revision`, and is a no-op once the claim resolved or changed hands. */
  public async touchReconciled(clientId: Types.ObjectId, idempotencyKey: string): Promise<void> {
    await BusinessClientModel.updateOne(
      { _id: clientId, [PENDING_KEY]: idempotencyKey },
      { $set: { "financialRelationship.pending.lastReconciledAt": new Date() } },
    ).exec();
  }
}
