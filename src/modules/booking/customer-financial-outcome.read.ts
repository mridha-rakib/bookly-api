import mongoose, { Types } from "mongoose";
import { logger } from "../../config/logger.js";
import {
  type BookingFinancialTransactionDocument,
  BookingFinancialTransactionModel,
} from "../booking-financial-transaction/booking-financial-transaction.model.js";
import {
  type PaymentAttemptDocument,
  PaymentAttemptModel,
} from "../payment/payment-attempt.model.js";
import { parsePenaltyAttemptKey } from "../payment/penalty-attempt.js";
import {
  type RefundOperationDocument,
  RefundOperationModel,
} from "../payment/refund-operation.model.js";
import {
  type ExternalRefundDocument,
  ExternalRefundModel,
} from "../provider-reversal/external-refund.model.js";
import {
  type PaymentDisputeDocument,
  PaymentDisputeModel,
} from "../provider-reversal/payment-dispute.model.js";
import { BookingError } from "./booking.errors.js";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import type { CustomerFinancialOutcomeDto } from "./customer-financial-outcome.dto.js";
import {
  FINANCIAL_READ_LIMIT,
  projectCustomerFinancialOutcome,
} from "./customer-financial-outcome.projection.js";

const sort = { createdAt: -1, _id: -1 } as const;
const windowSize = FINANCIAL_READ_LIMIT + 1;
const objectIds = (values: unknown[]) =>
  [
    ...new Set(
      values
        .filter((value) => value != null)
        .map(String)
        .filter((value) => Types.ObjectId.isValid(value)),
    ),
  ].map((value) => new Types.ObjectId(value));

/** Customer detail only. Snapshot SELECTs; no financial command/provider dependency. */
export class CustomerFinancialOutcomeRead {
  public async forOwnedBooking(
    userId: string,
    original: BookingDocument,
  ): Promise<{
    booking: BookingDocument;
    financialOutcome?: CustomerFinancialOutcomeDto;
  }> {
    if (String(original.customer.customerUserId) !== userId)
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    if (
      original.source !== "BOOKLY_MANAGED" ||
      original.serviceLines.some(
        (line) =>
          line.serviceSnapshot.pricingMode === "PACKAGE" ||
          Boolean(line.pricingInput.packageItemId || line.pricingInput.packageProgressId),
      )
    )
      return { booking: original };
    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction(
        async () => {
          const booking = await BookingModel.findOne({
            _id: original._id,
            "customer.customerUserId": userId,
          }).session(session);
          if (!booking) throw new BookingError("BOOKING_NOT_FOUND", 404);
          const asOf = new Date();
          const scope = { bookingId: booking._id };
          // Sequential reads: MongoDB transactions do not support parallel operations on a session.
          // Hints fail closed if trusted deployment has not provisioned the approved indexes.
          const payments = await PaymentAttemptModel.find(scope)
            .sort(sort)
            .hint(sortIndex)
            .limit(windowSize)
            .session(session)
            .lean<PaymentAttemptDocument[]>();
          const refunds = await RefundOperationModel.find(scope)
            .sort(sort)
            .hint(sortIndex)
            .limit(windowSize)
            .session(session)
            .lean<RefundOperationDocument[]>();
          const externalRefunds = await ExternalRefundModel.find(scope)
            .sort(sort)
            .hint(sortIndex)
            .limit(windowSize)
            .session(session)
            .lean<ExternalRefundDocument[]>();
          const disputes = await PaymentDisputeModel.find(scope)
            .sort(sort)
            .hint(sortIndex)
            .limit(windowSize)
            .session(session)
            .lean<PaymentDisputeDocument[]>();
          const relatedIds = objectIds(refunds.map((row) => row.sourcePaymentAttemptId));
          const relatedAttempts = relatedIds.length
            ? await PaymentAttemptModel.find({ _id: { $in: relatedIds } })
                .hint({ _id: 1 })
                .limit(relatedIds.length)
                .session(session)
                .lean<PaymentAttemptDocument[]>()
            : [];
          const ids = objectIds([
            ...payments.flatMap((row) => [
              row.succeededTransactionId,
              parsePenaltyAttemptKey(row.logicalIdempotencyKey),
            ]),
            ...relatedAttempts.map((row) => row.succeededTransactionId),
            ...refunds.flatMap((row) => [
              row.sourceFinancialTransactionId,
              row.succeededLedgerTransactionId,
            ]),
            ...externalRefunds.flatMap((row) => [row.sourceTransactionId, row.ledgerTransactionId]),
            ...disputes.map((row) => row.sourceTransactionId),
          ]);
          const ledger = ids.length
            ? await BookingFinancialTransactionModel.find({ _id: { $in: ids } })
                .hint({ _id: 1 })
                .limit(ids.length)
                .session(session)
                .lean<BookingFinancialTransactionDocument[]>()
            : [];
          const keys = refunds.map((row) => `refund-operation:${String(row._id)}:ledger`);
          const refundLedger = keys.length
            ? await BookingFinancialTransactionModel.find({ idempotencyKey: { $in: keys } })
                .hint({ idempotencyKey: 1 })
                .limit(keys.length)
                .session(session)
                .lean<BookingFinancialTransactionDocument[]>()
            : [];
          const providerIds = [...new Set(externalRefunds.map((row) => row.providerRefundId))];
          // Unique partial index requires an explicit string condition to prove index eligibility.
          const duplicateRefunds = providerIds.length
            ? await RefundOperationModel.find({
                providerRefundId: { $in: providerIds, $type: "string" },
              })
                .hint({ providerRefundId: 1 })
                .limit(providerIds.length)
                .session(session)
                .lean<RefundOperationDocument[]>()
            : [];
          const financialOutcome = projectCustomerFinancialOutcome(
            booking,
            userId,
            {
              payments,
              refunds,
              externalRefunds,
              disputes,
              relatedAttempts,
              duplicateRefunds,
              ledger: [
                ...new Map(
                  [...ledger, ...refundLedger].map((row) => [String(row._id), row]),
                ).values(),
              ],
            },
            asOf,
          );
          return { booking, ...(financialOutcome ? { financialOutcome } : {}) };
        },
        { readConcern: { level: "snapshot" } },
      );
      return result ?? { booking: original };
    } catch (error) {
      if (error instanceof BookingError) throw error;
      // Missing index/read failure never becomes a fake empty history or fails the Booking read.
      logger.warn(
        { category: "CUSTOMER_FINANCIAL_READ_UNAVAILABLE" },
        "Customer financial projection unavailable",
      );
      return { booking: original };
    } finally {
      await session.endSession();
    }
  }
}

const sortIndex = { bookingId: 1, createdAt: -1, _id: -1 } as const;
