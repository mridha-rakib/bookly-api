import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { DisputeLedgerType } from "../booking-financial-transaction/booking-financial-transaction.types.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { classifySourceOwner } from "../finance/finance-ownership.js";
import type {
  BusinessReversalAlertInput,
  ProviderReversalNotificationPort,
  SupportAlertInput,
} from "../notification/provider-reversal.notifier.js";
import type { DisputeSnapshot, PaymentGateway, RefundResult } from "../payment/payment.types.js";
import type { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import {
  ensureProcessingFeeAccounting,
  ProcessingFeeCurrencyMismatchError,
  ProcessingFeeUnavailableError,
} from "../payment/processing-fee-accounting.js";
import type { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import type { PaymentDisputeDocument } from "./payment-dispute.model.js";
import type {
  ExternalRefundRepository,
  PaymentDisputeRepository,
} from "./provider-reversal.repository.js";

/**
 * P6 — provider-originated reversals: disputes (chargebacks) and refunds made outside Bookly.
 *
 * Money truth is the provider's: every dispute money movement is accounted from the dispute's
 * own provider balance transactions (signed principal + signed fee, keyed per balance
 * transaction), and every external refund from its provider Refund object (keyed per refund id)
 * — at most one immutable ledger row per provider monetary movement, attributed to the economic
 * owner of the exact disputed/refunded principal (`metadata.sourceType`, finance-ownership.ts).
 * Business-owned losses reduce Business payable and carry forward through the existing unclaimed-
 * row payout mechanism; Bookly-owned ones reduce Bookly revenue. Nothing is guessed: a dispute or
 * refund whose principal cannot be deterministically correlated, or whose movement would exceed
 * the provider-confirmed principal, is recorded for investigation with no accounting.
 *
 * Accounting/state only: never touches booking, package, penalty, promo or FIRST relationship
 * lifecycle, never calls the provider to move money, never refunds.
 */
export const PRINCIPAL_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "PLATFORM_FEE",
  "DEPOSIT",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
]);

export const disputePrincipalKey = (disputeId: string, balanceTransactionId: string): string =>
  `dispute:${disputeId}:principal:${balanceTransactionId}`;
export const disputeFeeKey = (disputeId: string, balanceTransactionId: string): string =>
  `dispute:${disputeId}:fee:${balanceTransactionId}`;
export const externalRefundKey = (providerRefundId: string): string =>
  `external-refund:${providerRefundId}`;

export const EXTERNAL_REFUND_ORIGIN = "PROVIDER_EXTERNAL";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_OPTIONS = {
  /** Account-level backstop sweep cadence (per worker process). */
  sweepIntervalMs: 15 * 60_000,
  /** Open disputes are re-read from the provider at most this often by the backstop. */
  resyncAfterMs: 15 * 60_000,
  disputeLookbackMs: 120 * DAY_MS,
  refundLookbackMs: 30 * DAY_MS,
  disputeSweepMax: 200,
  refundSweepMax: 500,
  /** Processing fees are normally captured by the webhook; the backstop waits past its retry
   * window before looking, and never scans beyond the lookback. */
  processingFeeMinAgeMs: 60 * 60_000,
  processingFeeLookbackMs: 30 * DAY_MS,
};
export type ProviderReversalOptions = typeof DEFAULT_OPTIONS;

export type SyncVia = "WEBHOOK" | "POLLING" | "REPLAY";

/** Corrupt provider↔ledger identity (an existing accounting row disagrees with the provider
 * movement it claims to represent). Never overwritten, never retried blindly. */
export class ProviderReversalCorrelationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderReversalCorrelationError";
  }
}

export type ExternalRefundOutcome =
  | "PENDING"
  | "BOOKLY"
  | "ALREADY_ACCOUNTED"
  | "ACCOUNTED"
  | "INVESTIGATION";

export type ProviderReversalDeps = {
  gateway: Pick<
    PaymentGateway,
    | "retrieveDispute"
    | "listDisputesCreatedSince"
    | "listRefundsForPaymentIntent"
    | "listRefundsCreatedSince"
    | "retrievePaymentIntent"
    | "retrieveProcessingFeeForPaymentIntent"
  >;
  disputes: PaymentDisputeRepository;
  externalRefunds: ExternalRefundRepository;
  financialTransactionService: Pick<
    BookingFinancialTransactionService,
    | "record"
    | "findById"
    | "findByIdempotencyKey"
    | "listForBooking"
    | "listPrincipalRowsMissingProcessingFee"
  >;
  paymentAttemptRepository: Pick<PaymentAttemptRepository, "findByProviderPaymentIntentId">;
  refundOperationRepository: Pick<
    RefundOperationRepository,
    "findByProviderRefundId" | "findById" | "findPendingLegacyMatch"
  >;
  bookingRepository: Pick<BookingRepository, "findByIdOnly">;
  businessRepository: Pick<BusinessRepository, "findById">;
  notifier?: ProviderReversalNotificationPort | undefined;
};

