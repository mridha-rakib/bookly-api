import mongoose, { type ClientSession, type Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { NoShowNotificationPort } from "../notification/no-show.notifier.js";
import type { PenaltySettlementNotificationPort } from "../notification/penalty-settlement.notifier.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import {
  isPackageLinkedBooking,
  packageSessionOutcomeForBookingStatus,
} from "../package-progress/package-progress.rules.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";
import { buildPaymentIntentMetadata } from "../payment/payment-intent-metadata.js";
import {
  isDefinitivePenaltyFailure,
  isPenaltyPurpose,
  type PenaltyPurpose,
  parsePenaltyAttemptKey,
  penaltyAttemptKey,
} from "../payment/penalty-attempt.js";
import type { BookingDocument } from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";

/**
 * P5 — durable customer penalty collection (late-cancellation / no-show shortfall).
 *
 * One obligation = one BookingFinancialTransaction row (type CANCELLATION_FEE / NO_SHOW_FEE) at
 * its canonical key, written inside the authoritative lifecycle transaction BEFORE any provider
 * call. That single row is the charge claim, the waiver gate and the accounting record. Its ONE
 * PaymentAttempt (logical key `penalty:<obligationId>`, a server-only namespace) commits in the
 * same transaction and is dispatched once, after commit, off-session. Request, worker, webhook
 * and recovery all settle the obligation through `convergeAttempt` — the same idempotent,
 * monotonic, transactional logic — so a provider success can never be lost locally, an unknown
 * outcome is reconciled against the same provider object instead of being retried, and the
 * obligation, booking settlement and follow-up notification change exactly once, together.
 *
 * Never touches the FIRST relationship, promo entitlement or package lifecycle, and never
 * refunds: a penalty attempt carries no contract/classification, and no branch here calls the
 * relationship, promo or refund services.
 */
export const PENALTY_OBLIGATION_MARKER = "DURABLE_V1";

export const cancellationObligationKey = (bookingId: Types.ObjectId | string): string =>
  `cancellation-fee:${String(bookingId)}`;
export const noShowObligationKey = (bookingId: Types.ObjectId | string): string =>
  `no-show:${String(bookingId)}`;
/** Pre-P5 cancellation charge rows were keyed `…:ledger`, written AFTER the provider call. Read
 * only — P5 never writes this key and never settles or charges such a row. */
export const legacyCancellationLedgerKey = (bookingId: Types.ObjectId | string): string =>
  `cancellation-fee:${String(bookingId)}:ledger`;

export const obligationKeyFor = (
  type: PenaltyPurpose,
  bookingId: Types.ObjectId | string,
): string =>
  type === "CANCELLATION_FEE"
    ? cancellationObligationKey(bookingId)
    : noShowObligationKey(bookingId);

/**
 * Automatic off-session penalty collection applies only to a BOOKLY_MANAGED, non-Package booking
 * with a linked customer: a Package's lost session IS its penalty, and a MANUAL booking is
 * financially outside Bookly (rule E) — its linked customer's saved card is never used.
 */
export const isPenaltyCollectible = (booking: BookingDocument): boolean =>
  !isPackageLinkedBooking(booking) &&
  booking.source !== "MANUAL" &&
  Boolean(booking.customer.customerUserId);

export type NoShowPenalty = {
  noShowPercentage: number | undefined;
  grossFeeCents: number;
  upfrontAppliedCents: number;
  amountCents: number;
};

/** The unchanged no-show formula — gross = round(basis × snapshot % / 100), netted against the
 * succeeded upfront payment; Package bookings carry no base-service percentage. */
export const computeNoShowPenalty = (
  booking: BookingDocument,
  upfrontPaidCents: number,
): NoShowPenalty => {
  const noShowPercentage = isPackageLinkedBooking(booking)
    ? undefined
    : booking.cancellationPolicySnapshot?.noShowPercentage;
  const grossFeeCents = noShowPercentage
    ? Math.round((booking.financials.eligiblePlatformFeeBasisCents * noShowPercentage) / 100)
    : 0;
  return {
    noShowPercentage,
    grossFeeCents,
    upfrontAppliedCents: Math.min(grossFeeCents, upfrontPaidCents),
    amountCents: Math.max(0, grossFeeCents - upfrontPaidCents),
  };
};

