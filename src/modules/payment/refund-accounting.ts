import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { RefundOperationDocument } from "./refund-operation.model.js";
import type { RefundOperationRepository } from "./refund-operation.repository.js";

/** Shared accounting projection of an existing, confirmed RefundOperation. No provider calls. */
export async function ensureRefundAccounting(
  operation: RefundOperationDocument,
  financials: BookingFinancialTransactionService,
  refunds: RefundOperationRepository,
) {
  if (operation.providerStatus !== "SUCCEEDED" || !operation.providerRefundId)
    throw new Error("Refund is not confirmed");
  if (!operation.bookingId || !operation.businessId || !operation.businessClientId) return;
  const key = `refund-operation:${String(operation._id)}:ledger`;
  const sources = await financials.listForBooking(operation.bookingId);
  const source = sources.find(
    (row) => String(row._id) === String(operation.sourceFinancialTransactionId),
  );
  if (operation.sourceFinancialTransactionId && !source)
    throw new Error("Refund source ledger is missing");
  let ledger = await financials.findByIdempotencyKey(key);
  if (!ledger) {
    try {
      ledger = await financials.record({
        businessId: operation.businessId,
        bookingId: operation.bookingId,
        businessClientId: operation.businessClientId,
        ...(operation.customerUserId ? { customerUserId: operation.customerUserId } : {}),
        type: "REFUND",
        direction: "CREDIT",
        amountCents: operation.expectedRefundAmountCents,
        currency: operation.currency as "EUR",
        status: "SUCCEEDED",
        providerReference: operation.providerRefundId,
        idempotencyKey: key,
        metadata: {
          sourceType: source?.type ?? "COMPENSATION",
          ...(source ? { sourceTransactionId: String(source._id) } : {}),
        },
      });
    } catch (error) {
      ledger = await financials.findByIdempotencyKey(key);
      if (!ledger) throw error;
    }
  }
  if (
    ledger.type !== "REFUND" ||
    ledger.direction !== "CREDIT" ||
    ledger.amountCents !== operation.expectedRefundAmountCents ||
    ledger.currency !== operation.currency ||
    String(ledger.bookingId) !== String(operation.bookingId) ||
    String(ledger.businessId) !== String(operation.businessId) ||
    String(ledger.businessClientId) !== String(operation.businessClientId) ||
    String(ledger.customerUserId ?? "") !== String(operation.customerUserId ?? "") ||
    (ledger.providerReference && ledger.providerReference !== operation.providerRefundId) ||
    (source &&
      (ledger.metadata?.["sourceTransactionId"] !== String(source._id) ||
        ledger.metadata?.["sourceType"] !== source.type))
  )
    throw new Error("Refund ledger correlation mismatch");
  const confirmed = await financials.confirmRefund(ledger._id, operation.providerRefundId);
  if (!confirmed || confirmed.status !== "SUCCEEDED")
    throw new Error("Refund accounting is not succeeded");
  await refunds.markLedgerSucceeded(operation._id, confirmed._id);
  return confirmed;
}