type PrincipalResolution =
  | {
      ok: true;
      source: BookingFinancialTransactionDocument;
      rows: BookingFinancialTransactionDocument[];
    }
  | { ok: false; reason: string };

export class ProviderReversalService {
  private readonly options: ProviderReversalOptions;
  private lastSweepAt: number | undefined;

  public constructor(
    private readonly deps: ProviderReversalDeps,
    options: Partial<ProviderReversalOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // --- Disputes ---------------------------------------------------------------------------

  /** Re-reads the dispute from the provider (the authoritative current state — out-of-order or
   * duplicate events therefore converge to the same result) and applies it. */
  public async syncDispute(disputeId: string, via: SyncVia): Promise<PaymentDisputeDocument> {
    if (!this.deps.gateway.retrieveDispute) throw new Error("Dispute retrieval is unavailable");
    const snapshot = await this.deps.gateway.retrieveDispute(disputeId);
    return this.applyDisputeSnapshot(snapshot, via);
  }

  public async applyDisputeSnapshot(
    snapshot: DisputeSnapshot,
    via: SyncVia,
  ): Promise<PaymentDisputeDocument> {
    const { dispute: stored, isNew } = await this.deps.disputes.upsertFromProvider(snapshot, via);
    if (isNew) {
      await this.support({
        kind: "DISPUTE_NEW",
        identity: snapshot.disputeId,
        providerReference: snapshot.disputeId,
        amountCents: snapshot.amountCents,
        currency: snapshot.currency,
        detail: `status=${snapshot.status}${snapshot.reason ? ` reason=${snapshot.reason}` : ""}`,
      });
    }

    const dispute = await this.ensureDisputeCorrelated(stored, snapshot);
    if (dispute.correlation !== "CORRELATED") {
      await this.support({
        kind: "DISPUTE_INVESTIGATION",
        identity: snapshot.disputeId,
        providerReference: snapshot.disputeId,
        amountCents: snapshot.amountCents,
        currency: snapshot.currency,
        detail: dispute.investigationReason,
      });
      return dispute;
    }

    const accounted = await this.accountDisputeMovements(dispute, snapshot);
    await this.notifyBusinessOfDispute(dispute, accounted);
    return (await this.deps.disputes.findById(dispute._id)) ?? dispute;
  }

  private async ensureDisputeCorrelated(
    dispute: PaymentDisputeDocument,
    snapshot: DisputeSnapshot,
  ): Promise<PaymentDisputeDocument> {
    if (dispute.correlation === "CORRELATED") return dispute;
    const reason = await (async (): Promise<string | PaymentDisputeDocument> => {
      if (!snapshot.paymentIntentId) return "Dispute has no PaymentIntent";
      const resolution = await this.resolvePrincipal(snapshot.paymentIntentId);
      if (!resolution.ok) return resolution.reason;
      const { source } = resolution;
      if (source.currency !== snapshot.currency)
        return "Dispute currency differs from its principal";
      if (snapshot.amountCents > source.amountCents) {
        return "Disputed amount exceeds the provider-confirmed principal";
      }
      const owner = classifySourceOwner(source.type);
      if (owner === "UNKNOWN") return `Principal ${source.type} has no known economic owner`;
      const correlated = await this.deps.disputes.markCorrelated(dispute._id, {
        sourceTransactionId: source._id,
        sourceType: source.type,
        economicOwner: owner,
        bookingId: source.bookingId,
        businessId: source.businessId,
        businessClientId: source.businessClientId,
        ...(source.customerUserId ? { customerUserId: source.customerUserId } : {}),
      });
      return (
        correlated ?? ((await this.deps.disputes.findById(dispute._id)) as PaymentDisputeDocument)
      );
    })();
    if (typeof reason !== "string") return reason;
    await this.deps.disputes.markUncorrelated(dispute._id, reason);
    return (await this.deps.disputes.findById(dispute._id)) ?? dispute;
  }

  /**
   * One ledger row per provider-confirmed movement: each dispute balance transaction yields its
   * principal row (DISPUTE_WITHDRAWAL / DISPUTE_REINSTATEMENT) and its fee row (DISPUTE_FEE /
   * DISPUTE_FEE_REVERSAL), keyed by the balance transaction id — so "opened" and "funds
   * withdrawn" events describing the same movement can never double-account it. A withdrawal
   * that would push successful refunds + outstanding dispute withdrawals beyond the principal, or
   * a reinstatement beyond what this dispute withdrew, is flagged and not accounted.
   */
  private async accountDisputeMovements(
    dispute: PaymentDisputeDocument,
    snapshot: DisputeSnapshot,
  ): Promise<{ withdrawnCents: number; reinstatedCents: number }> {
    const source = dispute.sourceTransactionId
      ? await this.deps.financialTransactionService.findById(dispute.sourceTransactionId)
      : null;
    if (!source) throw new ProviderReversalCorrelationError("Dispute principal row is missing");
    const rows = await this.deps.financialTransactionService.listForBooking(source.bookingId);
    const mine = (row: BookingFinancialTransactionDocument) =>
      row.metadata?.["providerDisputeId"] === snapshot.disputeId;
    let withdrawnCents = sum(rows, (r) => mine(r) && r.type === "DISPUTE_WITHDRAWAL");
    let reinstatedCents = sum(rows, (r) => mine(r) && r.type === "DISPUTE_REINSTATEMENT");
    let feeChargedCents = sum(rows, (r) => mine(r) && r.type === "DISPUTE_FEE");
    let feeReturnedCents = sum(rows, (r) => mine(r) && r.type === "DISPUTE_FEE_REVERSAL");
    let outstandingCents = this.outstandingAgainst(rows, source);
    const problems: string[] = [];

    const movements = [...snapshot.balanceTransactions].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    for (const movement of movements) {
      if (movement.currency !== source.currency) {
        problems.push(`balance transaction ${movement.balanceTransactionId} currency differs`);
        continue;
      }
      if (movement.amountCents !== 0) {
        const key = disputePrincipalKey(snapshot.disputeId, movement.balanceTransactionId);
        const amountCents = Math.abs(movement.amountCents);
        const type: DisputeLedgerType =
          movement.amountCents < 0 ? "DISPUTE_WITHDRAWAL" : "DISPUTE_REINSTATEMENT";
        const alreadyAccounted = rows.some((row) => row.idempotencyKey === key);
        // A refused movement records NO accounting at all (neither principal nor its fee): the
        // whole balance transaction waits for manual reconciliation.
        if (
          !alreadyAccounted &&
          type === "DISPUTE_WITHDRAWAL" &&
          outstandingCents + amountCents > source.amountCents
        ) {
          problems.push(
            `withdrawal ${movement.balanceTransactionId} would exceed the principal (refunds + open dispute withdrawals)`,
          );
          continue;
        }
        if (
          !alreadyAccounted &&
          type === "DISPUTE_REINSTATEMENT" &&
          reinstatedCents + amountCents > withdrawnCents
        ) {
          problems.push(
            `reinstatement ${movement.balanceTransactionId} exceeds this dispute's withdrawals`,
          );
          continue;
        }
        const { row, created } = await this.recordReversalRow({
          key,
          type,
          amountCents,
          source,
          providerReference: snapshot.disputeId,
          metadata: {
            providerDisputeId: snapshot.disputeId,
            balanceTransactionId: movement.balanceTransactionId,
          },
        });
        if (created) {
          rows.push(row);
          if (type === "DISPUTE_WITHDRAWAL") {
            withdrawnCents += amountCents;
            outstandingCents += amountCents;
          } else {
            reinstatedCents += amountCents;
            outstandingCents -= amountCents;
          }
        }
      }
      if (movement.feeCents !== 0) {
        const key = disputeFeeKey(snapshot.disputeId, movement.balanceTransactionId);
        const type: DisputeLedgerType =
          movement.feeCents > 0 ? "DISPUTE_FEE" : "DISPUTE_FEE_REVERSAL";
        const amountCents = Math.abs(movement.feeCents);
        const alreadyAccounted = rows.some((row) => row.idempotencyKey === key);
        // A fee reversal is the exact opposite of a fee this dispute was charged — never more.
        if (
          !alreadyAccounted &&
          type === "DISPUTE_FEE_REVERSAL" &&
          feeReturnedCents + amountCents > feeChargedCents
        ) {
          problems.push(
            `fee reversal ${movement.balanceTransactionId} exceeds this dispute's fees`,
          );
          continue;
        }
        const { row, created } = await this.recordReversalRow({
          key,
          type,
          amountCents,
          source,
          providerReference: snapshot.disputeId,
          metadata: {
            providerDisputeId: snapshot.disputeId,
            balanceTransactionId: movement.balanceTransactionId,
          },
        });
        if (created) {
          rows.push(row);
          if (type === "DISPUTE_FEE") feeChargedCents += amountCents;
          else feeReturnedCents += amountCents;
        }
      }
    }

    // A Bookly refund that succeeded AFTER the funds were withdrawn (Stripe normally refuses to
    // refund a disputed charge) leaves the principal over-returned: never auto-corrected, always
    // surfaced on the next sync for manual reconciliation.
    if (outstandingCents > source.amountCents) {
      problems.push(
        `principal over-returned: refunds + outstanding dispute withdrawals (${outstandingCents}) exceed ${source.amountCents}`,
      );
    }

    if (problems.length > 0) {
      const reason = problems.join("; ");
      await this.deps.disputes.flagReconciliation(dispute._id, reason);
      await this.support({
        kind: "DISPUTE_RECONCILIATION_REQUIRED",
        identity: snapshot.disputeId,
        providerReference: snapshot.disputeId,
        amountCents: snapshot.amountCents,
        currency: snapshot.currency,
        businessId: String(source.businessId),
        bookingId: String(source.bookingId),
        detail: reason,
      });
    }
    return { withdrawnCents, reinstatedCents };
  }

  private async notifyBusinessOfDispute(
    dispute: PaymentDisputeDocument,
    accounted: { withdrawnCents: number; reinstatedCents: number },
  ): Promise<void> {
    if (!this.deps.notifier || dispute.economicOwner !== "BUSINESS" || !dispute.businessId) return;
    const business = await this.deps.businessRepository.findById(dispute.businessId);
    if (!business) return;
    const current = (await this.deps.disputes.findById(dispute._id)) ?? dispute;
    const booking = current.bookingId
      ? await this.deps.bookingRepository.findByIdOnly(current.bookingId)
      : null;
    const base = {
      identity: current.providerDisputeId,
      providerReference: current.providerDisputeId,
      currency: current.currency,
      bookingReference: booking?.reference ?? String(current.bookingId ?? ""),
    };
    const send = (
      alert: Omit<BusinessReversalAlertInput, keyof typeof base> & Partial<typeof base>,
    ) =>
      this.deps.notifier?.notifyBusiness(business, {
        ...base,
        ...alert,
      } as BusinessReversalAlertInput);
    await send({ kind: "DISPUTE_OPENED", amountCents: current.amountCents });
    if (accounted.withdrawnCents > 0) {
      await send({ kind: "DISPUTE_FUNDS_WITHDRAWN", amountCents: accounted.withdrawnCents });
    }
    if (accounted.reinstatedCents > 0) {
      await send({ kind: "DISPUTE_FUNDS_REINSTATED", amountCents: accounted.reinstatedCents });
    }
    if (current.outcome === "WON")
      await send({ kind: "DISPUTE_WON", amountCents: current.amountCents });
    if (current.outcome === "LOST")
      await send({ kind: "DISPUTE_LOST", amountCents: current.amountCents });
  }

  // --- External refunds -------------------------------------------------------------------

  /** charge.refunded / charge.refund.updated only carry cumulative or single-refund state: list
   * every provider Refund of the PaymentIntent and account each unseen external one once. */
  public async reconcileRefundsForPaymentIntent(
    paymentIntentId: string,
    via: SyncVia,
  ): Promise<ExternalRefundOutcome[]> {
    if (!this.deps.gateway.listRefundsForPaymentIntent) return [];
    const refunds = await this.deps.gateway.listRefundsForPaymentIntent(paymentIntentId);
    const outcomes: ExternalRefundOutcome[] = [];
    for (const refund of [...refunds].sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    )) {
      outcomes.push(await this.ingestProviderRefund(refund, via));
    }
    return outcomes;
  }