export type PenaltyCollectionOutcome = "SUCCEEDED" | "FAILED" | "WAIVED" | "UNRESOLVED";

/**
 * The waiver/reversal gate, derived from the obligation and its attempt:
 *  NONE                    — no obligation exists (nothing was ever claimed).
 *  IN_PROGRESS             — provider outcome not definitive yet (pending, in flight, UNKNOWN).
 *  SUCCEEDED               — collected (or provider success awaiting convergence).
 *  WAIVED                  — already waived.
 *  DEFINITIVE_FAILURE      — proven failed / canceled / provider-not-created / no usable card,
 *                            or a pre-P5 FAILED no-show row (its existing manual path).
 *  RECONCILIATION_REQUIRED — a pre-P5 record whose provider outcome cannot be proven.
 */
export type PenaltyGate =
  | { state: "NONE" }
  | {
      state:
        | "IN_PROGRESS"
        | "SUCCEEDED"
        | "WAIVED"
        | "DEFINITIVE_FAILURE"
        | "RECONCILIATION_REQUIRED";
      obligation: BookingFinancialTransactionDocument;
    };

/** Corrupt attempt↔obligation correlation, or a provider result that contradicts a definitive
 * local outcome. Never settled, never retried blindly — retained for investigation. */
export class PenaltyCorrelationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PenaltyCorrelationError";
  }
}

export type PreparedPenalty = {
  obligation: BookingFinancialTransactionDocument;
  /** Absent only when no usable saved card existed: the obligation was created definitively
   * FAILED and nothing can ever be dispatched for it. */
  attempt?: PaymentAttemptDocument | undefined;
};

export type PenaltyCollectionDeps = {
  paymentService: Pick<
    PaymentService,
    | "resolvePenaltyPaymentSource"
    | "preparePenaltyAttempt"
    | "dispatchPenaltyAttempt"
    | "findPaymentAttemptById"
    | "findPaymentAttemptByLogicalKey"
    | "claimPaymentPersistence"
    | "markPaymentCompleted"
    | "markPenaltyFailureConverged"
  >;
  financialTransactionService: Pick<
    BookingFinancialTransactionService,
    "record" | "findById" | "findByIdempotencyKey" | "settlePenaltyObligation"
  >;
  bookingRepository: Pick<
    BookingRepository,
    "findByIdOnly" | "casUpdate" | "settleCancellationPenalty" | "claimNoShowCharge"
  >;
  businessRepository: Pick<BusinessRepository, "findById">;
  settlementNotifier?: PenaltySettlementNotificationPort | undefined;
  noShowNotifier?: Pick<NoShowNotificationPort, "notifyNoShowCharged"> | undefined;
  packageProgressRepository?:
    | Pick<PackageProgressRepository, "resolveSessionOnTerminalStatus">
    | undefined;
};

export class PenaltyCollectionService {
  public constructor(private readonly deps: PenaltyCollectionDeps) {}

  // --- Obligation (inside the caller's lifecycle transaction) --------------------------------

