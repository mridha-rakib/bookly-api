import type { BookingFinancialTransactionDocument as Ledger } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import {
  type PaymentAttemptDocument as Attempt,
  paymentAttemptCompensationStatuses,
  paymentAttemptPersistenceStatuses,
  paymentAttemptProviderStatuses,
} from "../payment/payment-attempt.model.js";
import { parsePenaltyAttemptKey } from "../payment/penalty-attempt.js";
import {
  type RefundOperationDocument as Refund,
  refundOperationStatuses,
} from "../payment/refund-operation.model.js";
import type { ExternalRefundDocument as External } from "../provider-reversal/external-refund.model.js";
import type { PaymentDisputeDocument as Dispute } from "../provider-reversal/payment-dispute.model.js";
import type { BookingDocument } from "./booking.model.js";
import type { CustomerFinancialOutcomeDto as Dto } from "./customer-financial-outcome.dto.js";

export const FINANCIAL_READ_LIMIT = 20;
export type CustomerFinancialEvidence = {
  payments: Attempt[];
  refunds: Refund[];
  externalRefunds: External[];
  disputes: Dispute[];
  ledger: Ledger[];
  /** Exact unique-provider-id lookups, including operations outside the bounded window. */
  duplicateRefunds: Refund[];
  relatedAttempts: Attempt[];
};
const id = (value: unknown): string => (value == null ? "" : String(value));
const same = (a: unknown, b: unknown) => Boolean(id(a)) && id(a) === id(b);
const money = (value: number) => Number.isSafeInteger(value) && value > 0;
const iso = (value: Date | undefined) =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
const principalTypes = new Set(["PLATFORM_FEE", "DEPOSIT", "CANCELLATION_FEE", "NO_SHOW_FEE"]);