  public async ingestProviderRefund(
    refund: RefundResult,
    via: SyncVia,
  ): Promise<ExternalRefundOutcome> {
    if (refund.status !== "succeeded") {
      // An external refund already accounted that the provider later reports failed (or canceled):
      // the immutable ledger row stays; support reconciles manually (never auto-reversed here).
      if (refund.status === "failed") {
        const accounted = await this.deps.externalRefunds.findByProviderRefundId(refund.refundId);
        if (accounted?.state === "ACCOUNTED") {
          await this.support({
            kind: "EXTERNAL_REFUND_INVESTIGATION",
            identity: `${refund.refundId}:${refund.status}`,
            providerReference: refund.refundId,
            amountCents: accounted.amountCents,
            currency: accounted.currency,
            detail: `Previously accounted external refund is now ${refund.status}: manual reconciliation required`,
          });
          return "INVESTIGATION";
        }
      }
      return "PENDING";
    }
    const refunds = this.deps.refundOperationRepository;
    // Bookly-authorized refunds (RefundOperation) keep their own accounting path, untouched.
    if (await refunds.findByProviderRefundId(refund.refundId)) return "BOOKLY";
    const operationId = refund.metadata?.["booklyRefundOperationId"];
    if (operationId) {
      if (Types.ObjectId.isValid(operationId) && (await refunds.findById(operationId)))
        return "BOOKLY";
      return this.investigateRefund(
        refund,
        via,
        "Refund metadata references an unknown RefundOperation",
      );
    }
    const existing = await this.deps.externalRefunds.findByProviderRefundId(refund.refundId);
    if (existing?.state === "ACCOUNTED") return "ALREADY_ACCOUNTED";
    const paymentIntentId = refund.paymentIntentId;
    if (!paymentIntentId) return this.investigateRefund(refund, via, "Refund has no PaymentIntent");
    // A metadata-less refund that merely matches a pending pre-metadata RefundOperation by amount
    // is ambiguous (the webhook path attaches such a refund to its operation first, so it never
    // reaches here as unmatched): investigate rather than guess either way.
    if (
      refund.amountCents !== undefined &&
      (await refunds.findPendingLegacyMatch(paymentIntentId, refund.amountCents))
    ) {
      return this.investigateRefund(
        refund,
        via,
        "Matches a pending pre-metadata RefundOperation by amount (ambiguous)",
      );
    }

    const resolution = await this.resolvePrincipal(paymentIntentId);
    if (!resolution.ok) return this.investigateRefund(refund, via, resolution.reason);
    const { source, rows } = resolution;
    // A refund already ledgered by a Bookly flow (e.g. a pre-RefundOperation booking-flow refund)
    // is never double-counted as external.
    if (rows.some((row) => row.type === "REFUND" && row.providerReference === refund.refundId)) {
      if (!rows.some((row) => row.idempotencyKey === externalRefundKey(refund.refundId))) {
        return "ALREADY_ACCOUNTED";
      }
    }
    const amountCents = refund.amountCents ?? 0;
    if (amountCents <= 0 || (refund.currency ?? "").toUpperCase() !== source.currency) {
      return this.investigateRefund(
        refund,
        via,
        "Refund amount/currency is not comparable to its principal",
      );
    }
    const key = externalRefundKey(refund.refundId);
    const alreadyAccounted = rows.some((row) => row.idempotencyKey === key);
    if (
      !alreadyAccounted &&
      this.outstandingAgainst(rows, source) + amountCents > source.amountCents
    ) {
      return this.investigateRefund(
        refund,
        via,
        "Refund would exceed the principal (refunds + open dispute withdrawals)",
        source,
      );
    }

    const { row } = await this.recordReversalRow({
      key,
      type: "REFUND",
      amountCents,
      source,
      providerReference: refund.refundId,
      metadata: { refundOrigin: EXTERNAL_REFUND_ORIGIN },
    });
    const owner = classifySourceOwner(source.type);
    const { record } = await this.deps.externalRefunds.createIfMissing({
      providerRefundId: refund.refundId,
      providerPaymentIntentId: paymentIntentId,
      amountCents,
      currency: source.currency,
      ...(refund.createdAt ? { providerCreatedAt: refund.createdAt } : {}),
      state: "ACCOUNTED",
      sourceTransactionId: source._id,
      sourceType: source.type,
      ...(owner === "BOOKLY" || owner === "BUSINESS" ? { economicOwner: owner } : {}),
      ledgerTransactionId: row._id,
      bookingId: source.bookingId,
      businessId: source.businessId,
      businessClientId: source.businessClientId,
      detectedVia: via,
    });
    if (record.state !== "ACCOUNTED")
      await this.deps.externalRefunds.markAccounted(record._id, row._id);

    await this.support({
      kind: "EXTERNAL_REFUND",
      identity: refund.refundId,
      providerReference: refund.refundId,
      amountCents,
      currency: source.currency,
      businessId: String(source.businessId),
      bookingId: String(source.bookingId),
      detail: `owner=${owner} source=${source.type}`,
    });
    if (owner === "BUSINESS" && this.deps.notifier) {
      const business = await this.deps.businessRepository.findById(source.businessId);
      const booking = await this.deps.bookingRepository.findByIdOnly(source.bookingId);
      if (business) {
        await this.deps.notifier.notifyBusiness(business, {
          kind: "EXTERNAL_REFUND",
          identity: refund.refundId,
          providerReference: refund.refundId,
          amountCents,
          currency: source.currency,
          bookingReference: booking?.reference ?? String(source.bookingId),
        });
      }
    }
    return "ACCOUNTED";
  }