  /**
   * Writes the durable obligation and, when the customer has a usable saved card, its one
   * PaymentAttempt — both with the caller's session, so they commit (or roll back) with the
   * lifecycle transition itself. No usable card: the obligation is created definitively FAILED
   * with no attempt (no provider object can ever exist for it).
   */
  public async prepareObligation(
    input: {
      booking: BookingDocument;
      type: PenaltyPurpose;
      amountCents: number;
      grossFeeCents: number;
      upfrontAppliedCents: number;
      feePercentage: number | undefined;
    },
    session: ClientSession,
  ): Promise<PreparedPenalty> {
    const { booking } = input;
    const customerUserId = booking.customer.customerUserId;
    if (!customerUserId || input.amountCents <= 0) {
      throw new PenaltyCorrelationError("A penalty obligation needs a linked customer and amount");
    }
    const source = await this.deps.paymentService.resolvePenaltyPaymentSource(customerUserId);
    const obligation = await this.deps.financialTransactionService.record(
      {
        businessId: booking.businessId,
        bookingId: booking._id,
        businessClientId: booking.customer.businessClientId,
        customerUserId,
        type: input.type,
        direction: "DEBIT",
        amountCents: input.amountCents,
        currency: booking.financials.currency,
        status: source ? "PENDING" : "FAILED",
        idempotencyKey: obligationKeyFor(input.type, booking._id),
        metadata: {
          penaltyCollection: PENALTY_OBLIGATION_MARKER,
          grossFeeCents: input.grossFeeCents,
          upfrontAppliedCents: input.upfrontAppliedCents,
          ...(input.feePercentage !== undefined ? { feePercentage: input.feePercentage } : {}),
          ...(source ? {} : { failureCode: "PAYMENT_METHOD_REQUIRED" }),
        },
      },
      session,
    );
    if (!source) return { obligation };
    const attempt = await this.deps.paymentService.preparePenaltyAttempt(
      {
        logicalIdempotencyKey: penaltyAttemptKey(obligation._id),
        purpose: input.type,
        customerUserId,
        businessId: booking.businessId,
        bookingId: booking._id,
        businessClientId: booking.customer.businessClientId,
        amountCents: input.amountCents,
        providerCustomerId: source.stripeCustomerId,
      },
      session,
    );
    return { obligation, attempt };
  }

  /**
   * The no-show claim: in ONE transaction, stamp `noShowChargeClaimedAt` while the booking is
   * still PENDING and unclaimed, and write the obligation + attempt. Returns null when the claim
   * lost (no longer PENDING, already claimed, or a pre-P5 claim row exists — that booking is
   * marked claimed so the worker never selects it again, and is left for manual resolution).
   */
  public async claimNoShowPenalty(
    booking: BookingDocument,
    penalty: NoShowPenalty,
  ): Promise<PreparedPenalty | null> {
    const business = await this.deps.businessRepository.findById(booking.businessId);
    let prepared: PreparedPenalty | null = null;
    let legacyClaimExists = false;
    try {
      await this.runTransaction(async (session) => {
        prepared = null;
        const claimed = await this.deps.bookingRepository.claimNoShowCharge(booking._id, session);
        if (!claimed) return;
        try {
          prepared = await this.prepareObligation(
            {
              booking: claimed,
              type: "NO_SHOW_FEE",
              amountCents: penalty.amountCents,
              grossFeeCents: penalty.grossFeeCents,
              upfrontAppliedCents: penalty.upfrontAppliedCents,
              feePercentage: penalty.noShowPercentage,
            },
            session,
          );
        } catch (error) {
          if (isDuplicateLedgerKeyError(error)) legacyClaimExists = true;
          throw error;
        }
        if (!prepared.attempt && business) {
          await this.deps.settlementNotifier?.notifyPenaltySettlement(
            claimed,
            business,
            {
              kind: "NO_SHOW_FEE",
              outcome: "FAILED",
              amountCents: prepared.obligation.amountCents,
              obligationKey: noShowObligationKey(booking._id),
            },
            session,
          );
        }
      });
    } catch (error) {
      if (!legacyClaimExists) throw error;
      await this.deps.bookingRepository.claimNoShowCharge(booking._id);
      logger.warn(
        { bookingId: String(booking._id) },
        "Pre-P5 no-show penalty claim found — marked claimed for manual resolution, never auto-charged",
      );
      return null;
    }
    return prepared;
  }

  // --- Dispatch (after commit) ---------------------------------------------------------------

