import type { ClientSession, Types } from "mongoose";

import { logger } from "../../config/logger.js";
import { BookingError } from "../booking/booking.errors.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingCreationClaimRepository } from "../booking/booking-creation-claim.repository.js";
import type {
  FinancialContract,
  RelationshipClassification,
} from "../booking/financial-contract.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";
import type { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import type { RefundOperationDocument } from "../payment/refund-operation.model.js";
import type { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import type { BusinessClientDocument } from "./client.model.js";
import type { ClientRepository } from "./client.repository.js";
import type {
  FinancialRelationshipRepository,
  FirstClaimIdentity,
} from "./financial-relationship.repository.js";

const CLAIM_RACE_RETRIES = 4;

/** P0 compensation refunds for a failed booking persistence always use this logical key (see
 * BookingCreationService.compensateFailedBookingAfterPayment and MoneyRecoveryService). */
export const compensationRefundKey = (paymentIntentId: string): string =>
  `refund:${paymentIntentId}:compensation`;

/**
 * P1 — the single place first/returning is decided and the relationship's lifecycle is driven.
 *
 *  - `resolveForFinalize` atomically claims FIRST (ELIGIBLE -> FIRST_PENDING) BEFORE any money
 *    movement; a competing operation gets BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS (never a silent
 *    RETURNING) and the same logical operation resumes its own claim.
 *  - Every other transition is derived from durable P0 state (PaymentAttempt, RefundOperation,
 *    Booking) via `reconcile`, which is idempotent and is invoked from finalize failure paths,
 *    the Stripe webhook, and the money-recovery worker. Nothing is ever released merely because
 *    it is old: the only time-bounded rule is the pre-dispatch lease on a claim that never bound
 *    a PaymentAttempt — provably no money moved, and the owner cannot dispatch without binding.
 */
export class FinancialRelationshipService {
  public constructor(
    private readonly relationshipRepository: FinancialRelationshipRepository,
    private readonly paymentAttemptRepository: PaymentAttemptRepository,
    private readonly refundOperationRepository: RefundOperationRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly claimRepository: BookingCreationClaimRepository,
    private readonly clientRepository: ClientRepository,
  ) {}

  public async beginBusinessCancellation(
    booking: BookingDocument,
    source: BookingFinancialTransactionDocument | undefined,
    refund: RefundOperationDocument | undefined,
    session: ClientSession,
    packageId?: Types.ObjectId,
  ): Promise<void> {
    const contract = booking.financialContract;
    if (!contract || contract.classification !== "FIRST") return;
    const row = await this.relationshipRepository.findByClientId(
      booking.customer.businessClientId,
      session,
    );
    const relationship = row?.financialRelationship;
    const consumed = relationship?.consumed;
    // Identity-incomplete legacy relationships are not guessed or restored.
    if (!row || !relationship || !consumed) return;
    if (relationship.state !== "CONSUMED")
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    if (
      !row.businessId.equals(contract.businessId) ||
      !row.linkedUserId?.equals(contract.customerUserId) ||
      !this.matchesConsumed(booking, row._id, consumed)
    )
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    if (contract.productKind === "PACKAGE_PURCHASE") {
      if (!packageId) return;
      const progress = await new PackageProgressRepository().findByIdInternal(packageId, session);
      if (
        !progress?.voidedAt ||
        !progress.originBookingId.equals(booking._id) ||
        !progress.businessClientId.equals(row._id)
      )
        throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    } else if (booking.status !== "CANCELLED_BY_BUSINESS")
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    if (contract.onlineChargeCents === 0) {
      const contradictoryAttempt = await this.paymentAttemptRepository.findByLogicalKey(
        contract.idempotencyKey,
      );
      if (source || refund || contradictoryAttempt)
        throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    } else if (
      !source ||
      !refund ||
      (consumed.financialTransactionId && !consumed.financialTransactionId.equals(source._id)) ||
      !this.matchesRefundSource(booking, source, refund)
    ) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    if (source && !(await this.matchesSucceededAttempt(booking, source)))
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    const changed = await this.relationshipRepository.beginBusinessRestoration(
      row._id,
      {
        idempotencyKey: contract.idempotencyKey,
        bookingId: booking._id,
        customerUserId: contract.customerUserId,
        productKind: contract.productKind,
        expectedRevision: relationship.revision,
        ...(refund ? { refundOperationId: refund._id } : {}),
      },
      session,
    );
    if (!changed) throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
  }

  private matchesConsumed(
    booking: BookingDocument,
    clientId: Types.ObjectId,
    consumed: NonNullable<BusinessClientDocument["financialRelationship"]>["consumed"],
  ): boolean {
    const c = booking.financialContract;
    return Boolean(
      c &&
        consumed &&
        c.classification === "FIRST" &&
        c.bookingId.equals(booking._id) &&
        c.businessId.equals(booking.businessId) &&
        c.businessClientId.equals(clientId) &&
        c.customerUserId.equals(booking.customer.customerUserId ?? "") &&
        consumed.bookingId.equals(booking._id) &&
        consumed.idempotencyKey === c.idempotencyKey &&
        consumed.productKind === c.productKind,
    );
  }

  private matchesRefundSource(
    booking: BookingDocument,
    source: BookingFinancialTransactionDocument,
    refund: RefundOperationDocument,
  ): boolean {
    const c = booking.financialContract;
    return Boolean(
      c &&
        source.type === "PLATFORM_FEE" &&
        source.status === "SUCCEEDED" &&
        source.bookingId?.equals(booking._id) &&
        source.businessId.equals(booking.businessId) &&
        source.businessClientId?.equals(c.businessClientId) &&
        source.customerUserId?.equals(c.customerUserId) &&
        source.amountCents === c.onlineChargeCents &&
        source.currency === c.currency &&
        source.idempotencyKey === `${c.idempotencyKey}:deposit` &&
        source.providerReference &&
        refund.sourcePaymentIntentId === source.providerReference &&
        refund.sourceFinancialTransactionId?.equals(source._id) &&
        refund.bookingId?.equals(booking._id) &&
        refund.businessId?.equals(c.businessId) &&
        refund.businessClientId?.equals(c.businessClientId) &&
        refund.customerUserId?.equals(c.customerUserId) &&
        refund.currency === c.currency &&
        refund.expectedRefundAmountCents === c.onlineChargeCents &&
        ["BUSINESS_CANCELLATION", "BUSINESS_PACKAGE_TERMINATION"].includes(refund.reason),
    );
  }

  private async matchesSucceededAttempt(
    booking: BookingDocument,
    source: BookingFinancialTransactionDocument,
  ): Promise<boolean> {
    const contract = booking.financialContract;
    if (!contract) return false;
    const attempt = await this.paymentAttemptRepository.findByLogicalKey(contract.idempotencyKey);
    return Boolean(
      attempt &&
        attempt.providerStatus === "SUCCEEDED" &&
        attempt.providerPaymentIntentId === source.providerReference &&
        attempt.expectedAmountCents === contract.onlineChargeCents &&
        attempt.currency === contract.currency &&
        attempt.relationshipClassification === "FIRST" &&
        attempt.productKind === contract.productKind &&
        attempt.bookingId?.equals(booking._id) &&
        attempt.businessId?.equals(contract.businessId) &&
        attempt.businessClientId?.equals(contract.businessClientId) &&
        attempt.customerUserId.equals(contract.customerUserId) &&
        attempt.succeededTransactionId?.equals(source._id),
    );
  }

  private async reconcileBusinessCancellation(
    booking: BookingDocument,
    row: BusinessClientDocument,
  ): Promise<void> {
    const relationship = row.financialRelationship;
    const pending = relationship?.pending;
    if (
      !pending?.restorationRefundOperationId ||
      !relationship ||
      !this.matchesConsumed(booking, row._id, relationship.consumed)
    )
      return;
    const contract = booking.financialContract;
    if (
      !contract ||
      !row.businessId.equals(contract.businessId) ||
      !row.linkedUserId?.equals(contract.customerUserId) ||
      pending.productKind !== contract.productKind ||
      pending.idempotencyKey !== contract.idempotencyKey
    )
      return;
    if (contract.productKind === "PACKAGE_PURCHASE") {
      const packageId = booking.serviceLines.find((line) => line.pricingInput.packageProgressId)
        ?.pricingInput.packageProgressId;
      const progress = packageId
        ? await new PackageProgressRepository().findByIdInternal(packageId)
        : null;
      if (
        !progress?.voidedAt ||
        !progress.originBookingId.equals(booking._id) ||
        !progress.businessClientId.equals(row._id)
      )
        return;
    } else if (booking.status !== "CANCELLED_BY_BUSINESS") return;
    const refund = await this.refundOperationRepository.findById(
      pending.restorationRefundOperationId,
    );
    if (!refund || refund.providerStatus !== "SUCCEEDED" || !refund.succeededLedgerTransactionId)
      return;
    const transactions = new BookingFinancialTransactionRepository();
    const source = refund.sourceFinancialTransactionId
      ? await transactions.findById(refund.sourceFinancialTransactionId)
      : null;
    const ledger = await transactions.findById(refund.succeededLedgerTransactionId);
    if (
      !source ||
      !this.matchesRefundSource(booking, source, refund) ||
      !(await this.matchesSucceededAttempt(booking, source)) ||
      (relationship.consumed?.financialTransactionId &&
        !relationship.consumed.financialTransactionId.equals(source._id)) ||
      !ledger ||
      ledger.status !== "SUCCEEDED" ||
      ledger.type !== "REFUND" ||
      ledger.direction !== "CREDIT" ||
      ledger.amountCents !== refund.expectedRefundAmountCents ||
      ledger.currency !== refund.currency ||
      ledger.providerReference !== refund.providerRefundId ||
      !ledger.bookingId?.equals(booking._id) ||
      !ledger.businessId.equals(contract.businessId) ||
      !ledger.businessClientId?.equals(contract.businessClientId) ||
      !ledger.customerUserId?.equals(contract.customerUserId) ||
      ledger.metadata?.["sourceType"] !== source.type ||
      ledger.metadata?.["sourceTransactionId"] !== String(source._id)
    )
      return;
    await this.relationshipRepository.finishBusinessRestoration(row._id, {
      idempotencyKey: pending.idempotencyKey,
      bookingId: booking._id,
      refundOperationId: refund._id,
      expectedRevision: relationship.revision,
    });
  }

  /**
   * Read-only ESTIMATE for previews. Never authoritative (finalize claims atomically) and never
   * writes. A pending first operation is still "FIRST" here — the customer is not returning
   * until that operation actually becomes CONSUMED.
   */
  public peekClassification(client: BusinessClientDocument | null): RelationshipClassification {
    if (!client) return "FIRST";
    const relationship = client.financialRelationship;
    if (relationship) return relationship.state === "CONSUMED" ? "RETURNING" : "FIRST";
    return client.activatedAt ? "RETURNING" : "FIRST";
  }

  /**
   * The authoritative classification for one logical operation (the BookingCreationClaim
   * identity). `existingContract` — the contract already recorded for this same operation, if
   * any — is honoured as immutable: a recorded FIRST can never resume as RETURNING (or vice
   * versa); it fails closed instead.
   */
  public async resolveForFinalize(input: {
    client: BusinessClientDocument;
    identity: FirstClaimIdentity;
    existingContract?: FinancialContract | undefined;
  }): Promise<RelationshipClassification> {
    const { client, identity, existingContract } = input;
    if (existingContract && existingContract.productKind !== identity.productKind) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }

    let row = await this.relationshipRepository.ensureInitialized(client._id);
    for (let attempt = 0; attempt < CLAIM_RACE_RETRIES; attempt += 1) {
      const relationship = row.financialRelationship;
      const pending = relationship.pending;

      if (pending && pending.idempotencyKey === identity.idempotencyKey) {
        if (
          !pending.bookingId.equals(identity.bookingId) ||
          !pending.customerUserId.equals(identity.customerUserId) ||
          pending.productKind !== identity.productKind ||
          existingContract?.classification === "RETURNING"
        ) {
          throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
        }
        // This operation's own provider charge succeeded but its booking failed and is being
        // refunded — it can never complete; nothing new may be charged for it.
        if (relationship.state === "RESTORATION_PENDING") {
          throw new BookingError("BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS", 409);
        }
        return "FIRST";
      }

      if (relationship.state === "FIRST_PENDING" || relationship.state === "RESTORATION_PENDING") {
        throw new BookingError("BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS", 409);
      }

      if (relationship.state === "CONSUMED") {
        if (existingContract?.classification === "FIRST") {
          throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
        }
        return "RETURNING";
      }

      // ELIGIBLE
      if (existingContract?.classification === "RETURNING") {
        throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
      }
      const claimed = await this.relationshipRepository.claimFirst(client._id, identity);
      if (claimed) return "FIRST";

      const reread = await this.relationshipRepository.findByClientId(client._id);
      if (!reread) throw new Error("BusinessClient financial relationship disappeared");
      row = reread;
    }
    throw new BookingError("BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS", 409);
  }

  /** Called by PaymentService right after the durable PaymentAttempt exists and BEFORE any
   * provider dispatch. Throwing here guarantees no PaymentIntent is created for an operation
   * that no longer owns the first claim. */
  public async bindPaymentAttempt(
    clientId: Types.ObjectId,
    idempotencyKey: string,
    paymentAttemptId: Types.ObjectId | string,
  ): Promise<void> {
    const bound = await this.relationshipRepository.bindPaymentAttempt(
      clientId,
      idempotencyKey,
      paymentAttemptId,
    );
    if (!bound) throw new BookingError("BOOKING_FIRST_RELATIONSHIP_IN_PROGRESS", 409);
  }

  /** FIRST_PENDING -> CONSUMED inside the caller's booking-persistence transaction. */
  public async consumeFirst(
    clientId: Types.ObjectId,
    input: {
      idempotencyKey: string;
      bookingId: Types.ObjectId;
      productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
      paymentAttemptId?: string | undefined;
      financialTransactionId?: Types.ObjectId | undefined;
    },
    session: ClientSession,
  ): Promise<boolean> {
    return this.relationshipRepository.consumeFirst(clientId, input, session);
  }

  /**
   * The owner's own definitive pre-money failure (validation, tax, saved-card, declined, …).
   * Releases immediately when no PaymentAttempt was ever bound (no dispatch can have happened);
   * otherwise defers to durable PaymentAttempt state — a FAILED attempt releases, an ambiguous /
   * requires_action / succeeded attempt keeps the claim protected.
   */
  public async releaseAfterPreMoneyFailure(
    clientId: Types.ObjectId,
    idempotencyKey: string,
  ): Promise<void> {
    const released = await this.relationshipRepository.releaseFirstClaim(clientId, {
      idempotencyKey,
      reason: "PRE_MONEY_FAILURE",
      unbound: true,
    });
    if (!released) await this.reconcile(clientId);
  }

  /** Best-effort wrapper for request paths: the recovery worker is the guaranteed convergence
   * path, so a reconciliation hiccup must never mask the caller's original error. */
  public async reconcileQuietly(clientId: Types.ObjectId): Promise<void> {
    try {
      await this.reconcile(clientId);
    } catch (error) {
      logger.warn(
        { err: error, recordType: "BusinessClient", recordId: String(clientId) },
        "Financial relationship reconciliation deferred to recovery",
      );
    }
  }

  /** Webhook / refund hook: converge the relationship whose pending first claim is bound to
   * (or keyed by) this PaymentAttempt. A stale attempt never touches a newer operation's claim. */
  public async reconcileForPaymentAttempt(
    paymentAttemptId: Types.ObjectId | string,
  ): Promise<void> {
    const attempt = await this.paymentAttemptRepository.findById(paymentAttemptId);
    if (!attempt?.businessId) return;
    const client = await this.clientRepository.findByBusinessIdAndLinkedUserId(
      attempt.businessId,
      attempt.customerUserId,
    );
    const pending = client?.financialRelationship?.pending;
    if (!client || !pending || pending.idempotencyKey !== attempt.logicalIdempotencyKey) return;
    await this.reconcile(client._id);
  }

  /** P1.1 — true only while this exact attempt still owns its relationship's FIRST_PENDING
   * claim: same BusinessClient, same logical operation, and bound to this very attempt. The
   * stale requires_action recovery pass touches nothing for any other attempt. */
  public async ownsPendingFirstClaim(attempt: PaymentAttemptDocument): Promise<boolean> {
    if (!attempt.businessId || attempt.relationshipClassification !== "FIRST") return false;
    const client = await this.clientRepository.findByBusinessIdAndLinkedUserId(
      attempt.businessId,
      attempt.customerUserId,
    );
    const relationship = client?.financialRelationship;
    const pending = relationship?.pending;
    return Boolean(
      client &&
        relationship?.state === "FIRST_PENDING" &&
        pending?.idempotencyKey === attempt.logicalIdempotencyKey &&
        pending.paymentAttemptId?.equals(attempt._id) &&
        (!attempt.businessClientId || attempt.businessClientId.equals(client._id)),
    );
  }

  /** Recovery-worker pass over every unresolved first claim. */
  public async reconcilePending(limit = 50): Promise<{ scanned: number; errors: number }> {
    const rows = await this.relationshipRepository.listPending(limit);
    let errors = 0;
    for (const row of rows) {
      const pendingKey = row.financialRelationship.pending?.idempotencyKey;
      try {
        await this.reconcile(row._id);
        if (pendingKey) await this.relationshipRepository.touchReconciled(row._id, pendingKey);
      } catch (error) {
        if (pendingKey) {
          await this.relationshipRepository
            .touchReconciled(row._id, pendingKey)
            .catch(() => undefined);
        }
        errors += 1;
        logger.warn(
          { err: error, recordType: "BusinessClient", recordId: String(row._id) },
          "Financial relationship recovery item failed",
        );
      }
    }
    return { scanned: rows.length, errors };
  }

  /**
   * Derives the next relationship state purely from durable state. Idempotent; every write is a
   * CAS on state + pending identity + revision, so concurrent/stale callers are harmless.
   *
   *   pending booking committed (FIRST contract, same op)  -> CONSUMED
   *   FIRST_PENDING, no attempt bound, lease expired      -> ELIGIBLE (never dispatched)
   *   FIRST_PENDING, bound attempt FAILED                 -> ELIGIBLE
   *   FIRST_PENDING, bound attempt CANCELED (provider)    -> ELIGIBLE
   *   FIRST_PENDING, bound attempt SUCCEEDED + compensation required -> RESTORATION_PENDING
   *   RESTORATION_PENDING, exact full compensation refund SUCCEEDED -> ELIGIBLE
   *   anything else (requires_action, processing, unknown, refund pending/failed/partial/
   *   mismatched)                                          -> unchanged
   *
   * FAILED (requires_payment_method) releases even though Stripe could still re-confirm it: the
   * customer's retry runs under a NEW logical key and would otherwise be blocked indefinitely.
   * That is safe because a late success no longer seals out (PaymentAttempt FAILED ->
   * SUCCEEDED): the same operation can re-claim and consume, or P0 compensation refunds it —
   * it can never consume FIRST a second time.
   */
  public async reconcile(clientId: Types.ObjectId): Promise<void> {
    let row = await this.relationshipRepository.findByClientId(clientId);
    let relationship = row?.financialRelationship;
    let pending = relationship?.pending;
    if (!row || !relationship || !pending) return;

    const booking = await this.bookingRepository.findByIdOnly(pending.bookingId);
    if (booking) {
      if (relationship.state === "RESTORATION_PENDING" && pending.restorationRefundOperationId) {
        await this.reconcileBusinessCancellation(booking, row);
        return;
      }
      // Atomic consumption makes this unreachable for a v2 operation; converge only when the
      // committed Booking provably belongs to this exact FIRST operation, never by guessing.
      const contract = booking.financialContract;
      if (
        relationship.state === "FIRST_PENDING" &&
        contract?.classification === "FIRST" &&
        contract.idempotencyKey === pending.idempotencyKey &&
        String(booking.customer.businessClientId) === String(clientId)
      ) {
        await this.relationshipRepository.consumeFirst(clientId, {
          idempotencyKey: pending.idempotencyKey,
          bookingId: booking._id,
          productKind: pending.productKind,
          paymentAttemptId: pending.paymentAttemptId,
        });
      }
      return;
    }

    if (relationship.state === "FIRST_PENDING") {
      if (!pending.paymentAttemptId) {
        const keyedAttempt = await this.paymentAttemptRepository.findByLogicalKey(
          pending.idempotencyKey,
        );
        // Defensive: an attempt for this key that progressed WITHOUT being bound is never
        // released on a guess (the binding hook should make this impossible).
        if (keyedAttempt && keyedAttempt.providerStatus !== "NOT_CREATED") return;
        await this.relationshipRepository.releaseFirstClaim(clientId, {
          idempotencyKey: pending.idempotencyKey,
          reason: "PRE_DISPATCH_ABANDONED",
          unbound: true,
          expectedRevision: relationship.revision,
          requireLeaseExpiredBefore: new Date(),
        });
        return;
      }

      const attempt = await this.paymentAttemptRepository.findById(pending.paymentAttemptId);
      if (!attempt || attempt.logicalIdempotencyKey !== pending.idempotencyKey) return;

      if (attempt.providerStatus === "FAILED" || attempt.providerStatus === "CANCELED") {
        await this.relationshipRepository.releaseFirstClaim(clientId, {
          idempotencyKey: pending.idempotencyKey,
          reason: attempt.providerStatus === "CANCELED" ? "PROVIDER_CANCELED" : "PRE_MONEY_FAILURE",
          paymentAttemptId: attempt._id,
          expectedRevision: relationship.revision,
        });
        return;
      }

      if (attempt.providerStatus !== "SUCCEEDED" || attempt.compensationStatus === "NOT_REQUIRED") {
        return;
      }

      const refund = attempt.providerPaymentIntentId
        ? await this.refundOperationRepository.findByLogicalKey(
            compensationRefundKey(attempt.providerPaymentIntentId),
          )
        : null;
      const marked = await this.relationshipRepository.markRestorationPending(clientId, {
        idempotencyKey: pending.idempotencyKey,
        paymentAttemptId: attempt._id,
        expectedRevision: relationship.revision,
        ...(refund ? { refundOperationId: refund._id } : {}),
      });
      if (!marked) return;

      row = await this.relationshipRepository.findByClientId(clientId);
      relationship = row?.financialRelationship;
      pending = relationship?.pending;
      if (!row || !relationship || !pending) return;
    }

    if (relationship.state !== "RESTORATION_PENDING" || !pending.paymentAttemptId) return;

    const attempt = await this.paymentAttemptRepository.findById(pending.paymentAttemptId);
    if (!attempt) return;
    const refundOperationId = await this.findExactCompensationRefund(
      attempt,
      pending.idempotencyKey,
    );
    if (!refundOperationId) return;

    await this.relationshipRepository.restoreAfterCompensation(clientId, {
      idempotencyKey: pending.idempotencyKey,
      paymentAttemptId: attempt._id,
      refundOperationId,
      expectedRevision: relationship.revision,
    });
  }

  /**
   * Returns the RefundOperation id only when it is the exact, full, durably-confirmed
   * compensation refund of THIS operation's first charge: same PaymentAttempt, same
   * PaymentIntent, same currency, refund amount == the whole charged amount == the contract's
   * online charge, provider SUCCEEDED, and P0 compensation marked REFUNDED. Pending, failed,
   * partial, ambiguous or mismatched refunds never restore eligibility.
   */
  private async findExactCompensationRefund(
    attempt: PaymentAttemptDocument,
    idempotencyKey: string,
  ): Promise<Types.ObjectId | undefined> {
    if (
      attempt.logicalIdempotencyKey !== idempotencyKey ||
      attempt.providerStatus !== "SUCCEEDED" ||
      attempt.compensationStatus !== "REFUNDED" ||
      !attempt.providerPaymentIntentId
    ) {
      return undefined;
    }

    const refund = await this.refundOperationRepository.findByLogicalKey(
      compensationRefundKey(attempt.providerPaymentIntentId),
    );
    if (
      refund?.providerStatus !== "SUCCEEDED" ||
      refund.reason !== "BOOKING_PERSISTENCE_COMPENSATION" ||
      String(refund.sourcePaymentAttemptId ?? "") !== String(attempt._id) ||
      refund.sourcePaymentIntentId !== attempt.providerPaymentIntentId ||
      refund.expectedRefundAmountCents !== attempt.expectedAmountCents ||
      refund.currency !== attempt.currency
    ) {
      return undefined;
    }

    const claim = await this.claimRepository.findByIdempotencyKey(idempotencyKey);
    const contract = claim?.financialContract;
    if (
      contract?.classification !== "FIRST" ||
      contract.onlineChargeCents !== attempt.expectedAmountCents ||
      contract.currency !== attempt.currency
    ) {
      return undefined;
    }
    return refund._id;
  }
}