  private async investigateRefund(
    refund: RefundResult,
    via: SyncVia,
    reason: string,
    source?: BookingFinancialTransactionDocument,
  ): Promise<ExternalRefundOutcome> {
    const { record, isNew } = await this.deps.externalRefunds.createIfMissing({
      providerRefundId: refund.refundId,
      ...(refund.paymentIntentId ? { providerPaymentIntentId: refund.paymentIntentId } : {}),
      amountCents: refund.amountCents ?? 0,
      currency: (refund.currency ?? "EUR").toUpperCase(),
      ...(refund.createdAt ? { providerCreatedAt: refund.createdAt } : {}),
      state: "INVESTIGATION",
      investigationReason: reason,
      ...(source
        ? {
            sourceTransactionId: source._id,
            sourceType: source.type,
            bookingId: source.bookingId,
            businessId: source.businessId,
            businessClientId: source.businessClientId,
          }
        : {}),
      detectedVia: via,
    });
    if (record.state === "ACCOUNTED") return "ALREADY_ACCOUNTED";
    if (!isNew) await this.deps.externalRefunds.markInvestigation(record._id, reason);
    await this.support({
      kind: "EXTERNAL_REFUND_INVESTIGATION",
      identity: refund.refundId,
      providerReference: refund.refundId,
      ...(refund.amountCents !== undefined && refund.currency
        ? { amountCents: refund.amountCents, currency: refund.currency.toUpperCase() }
        : {}),
      detail: reason,
    });
    return "INVESTIGATION";
  }