  /**
   * Sends the obligation's ONE provider attempt (only if it was never sent) and converges the
   * result. Never throws: an ambiguous provider outcome stays UNKNOWN for recovery, and the
   * lifecycle outcome that created the obligation is already final.
   */
  public async collect(obligationId: Types.ObjectId | string): Promise<PenaltyCollectionOutcome> {
    try {
      const obligation = await this.deps.financialTransactionService.findById(obligationId);
      if (!obligation) return "UNRESOLVED";
      if (obligation.status !== "PENDING") return this.outcomeOf(obligation.status);
      const attempt = await this.deps.paymentService.findPaymentAttemptByLogicalKey(
        penaltyAttemptKey(obligation._id),
      );
      if (!attempt) return "UNRESOLVED";
      if (
        attempt.providerStatus === "NOT_CREATED" &&
        !attempt.providerPaymentIntentId &&
        obligation.customerUserId
      ) {
        // Phase 6 — the profile's CURRENT default card at dispatch time. If it is gone, nothing
        // is sent; the stale-unsent recovery proves absence and settles the obligation FAILED.
        const source = await this.deps.paymentService.resolvePenaltyPaymentSource(
          obligation.customerUserId,
        );
        if (source) {
          try {
            await this.deps.paymentService.dispatchPenaltyAttempt(attempt._id, {
              stripeCustomerId: source.stripeCustomerId,
              paymentMethodId: source.paymentMethodId,
              metadata: this.providerMetadata(obligation, source.paymentMethodId),
            });
          } catch (error) {
            logger.warn(
              { err: error, paymentAttemptId: String(attempt._id) },
              "Penalty provider outcome not confirmed — recovery reconciles the same attempt",
            );
          }
        }
      }
      return await this.convergeAttempt(attempt._id);
    } catch (error) {
      logger.error(
        { err: error, obligationId: String(obligationId) },
        "Penalty collection left unresolved for recovery",
      );
      return "UNRESOLVED";
    }
  }

  // --- Convergence (request / worker / webhook / recovery) -----------------------------------

  /**
   * THE single settlement path. Reads the attempt's recorded provider state (never calls the
   * provider) and settles the obligation, booking settlement and follow-up notification exactly
   * once: SUCCEEDED -> obligation SUCCEEDED + exact PaymentIntent; definitive failure ->
   * obligation FAILED; anything else -> UNRESOLVED (nothing finalized).
   */
  public async convergeAttempt(
    paymentAttemptId: Types.ObjectId | string,
  ): Promise<PenaltyCollectionOutcome> {
    const attempt = await this.deps.paymentService.findPaymentAttemptById(paymentAttemptId);
    if (!attempt || !isPenaltyPurpose(attempt.purpose)) {
      throw new PenaltyCorrelationError("Not a penalty PaymentAttempt");
    }
    const obligationId = parsePenaltyAttemptKey(attempt.logicalIdempotencyKey);
    const obligation = obligationId
      ? await this.deps.financialTransactionService.findById(obligationId)
      : null;
    this.assertCorrelation(attempt, obligation);
    if (attempt.providerStatus === "SUCCEEDED") return this.convergeSuccess(attempt, obligation);
    if (isDefinitivePenaltyFailure(attempt)) return this.convergeFailure(attempt, obligation);
    return "UNRESOLVED";
  }

  /** Waiver/reversal gate — see PenaltyGate. A PENDING obligation whose attempt already holds a
   * terminal provider result is converged first (no provider call), so a waive/reversal right
   * after a definitive failure is never refused just because convergence had not run yet. */
  public async inspectGate(
    type: PenaltyPurpose,
    bookingId: Types.ObjectId | string,
  ): Promise<PenaltyGate> {
    const gate = await this.readGate(type, bookingId);
    if (gate.state !== "IN_PROGRESS") return gate;
    const attempt = await this.deps.paymentService.findPaymentAttemptByLogicalKey(
      penaltyAttemptKey(gate.obligation._id),
    );
    if (
      attempt &&
      (attempt.providerStatus === "SUCCEEDED" || isDefinitivePenaltyFailure(attempt))
    ) {
      try {
        await this.convergeAttempt(attempt._id);
      } catch (error) {
        logger.warn(
          { err: error, paymentAttemptId: String(attempt._id) },
          "Penalty convergence deferred to recovery",
        );
      }
      return this.readGate(type, bookingId);
    }
    return gate;
  }

  public async notifySettlement(
    booking: BookingDocument,
    business: BusinessDocument,
    settlement: {
      kind: PenaltyPurpose;
      outcome: "SUCCEEDED" | "FAILED" | "WAIVED";
      amountCents: number;
    },
    session?: ClientSession,
  ): Promise<void> {
    await this.deps.settlementNotifier?.notifyPenaltySettlement(
      booking,
      business,
      { ...settlement, obligationKey: obligationKeyFor(settlement.kind, booking._id) },
      session,
    );
  }