/** Pure allowlist projection. No provider access, state repair, financial aggregation or writes. */
export function projectCustomerFinancialOutcome(
  booking: BookingDocument,
  userId: string,
  evidence: CustomerFinancialEvidence,
  asOf: Date,
): Dto | undefined {
  if (
    !same(booking.customer.customerUserId, userId) ||
    booking.source !== "BOOKLY_MANAGED" ||
    booking.financials.currency !== "EUR" ||
    booking.serviceLines.some(
      (line) =>
        line.serviceSnapshot.pricingMode === "PACKAGE" ||
        Boolean(line.pricingInput.packageItemId || line.pricingInput.packageProgressId),
    )
  )
    return undefined;
  const scoped = (row: {
    bookingId?: unknown;
    businessId?: unknown;
    businessClientId?: unknown;
    customerUserId?: unknown;
    currency: string;
  }) =>
    same(row.bookingId, booking._id) &&
    same(row.businessId, booking.businessId) &&
    same(row.businessClientId, booking.customer.businessClientId) &&
    row.currency === booking.financials.currency &&
    (!row.customerUserId || same(row.customerUserId, userId));
  const ledger = new Map(evidence.ledger.filter(scoped).map((row) => [id(row._id), row]));
  // Explicit confirmation links may not disagree with the ledger's canonical operation key.
  // No net totals or cross-operation balance is computed from this bounded evidence window.
  const sourceFor = (sourceId: unknown, paymentIntentId: string | undefined) => {
    const source = ledger.get(id(sourceId));
    return source &&
      source.status === "SUCCEEDED" &&
      source.direction === "DEBIT" &&
      principalTypes.has(source.type) &&
      money(source.amountCents) &&
      paymentIntentId &&
      source.providerReference === paymentIntentId
      ? source
      : undefined;
  };
  const refundMatches = (
    row: Ledger | undefined,
    source: Ledger,
    amount: number,
    providerRefundId: string | undefined,
  ) =>
    Boolean(
      row &&
        row.type === "REFUND" &&
        row.direction === "CREDIT" &&
        row.amountCents === amount &&
        row.metadata?.["sourceType"] === source.type &&
        same(row.metadata?.["sourceTransactionId"], source._id) &&
        row.providerReference === providerRefundId,
    );
  const result: Dto = {
    currency: "EUR",
    asOf: asOf.toISOString(),
    payments: { items: [], hasMore: evidence.payments.length > FINANCIAL_READ_LIMIT },
    refunds: {
      items: [],
      hasMore:
        evidence.refunds.length > FINANCIAL_READ_LIMIT ||
        evidence.externalRefunds.length > FINANCIAL_READ_LIMIT,
    },
    disputes: { items: [], hasMore: evidence.disputes.length > FINANCIAL_READ_LIMIT },
  };

  for (const attempt of evidence.payments.slice(0, FINANCIAL_READ_LIMIT)) {
    if (
      !scoped(attempt) ||
      !same(attempt.customerUserId, userId) ||
      attempt.packageProgressId ||
      attempt.packageLifecycleBinding ||
      attempt.packageBatchBinding ||
      !money(attempt.expectedAmountCents)
    )
      continue;
    if (
      !paymentAttemptProviderStatuses.includes(attempt.providerStatus) ||
      !paymentAttemptPersistenceStatuses.includes(attempt.persistenceStatus) ||
      !paymentAttemptCompensationStatuses.includes(attempt.compensationStatus)
    )
      continue;
    const purposeType: Readonly<Record<string, string>> = {
      BOOKING_DEPOSIT: "",
      CANCELLATION_FEE: "CANCELLATION_FEE",
      NO_SHOW_FEE: "NO_SHOW_FEE",
    };
    if (!Object.hasOwn(purposeType, attempt.purpose)) continue;
    const penaltyId = parsePenaltyAttemptKey(attempt.logicalIdempotencyKey);
    const source = ledger.get(id(attempt.succeededTransactionId ?? penaltyId));
    // A pending/failed penalty attempt has canonical Booking/client identity but no succeeded row yet.
    // Legacy payment attempts lacking client correlation cannot enter this scoped projection.
    if (
      source &&
      (source.direction !== "DEBIT" ||
        !principalTypes.has(source.type) ||
        source.amountCents !== attempt.expectedAmountCents ||
        (source.providerReference &&
          source.providerReference !== attempt.providerPaymentIntentId) ||
        (purposeType[attempt.purpose] && source.type !== purposeType[attempt.purpose]))
    )
      continue;
    if (attempt.succeededTransactionId && !source) continue;
    if (
      attempt.purpose !== "BOOKING_DEPOSIT" &&
      (!penaltyId || !source || !same(source._id, penaltyId))
    )
      continue;
    if (attempt.purpose === "BOOKING_DEPOSIT") {
      const contract = booking.financialContract;
      if (
        !contract ||
        !same(contract.bookingId, booking._id) ||
        !same(contract.customerUserId, userId) ||
        !same(contract.businessId, booking.businessId) ||
        !same(contract.businessClientId, booking.customer.businessClientId) ||
        contract.productKind !== "NORMAL_BOOKING" ||
        contract.currency !== attempt.currency ||
        contract.idempotencyKey !== attempt.logicalIdempotencyKey ||
        contract.onlineChargeCents !== attempt.expectedAmountCents ||
        (attempt.financialContractVersion !== undefined &&
          attempt.financialContractVersion !== contract.version) ||
        (attempt.relationshipClassification !== undefined &&
          attempt.relationshipClassification !== contract.classification) ||
        (attempt.productKind !== undefined && attempt.productKind !== "NORMAL_BOOKING") ||
        (source && source.type !== contract.upfrontLedgerType)
      )
        continue;
    }
    if (
      (attempt.providerStatus !== "SUCCEEDED" && source?.status === "SUCCEEDED") ||
      (attempt.providerStatus === "SUCCEEDED" && source && source.status !== "SUCCEEDED")
    )
      continue;
    const providerConfirmed =
      attempt.providerStatus === "SUCCEEDED" &&
      Boolean(attempt.providerPaymentIntentId) &&
      Boolean(
        source &&
          source.status === "SUCCEEDED" &&
          source.providerReference === attempt.providerPaymentIntentId,
      );
    const observed = iso(attempt.lastReconciledAt);
    result.payments.items.push({
      id: id(attempt._id),
      providerStatus: attempt.providerStatus,
      persistenceStatus: attempt.persistenceStatus,
      compensationStatus: attempt.compensationStatus,
      amountCents: attempt.expectedAmountCents,
      providerConfirmed,
      accountingConfirmed: providerConfirmed && attempt.persistenceStatus === "COMPLETED",
      ...(observed ? { lastObservedAt: observed } : {}),
    });
  }

  const refunds: Array<{ item: Dto["refunds"]["items"][number]; createdAt: number; id: string }> =
    [];
  const seenRefunds = new Set<string>();
  for (const operation of evidence.refunds.slice(0, FINANCIAL_READ_LIMIT)) {
    if (
      !scoped(operation) ||
      operation.packageProgressId ||
      !money(operation.expectedRefundAmountCents) ||
      !refundOperationStatuses.includes(operation.providerStatus)
    )
      continue;
    const source = sourceFor(
      operation.sourceFinancialTransactionId,
      operation.sourcePaymentIntentId,
    );
    if (!source || operation.expectedRefundAmountCents > source.amountCents) continue;
    if (operation.sourcePaymentAttemptId) {
      const attempt = evidence.relatedAttempts.find((row) =>
        same(row._id, operation.sourcePaymentAttemptId),
      );
      if (
        !attempt ||
        !scoped(attempt) ||
        !same(attempt.customerUserId, userId) ||
        attempt.providerStatus !== "SUCCEEDED" ||
        attempt.providerPaymentIntentId !== operation.sourcePaymentIntentId ||
        attempt.expectedAmountCents !== source.amountCents ||
        !same(attempt.succeededTransactionId, source._id)
      )
        continue;
    }
    const row = operation.succeededLedgerTransactionId
      ? ledger.get(id(operation.succeededLedgerTransactionId))
      : evidence.ledger.find(
          (entry) =>
            scoped(entry) &&
            entry.idempotencyKey === `refund-operation:${id(operation._id)}:ledger`,
        );
    const keyedRow = evidence.ledger.find(
      (entry) => entry.idempotencyKey === `refund-operation:${id(operation._id)}:ledger`,
    );
    if (row && keyedRow && !same(row._id, keyedRow._id)) continue;
    if (row && row.idempotencyKey !== `refund-operation:${id(operation._id)}:ledger`) continue;
    if (operation.succeededLedgerTransactionId && !row) continue;
    if (
      row &&
      (!refundMatches(
        row,
        source,
        operation.expectedRefundAmountCents,
        operation.providerRefundId,
      ) ||
        (row.status === "SUCCEEDED" && operation.providerStatus !== "SUCCEEDED") ||
        (row.status === "FAILED" && operation.providerStatus === "SUCCEEDED"))
    )
      continue;
    if (operation.providerRefundId && seenRefunds.has(operation.providerRefundId)) continue;
    const providerConfirmed =
      operation.providerStatus === "SUCCEEDED" && Boolean(operation.providerRefundId);
    if (operation.providerRefundId) seenRefunds.add(operation.providerRefundId);
    const observed = iso(operation.lastReconciledAt);
    refunds.push({
      createdAt: operation.createdAt.getTime(),
      id: id(operation._id),
      item: {
        origin: "BOOKLY",
        id: id(operation._id),
        status: operation.providerStatus,
        amountCents: operation.expectedRefundAmountCents,
        providerCallStarted: Boolean(operation.providerCallStartedAt),
        providerConfirmed,
        accountingConfirmed: providerConfirmed && row?.status === "SUCCEEDED",
        ...(observed ? { lastObservedAt: observed } : {}),
      },
    });
  }
  for (const external of evidence.externalRefunds.slice(0, FINANCIAL_READ_LIMIT)) {
    if (
      !scoped(external) ||
      external.state !== "ACCOUNTED" ||
      external.investigationReason ||
      !money(external.amountCents) ||
      !external.providerRefundId ||
      seenRefunds.has(external.providerRefundId)
    )
      continue;
    // A duplicate/internal record outside this page must not reappear as an external refund.
    if (evidence.duplicateRefunds.some((row) => row.providerRefundId === external.providerRefundId))
      continue;
    const source = sourceFor(external.sourceTransactionId, external.providerPaymentIntentId);
    const row = ledger.get(id(external.ledgerTransactionId));
    if (
      !source ||
      source.type !== external.sourceType ||
      external.amountCents > source.amountCents ||
      !refundMatches(row, source, external.amountCents, external.providerRefundId) ||
      row?.status !== "SUCCEEDED" ||
      row.metadata?.["refundOrigin"] !== "PROVIDER_EXTERNAL"
    )
      continue;
    const created = iso(external.providerCreatedAt);
    seenRefunds.add(external.providerRefundId);
    refunds.push({
      createdAt: external.createdAt.getTime(),
      id: id(external._id),
      item: {
        origin: "PROVIDER_EXTERNAL",
        id: id(external._id),
        state: "ACCOUNTED",
        amountCents: external.amountCents,
        providerConfirmed: true,
        accountingConfirmed: true,
        ...(created ? { providerCreatedAt: created } : {}),
      },
    });
  }
  refunds.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  result.refunds.hasMore ||= refunds.length > FINANCIAL_READ_LIMIT;
  result.refunds.items = refunds.slice(0, FINANCIAL_READ_LIMIT).map((entry) => entry.item);
  for (const dispute of evidence.disputes.slice(0, FINANCIAL_READ_LIMIT)) {
    if (
      !scoped(dispute) ||
      dispute.correlation !== "CORRELATED" ||
      dispute.investigationReason ||
      !money(dispute.amountCents)
    )
      continue;
    const source = sourceFor(dispute.sourceTransactionId, dispute.providerPaymentIntentId);
    const observed = iso(dispute.lastSyncedAt);
    const finalOutcomes: Readonly<Record<string, string>> = {
      won: "WON",
      lost: "LOST",
      prevented: "PREVENTED",
      warning_closed: "WARNING_CLOSED",
    };
    if (
      !source ||
      source.type !== dispute.sourceType ||
      dispute.amountCents > source.amountCents ||
      !observed ||
      (dispute.final
        ? finalOutcomes[dispute.providerStatus] !== dispute.outcome
        : Boolean(dispute.outcome) || Object.hasOwn(finalOutcomes, dispute.providerStatus))
    )
      continue;
    result.disputes.items.push({
      id: id(dispute._id),
      providerStatus: dispute.providerStatus,
      final: dispute.final,
      ...(dispute.outcome ? { outcome: dispute.outcome } : {}),
      amountCents: dispute.amountCents,
      lastObservedAt: observed,
    });
  }
  return result;
}