  // --- Shared correlation / accounting -----------------------------------------------------

  /** provider PaymentIntent -> its Bookly booking (durable PaymentAttempt first, else the PI's
   * own Bookly metadata) -> exactly one succeeded provider-backed principal row for that PI. */
  private async resolvePrincipal(paymentIntentId: string): Promise<PrincipalResolution> {
    const bookingId = await this.bookingIdForPaymentIntent(paymentIntentId);
    if (!bookingId) return { ok: false, reason: "PaymentIntent is not linked to a Bookly booking" };
    const rows = await this.deps.financialTransactionService.listForBooking(bookingId);
    const principals = rows.filter(
      (row) =>
        row.providerReference === paymentIntentId &&
        PRINCIPAL_SOURCE_TYPES.has(row.type) &&
        row.status === "SUCCEEDED",
    );
    if (principals.length !== 1) {
      return {
        ok: false,
        reason:
          principals.length === 0
            ? "No succeeded principal row for this PaymentIntent"
            : "Multiple principal rows for this PaymentIntent",
      };
    }
    return { ok: true, source: principals[0] as BookingFinancialTransactionDocument, rows };
  }

  private async bookingIdForPaymentIntent(
    paymentIntentId: string,
  ): Promise<Types.ObjectId | undefined> {
    const attempt =
      await this.deps.paymentAttemptRepository.findByProviderPaymentIntentId(paymentIntentId);
    if (attempt?.bookingId) return attempt.bookingId;
    if (!this.deps.gateway.retrievePaymentIntent) return undefined;
    const snapshot = await this.deps.gateway.retrievePaymentIntent(paymentIntentId);
    const bookingId = snapshot.metadata?.["bookingId"];
    return bookingId && Types.ObjectId.isValid(bookingId)
      ? new Types.ObjectId(bookingId)
      : undefined;
  }