  private async readGate(
    type: PenaltyPurpose,
    bookingId: Types.ObjectId | string,
  ): Promise<PenaltyGate> {
    const ledger = this.deps.financialTransactionService;
    const obligation = await ledger.findByIdempotencyKey(obligationKeyFor(type, bookingId));
    if (!obligation) {
      if (type === "CANCELLATION_FEE") {
        const legacy = await ledger.findByIdempotencyKey(legacyCancellationLedgerKey(bookingId));
        if (legacy) {
          return {
            state: legacy.status === "SUCCEEDED" ? "SUCCEEDED" : "RECONCILIATION_REQUIRED",
            obligation: legacy,
          };
        }
      }
      return { state: "NONE" };
    }
    if (obligation.status === "WAIVED") return { state: "WAIVED", obligation };
    if (obligation.status === "SUCCEEDED") return { state: "SUCCEEDED", obligation };

    if (obligation.metadata?.["penaltyCollection"] !== PENALTY_OBLIGATION_MARKER) {
      // Pre-P5 row at the canonical key: a FAILED one keeps its existing manual waive/reversal
      // path; a PENDING one may hide a lost provider success and is never resolved here.
      return {
        state: obligation.status === "FAILED" ? "DEFINITIVE_FAILURE" : "RECONCILIATION_REQUIRED",
        obligation,
      };
    }

    const attempt = await this.deps.paymentService.findPaymentAttemptByLogicalKey(
      penaltyAttemptKey(obligation._id),
    );
    if (!attempt) {
      // A durable obligation has no attempt only when it was created FAILED for lack of a
      // usable card — nothing was ever sent for it.
      return {
        state: obligation.status === "FAILED" ? "DEFINITIVE_FAILURE" : "IN_PROGRESS",
        obligation,
      };
    }
    if (attempt.providerStatus === "SUCCEEDED") return { state: "SUCCEEDED", obligation };
    if (obligation.status === "FAILED" && isDefinitivePenaltyFailure(attempt)) {
      return { state: "DEFINITIVE_FAILURE", obligation };
    }
    return { state: "IN_PROGRESS", obligation };
  }

  private async convergeSuccess(
    attempt: PaymentAttemptDocument,
    obligation: BookingFinancialTransactionDocument,
  ): Promise<PenaltyCollectionOutcome> {
    const paymentIntentId = attempt.providerPaymentIntentId;
    if (!paymentIntentId) {
      throw new PenaltyCorrelationError("Succeeded penalty attempt has no PaymentIntent");
    }
    if (obligation.status === "SUCCEEDED") {
      if (obligation.providerReference !== paymentIntentId) {
        throw new PenaltyCorrelationError(
          "Penalty obligation was settled by another PaymentIntent",
        );
      }
      if (attempt.persistenceStatus === "COMPLETED") return "SUCCEEDED";
    } else if (obligation.status !== "PENDING") {
      // FAILED/WAIVED is a definitive local outcome: never regressed by a later provider success.
      throw new PenaltyCorrelationError(
        `Provider success contradicts a ${obligation.status} penalty obligation`,
      );
    }

    const leaseToken = await this.deps.paymentService.claimPaymentPersistence(String(attempt._id));
    if (!leaseToken) {
      const current = await this.deps.paymentService.findPaymentAttemptById(attempt._id);
      return current?.persistenceStatus === "COMPLETED" ? "SUCCEEDED" : "UNRESOLVED";
    }
    const booking = await this.deps.bookingRepository.findByIdOnly(obligation.bookingId);
    if (!booking) throw new PenaltyCorrelationError("Penalty booking not found");
    const business = await this.deps.businessRepository.findById(booking.businessId);

    await this.runTransaction(async (session) => {
      const settled = await this.deps.financialTransactionService.settlePenaltyObligation(
        obligation._id,
        { status: "SUCCEEDED", providerReference: paymentIntentId },
        session,
      );
      if (settled) {
        await this.finalizeBookingSuccess(booking, settled, business, paymentIntentId, session);
      } else {
        const current = await this.deps.financialTransactionService.findById(
          obligation._id,
          session,
        );
        if (current?.status !== "SUCCEEDED" || current.providerReference !== paymentIntentId) {
          throw new PenaltyCorrelationError("Penalty obligation changed during convergence");
        }
      }
      const completed = await this.deps.paymentService.markPaymentCompleted(
        String(attempt._id),
        { bookingId: obligation.bookingId, succeededTransactionId: obligation._id },
        leaseToken,
        session,
      );
      if (!completed) throw new Error("Penalty persistence lease was lost");
    });
    return "SUCCEEDED";
  }

  private async finalizeBookingSuccess(
    booking: BookingDocument,
    obligation: BookingFinancialTransactionDocument,
    business: BusinessDocument | null,
    paymentIntentId: string,
    session: ClientSession,
  ): Promise<void> {
    if (obligation.type === "CANCELLATION_FEE") {
      const updated = await this.deps.bookingRepository.settleCancellationPenalty(
        booking._id,
        "SUCCEEDED",
        paymentIntentId,
        session,
      );
      if (!updated) {
        logger.error(
          { bookingId: String(booking._id) },
          "Collected cancellation fee found no PENDING booking settlement — investigate",
        );
        return;
      }
      if (business) {
        await this.notifySettlement(
          updated,
          business,
          { kind: "CANCELLATION_FEE", outcome: "SUCCEEDED", amountCents: obligation.amountCents },
          session,
        );
      }
      return;
    }

    if (!business) {
      logger.error(
        { bookingId: String(booking._id) },
        "Collected no-show fee has no business to attribute NO_SHOW_CHARGED to — investigate",
      );
      return;
    }
    const charged = await this.deps.bookingRepository.casUpdate(
      booking.businessId,
      booking._id,
      ["PENDING"],
      {
        set: { status: "NO_SHOW_CHARGED" },
        pushEvent: {
          type: "STATUS_CHANGED",
          previousStatus: "PENDING",
          nextStatus: "NO_SHOW_CHARGED",
          actorUserId: business.ownerUserId,
          actorRole: "BUSINESS_OWNER",
          note: `Charged via ${paymentIntentId}`,
          createdAt: new Date(),
        },
      },
      session,
    );
    if (!charged) {
      logger.error(
        { bookingId: String(booking._id) },
        "Collected no-show fee found the booking no longer PENDING — investigate",
      );
      return;
    }
    if (this.deps.packageProgressRepository && isPackageLinkedBooking(charged)) {
      const outcome = packageSessionOutcomeForBookingStatus(charged.status);
      if (outcome !== "NONE") {
        await this.deps.packageProgressRepository.resolveSessionOnTerminalStatus(
          charged._id,
          outcome,
          session,
        );
      }
    }
    const metadata = obligation.metadata ?? {};
    await this.deps.noShowNotifier?.notifyNoShowCharged(
      charged,
      {
        businessName: business.name,
        amounts: {
          noShowPercentage: Number(metadata["feePercentage"] ?? 0),
          eligibleBasisCents: charged.financials.eligiblePlatformFeeBasisCents,
          grossFeeCents: Number(metadata["grossFeeCents"] ?? obligation.amountCents),
          upfrontAppliedCents: Number(metadata["upfrontAppliedCents"] ?? 0),
          additionalChargeCents: obligation.amountCents,
        },
      },
      session,
    );
  }