  /** Principal already returned to the cardholder: successful refunds (Bookly or external) plus
   * dispute withdrawals not reinstated — the conservation side of the P6 invariant. */
  private outstandingAgainst(
    rows: BookingFinancialTransactionDocument[],
    source: BookingFinancialTransactionDocument,
  ): number {
    const sourceId = String(source._id);
    let outstanding = 0;
    for (const row of rows) {
      if (row.status !== "SUCCEEDED") continue;
      const linked = row.metadata?.["sourceTransactionId"];
      // An unlinked legacy refund on the same booking might have returned this principal: count
      // it (a false investigation is safe, an over-principal accounting is not). COMPENSATION
      // refunds unwind charges that never had a principal row, so they cannot be this one.
      const unlinkedRefund =
        row.type === "REFUND" &&
        linked === undefined &&
        row.metadata?.["sourceType"] !== "COMPENSATION";
      if (linked !== sourceId && !unlinkedRefund) continue;
      if (row.type === "REFUND" || row.type === "DISPUTE_WITHDRAWAL")
        outstanding += row.amountCents;
      if (row.type === "DISPUTE_REINSTATEMENT") outstanding -= row.amountCents;
    }
    return outstanding;
  }

  private async recordReversalRow(input: {
    key: string;
    type: DisputeLedgerType | "REFUND";
    amountCents: number;
    source: BookingFinancialTransactionDocument;
    providerReference: string;
    metadata: Record<string, string>;
  }): Promise<{ row: BookingFinancialTransactionDocument; created: boolean }> {
    const ledger = this.deps.financialTransactionService;
    const verify = (row: BookingFinancialTransactionDocument) => {
      if (
        row.type !== input.type ||
        row.amountCents !== input.amountCents ||
        row.metadata?.["sourceTransactionId"] !== String(input.source._id)
      ) {
        throw new ProviderReversalCorrelationError(
          `Ledger row ${input.key} disagrees with the provider movement`,
        );
      }
      return row;
    };
    const existing = await ledger.findByIdempotencyKey(input.key);
    if (existing) return { row: verify(existing), created: false };
    try {
      const row = await ledger.record({
        businessId: input.source.businessId,
        bookingId: input.source.bookingId,
        businessClientId: input.source.businessClientId,
        ...(input.source.customerUserId ? { customerUserId: input.source.customerUserId } : {}),
        type: input.type,
        direction:
          input.type === "DISPUTE_REINSTATEMENT" || input.type === "DISPUTE_FEE"
            ? "DEBIT"
            : "CREDIT",
        amountCents: input.amountCents,
        currency: input.source.currency,
        status: "SUCCEEDED",
        providerReference: input.providerReference,
        idempotencyKey: input.key,
        metadata: {
          sourceType: input.source.type,
          sourceTransactionId: String(input.source._id),
          ...input.metadata,
        },
      });
      return { row, created: true };
    } catch (error) {
      const raced = await ledger.findByIdempotencyKey(input.key);
      if (!raced) throw error;
      return { row: verify(raced), created: false };
    }
  }