  private async convergeFailure(
    attempt: PaymentAttemptDocument,
    obligation: BookingFinancialTransactionDocument,
  ): Promise<PenaltyCollectionOutcome> {
    if (obligation.status === "FAILED" || obligation.status === "WAIVED") {
      await this.deps.paymentService.markPenaltyFailureConverged(attempt._id);
      return this.outcomeOf(obligation.status);
    }
    if (obligation.status !== "PENDING") {
      throw new PenaltyCorrelationError(
        `Provider failure contradicts a ${obligation.status} penalty obligation`,
      );
    }
    const booking = await this.deps.bookingRepository.findByIdOnly(obligation.bookingId);
    if (!booking) throw new PenaltyCorrelationError("Penalty booking not found");
    const business = await this.deps.businessRepository.findById(booking.businessId);
    let outcome: PenaltyCollectionOutcome = "FAILED";

    await this.runTransaction(async (session) => {
      outcome = "FAILED";
      const settled = await this.deps.financialTransactionService.settlePenaltyObligation(
        obligation._id,
        { status: "FAILED" },
        session,
      );
      if (settled) {
        let current = booking;
        if (settled.type === "CANCELLATION_FEE") {
          current =
            (await this.deps.bookingRepository.settleCancellationPenalty(
              booking._id,
              "FAILED",
              attempt.providerPaymentIntentId,
              session,
            )) ?? booking;
        }
        // No-show: the booking deliberately stays PENDING (claimed) for manual resolution.
        if (business) {
          await this.notifySettlement(
            current,
            business,
            {
              kind: settled.type as PenaltyPurpose,
              outcome: "FAILED",
              amountCents: settled.amountCents,
            },
            session,
          );
        }
      } else {
        const current = await this.deps.financialTransactionService.findById(
          obligation._id,
          session,
        );
        if (current?.status === "SUCCEEDED") {
          throw new PenaltyCorrelationError("Provider failure contradicts a SUCCEEDED obligation");
        }
        outcome = current?.status === "WAIVED" ? "WAIVED" : "FAILED";
      }
      await this.deps.paymentService.markPenaltyFailureConverged(attempt._id, session);
    });
    return outcome;
  }

  private assertCorrelation(
    attempt: PaymentAttemptDocument,
    obligation: BookingFinancialTransactionDocument | null,
  ): asserts obligation is BookingFinancialTransactionDocument {
    if (
      !obligation ||
      obligation.type !== attempt.purpose ||
      obligation.metadata?.["penaltyCollection"] !== PENALTY_OBLIGATION_MARKER ||
      String(obligation.bookingId) !== String(attempt.bookingId ?? "") ||
      String(obligation.businessId) !== String(attempt.businessId ?? "") ||
      String(obligation.businessClientId) !== String(attempt.businessClientId ?? "") ||
      String(obligation.customerUserId ?? "") !== String(attempt.customerUserId) ||
      obligation.amountCents !== attempt.expectedAmountCents ||
      obligation.currency !== attempt.currency ||
      attempt.relationshipClassification !== undefined ||
      attempt.financialContractVersion !== undefined ||
      attempt.productKind !== undefined
    ) {
      throw new PenaltyCorrelationError("Penalty attempt/obligation correlation mismatch");
    }
  }

  private providerMetadata(
    obligation: BookingFinancialTransactionDocument,
    paymentMethodId: string,
  ): Record<string, string> {
    return {
      ...buildPaymentIntentMetadata({
        bookingId: String(obligation.bookingId),
        businessId: String(obligation.businessId),
        businessClientId: String(obligation.businessClientId),
        purpose: obligation.type as PenaltyPurpose,
        preTaxChargeCents: obligation.amountCents,
        taxCents: 0,
        chargedAmountCents: obligation.amountCents,
        taxMode: "PRE_ACTIVATION",
      }),
      booklyPenaltyObligationId: String(obligation._id),
      booklyPaymentMethodId: paymentMethodId,
    };
  }

  private outcomeOf(
    status: BookingFinancialTransactionDocument["status"],
  ): PenaltyCollectionOutcome {
    if (status === "SUCCEEDED") return "SUCCEEDED";
    if (status === "FAILED") return "FAILED";
    if (status === "WAIVED") return "WAIVED";
    return "UNRESOLVED";
  }

  private async runTransaction(work: (session: ClientSession) => Promise<void>): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => work(session));
    } finally {
      await session.endSession();
    }
  }
}

export const isDuplicateLedgerKeyError = (error: unknown): boolean =>
  error instanceof Error &&
  "details" in error &&
  Array.isArray((error as { details?: unknown }).details) &&
  (error as { details: Array<{ code?: string }> }).details.some(
    (detail) => detail.code === "BOOKING_FINANCIAL_TRANSACTION_DUPLICATE_IDEMPOTENCY_KEY",
  );