  // --- Processing-fee backstop ------------------------------------------------------------

  /** Succeeded principals whose processing fee a lost/failed webhook never recorded: the exact
   * provider fee through the shared processing-fee path (never estimated, never duplicated). */
  public async reconcileMissingProcessingFees(
    limit: number,
  ): Promise<{ recorded: number; errors: number }> {
    const now = Date.now();
    const candidates =
      await this.deps.financialTransactionService.listPrincipalRowsMissingProcessingFee({
        createdAfter: new Date(now - this.options.processingFeeLookbackMs),
        createdBefore: new Date(now - this.options.processingFeeMinAgeMs),
        limit,
      });
    let recorded = 0;
    let errors = 0;
    for (const row of candidates) {
      if (!row.providerReference) continue;
      try {
        const outcome = await ensureProcessingFeeAccounting(
          row,
          { paymentIntentId: row.providerReference, paymentIntentCurrency: row.currency },
          this.deps.gateway,
          this.deps.financialTransactionService,
        );
        if (outcome === "RECORDED") recorded += 1;
      } catch (error) {
        if (error instanceof ProcessingFeeUnavailableError) continue;
        errors += 1;
        if (error instanceof ProcessingFeeCurrencyMismatchError) {
          logger.error(
            { err: error, transactionId: String(row._id) },
            "Processing fee needs investigation",
          );
        }
      }
    }
    return { recorded, errors };
  }

  // --- Backstop ---------------------------------------------------------------------------

  /** The MoneyRecovery backstop: re-reads open/uncorrelated disputes, periodically sweeps recent
   * provider disputes/refunds (bounded windows), and recovers missing processing fees. Every
   * step is idempotent with the webhook path; each item is isolated. */
  public async runBackstop(limit: number): Promise<{
    disputesResynced: number;
    disputesSwept: number;
    refundsSwept: number;
    processingFeesRecorded: number;
    errors: number;
  }> {
    let errors = 0;
    const now = Date.now();
    let disputesResynced = 0;
    const due = await this.deps.disputes.listDueForResync(
      limit,
      new Date(now - this.options.resyncAfterMs),
      new Date(now - this.options.disputeLookbackMs),
    );
    for (const dispute of due) {
      try {
        await this.syncDispute(dispute.providerDisputeId, "POLLING");
        disputesResynced += 1;
      } catch (error) {
        errors += 1;
        logger.warn({ err: error, disputeId: dispute.providerDisputeId }, "Dispute resync failed");
      }
    }

    let disputesSwept = 0;
    let refundsSwept = 0;
    if (this.lastSweepAt === undefined || now - this.lastSweepAt >= this.options.sweepIntervalMs) {
      this.lastSweepAt = now;
      const swept = await this.sweepProviderReversals(now);
      disputesSwept = swept.disputes;
      refundsSwept = swept.refunds;
      errors += swept.errors;
    }

    const fees = await this.reconcileMissingProcessingFees(limit);
    errors += fees.errors;
    return {
      disputesResynced,
      disputesSwept,
      refundsSwept,
      processingFeesRecorded: fees.recorded,
      errors,
    };
  }

  /** Bounded, time-windowed provider listing — recovers disputes/refunds whose webhook never
   * arrived or permanently failed. Restricted to recent objects; each is reconciled against the
   * locally known PaymentIntent identity before any accounting. */
  public async sweepProviderReversals(
    now = Date.now(),
  ): Promise<{ disputes: number; refunds: number; errors: number }> {
    let disputes = 0;
    let refunds = 0;
    let errors = 0;
    if (this.deps.gateway.listDisputesCreatedSince) {
      try {
        const listed = await this.deps.gateway.listDisputesCreatedSince(
          new Date(now - this.options.disputeLookbackMs),
          this.options.disputeSweepMax,
        );
        for (const snapshot of listed) {
          try {
            await this.applyDisputeSnapshot(snapshot, "POLLING");
            disputes += 1;
          } catch (error) {
            errors += 1;
            logger.warn({ err: error, disputeId: snapshot.disputeId }, "Dispute sweep item failed");
          }
        }
      } catch (error) {
        errors += 1;
        logger.warn({ err: error }, "Dispute sweep listing failed");
      }
    }
    if (this.deps.gateway.listRefundsCreatedSince) {
      try {
        const listed = await this.deps.gateway.listRefundsCreatedSince(
          new Date(now - this.options.refundLookbackMs),
          this.options.refundSweepMax,
        );
        for (const refund of listed) {
          try {
            await this.ingestProviderRefund(refund, "POLLING");
            refunds += 1;
          } catch (error) {
            errors += 1;
            logger.warn({ err: error, refundId: refund.refundId }, "Refund sweep item failed");
          }
        }
      } catch (error) {
        errors += 1;
        logger.warn({ err: error }, "Refund sweep listing failed");
      }
    }
    return { disputes, refunds, errors };
  }

  // --- Support alerts ---------------------------------------------------------------------

  /** A Stripe webhook event reached the terminal FAILED state (money may be affected). */
  public async alertWebhookFailed(input: {
    eventId: string;
    type: string;
    error?: string | undefined;
    providerObjectId?: string | undefined;
    replayCount: number;
  }): Promise<void> {
    await this.support({
      kind: "WEBHOOK_FAILED",
      identity: `${input.eventId}:${input.replayCount}`,
      providerReference: input.providerObjectId ?? input.eventId,
      detail: `${input.type} (${input.eventId}): ${input.error ?? "unknown error"}`,
    });
  }

  private async support(alert: SupportAlertInput): Promise<void> {
    await this.deps.notifier?.notifySupport(alert);
  }
}

const sum = (
  rows: BookingFinancialTransactionDocument[],
  predicate: (row: BookingFinancialTransactionDocument) => boolean,
): number => rows.filter(predicate).reduce((total, row) => total + row.amountCents, 0);
