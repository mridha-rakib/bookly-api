import mongoose, { type Types } from "mongoose";
import { BookingModel } from "../booking/booking.model.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BusinessModel } from "../business/business.model.js";
import { EmailOutboxModel } from "../email-outbox/email-outbox.model.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import {
  buildEmailDedupeKey,
  normalizeEmailRecipient,
} from "../email-outbox/email-outbox.types.js";
import { BookingCancelledNotifier } from "../notification/booking-cancelled.notifier.js";
import { normalizeRecipient } from "../notification/notification-recipients.js";
import { UserRepository } from "../user/user.repository.js";
import { PaymentAttemptModel } from "./payment-attempt.model.js";
import { RefundOperationModel } from "./refund-operation.model.js";

/**
 * An exact-event recovery step for new, opt-in ordinary Business cancellation refunds.
 * The provider and ledger settle in existing paths. Once their durable facts agree, the
 * existing EmailOutbox intent and the RefundOperation marker commit in one transaction.
 * Any crash before that transaction leaves the operation discoverable for money recovery.
 * No provider call, historical promotion, email delivery, or new queue occurs here.
 */
export async function ensureBusinessRefundNotification(
  operationId: Types.ObjectId | string,
): Promise<"NOT_APPLICABLE" | "ALREADY_RECORDED" | "RECORDED" | "NOT_READY"> {
  const session = await mongoose.startSession();
  let result: "NOT_APPLICABLE" | "ALREADY_RECORDED" | "RECORDED" | "NOT_READY" = "NOT_READY";
  try {
    await session.withTransaction(
      async () => {
        const operation = await RefundOperationModel.findById(operationId).session(session).exec();
        if (
          !operation ||
          operation.finalNotificationProtocolVersion !== 1 ||
          operation.reason !== "BUSINESS_CANCELLATION" ||
          operation.packageProgressId
        ) {
          result = "NOT_APPLICABLE";
          return;
        }
        if (operation.finalNotificationRecordedAt) {
          result = "ALREADY_RECORDED";
          return;
        }
        if (
          !operation.bookingId ||
          !operation.businessId ||
          !operation.customerUserId ||
          !operation.businessClientId ||
          !operation.sourceFinancialTransactionId ||
          operation.logicalIdempotencyKey !==
            `business-cancel-refund:${String(operation.bookingId)}` ||
          !operation.providerRefundId ||
          !["SUCCEEDED", "FAILED"].includes(operation.providerStatus)
        ) {
          result = "NOT_READY";
          return;
        }
        const booking = await BookingModel.findOne({
          _id: operation.bookingId,
          businessId: operation.businessId,
          "customer.customerUserId": operation.customerUserId,
          "customer.businessClientId": operation.businessClientId,
          status: "CANCELLED_BY_BUSINESS",
          "cancellationOutcome.settlementStatus": operation.providerStatus,
          "cancellationOutcome.settlementProviderReference": operation.providerRefundId,
          "cancellationOutcome.refundOwedCents": operation.expectedRefundAmountCents,
        })
          .session(session)
          .exec();
        if (
          !booking ||
          !normalizeRecipient(booking.customer.contact.normalizedEmail) ||
          booking.serviceLines.some(
            (line) =>
              line.pricingInput?.packageProgressId ||
              line.pricingInput?.packageItemId ||
              line.packageContext,
          )
        ) {
          result = "NOT_READY";
          return;
        }
        const business = await BusinessModel.findById(operation.businessId).session(session).exec();
        const source = await BookingFinancialTransactionModel.findOne({
          _id: operation.sourceFinancialTransactionId,
          bookingId: booking._id,
          businessId: booking.businessId,
          businessClientId: operation.businessClientId,
          customerUserId: operation.customerUserId,
          type: { $in: ["PLATFORM_FEE", "DEPOSIT"] },
          status: "SUCCEEDED",
          amountCents: operation.expectedRefundAmountCents,
          currency: operation.currency,
          providerReference: operation.sourcePaymentIntentId,
        })
          .session(session)
          .exec();
        const attempt = await PaymentAttemptModel.findOne({
          providerPaymentIntentId: operation.sourcePaymentIntentId,
          bookingId: booking._id,
          businessId: booking.businessId,
          businessClientId: operation.businessClientId,
          customerUserId: operation.customerUserId,
          purpose: "BOOKING_DEPOSIT",
          productKind: "NORMAL_BOOKING",
          providerStatus: "SUCCEEDED",
          persistenceStatus: "COMPLETED",
          compensationStatus: "NOT_REQUIRED",
          succeededTransactionId: source?._id,
        })
          .session(session)
          .exec();
        if (!business || !source || !attempt) {
          result = "NOT_READY";
          return;
        }
        if (operation.providerStatus === "SUCCEEDED") {
          if (!operation.succeededLedgerTransactionId) {
            result = "NOT_READY";
            return;
          }
          const refundLedger = await BookingFinancialTransactionModel.findOne({
            _id: operation.succeededLedgerTransactionId,
            bookingId: booking._id,
            businessId: booking.businessId,
            businessClientId: operation.businessClientId,
            customerUserId: operation.customerUserId,
            type: "REFUND",
            direction: "CREDIT",
            status: "SUCCEEDED",
            amountCents: operation.expectedRefundAmountCents,
            currency: operation.currency,
            providerReference: operation.providerRefundId,
            idempotencyKey: `refund-operation:${String(operation._id)}:ledger`,
            "metadata.sourceTransactionId": String(source._id),
            "metadata.sourceType": source.type,
          })
            .session(session)
            .exec();
          if (!refundLedger) {
            result = "NOT_READY";
            return;
          }
        }
        const status = operation.providerStatus as "SUCCEEDED" | "FAILED";
        const eventKey = `BUSINESS_REFUND:${String(booking._id)}:${String(operation._id)}:${status}`;
        // The notifier propagates transactional enqueue failure, so the marker cannot commit
        // without the exact outbox row. Provider delivery happens later in the existing worker.
        await new BookingCancelledNotifier(
          new EmailOutboxService(),
          new UserRepository(),
        ).notifyBookingCancelled(
          booking,
          business,
          "BUSINESS",
          {
            succeeded: status === "SUCCEEDED",
            amountCents: operation.expectedRefundAmountCents,
            status,
          },
          eventKey,
          session,
        );
        // The notifier may skip a recipient without throwing. The marker means "the Customer's
        // exact intent exists", so confirm that row inside this same transaction first.
        const customerDedupeKey = buildEmailDedupeKey(
          eventKey,
          "BOOKING_CANCELLED_CUSTOMER",
          normalizeEmailRecipient(booking.customer.contact.normalizedEmail),
        );
        if (!(await EmailOutboxModel.exists({ dedupeKey: customerDedupeKey }).session(session)))
          throw new Error("Refund notification outbox intent was not established");
        const marked = await RefundOperationModel.updateOne(
          {
            _id: operation._id,
            finalNotificationProtocolVersion: 1,
            finalNotificationRecordedAt: { $exists: false },
            providerStatus: status,
            providerRefundId: operation.providerRefundId,
          },
          { $set: { finalNotificationRecordedAt: new Date() } },
          { session },
        ).exec();
        if (marked.modifiedCount !== 1)
          throw new Error("Refund notification marker lost exact CAS");
        result = "RECORDED";
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Recovery-only completion of the Booking settlement projection for an opted-in operation.
 * The request, webhook and refund-recovery paths already write this exact projection after a
 * definitive provider result. A crash between the RefundOperation write and that Booking write
 * would otherwise leave a definitive FAILED result unprojected forever, because FAILED rows are
 * not part of `listRecoverable`. It writes only a PENDING Booking with exact identity and amount,
 * never overwrites another settlement or provider reference, and makes no provider call.
 */
export async function convergeBusinessRefundSettlementProjection(
  operationId: Types.ObjectId | string,
): Promise<boolean> {
  const operation = await RefundOperationModel.findById(operationId).exec();
  if (
    !operation ||
    operation.finalNotificationProtocolVersion !== 1 ||
    operation.finalNotificationRecordedAt ||
    operation.reason !== "BUSINESS_CANCELLATION" ||
    operation.packageProgressId ||
    !operation.bookingId ||
    !operation.businessId ||
    !operation.customerUserId ||
    !operation.businessClientId ||
    !operation.providerRefundId ||
    operation.logicalIdempotencyKey !== `business-cancel-refund:${String(operation.bookingId)}`
  )
    return false;
  const status = operation.providerStatus;
  if (status !== "FAILED" && !(status === "SUCCEEDED" && operation.succeededLedgerTransactionId))
    return false;
  const updated = await BookingModel.updateOne(
    {
      _id: operation.bookingId,
      businessId: operation.businessId,
      "customer.customerUserId": operation.customerUserId,
      "customer.businessClientId": operation.businessClientId,
      status: "CANCELLED_BY_BUSINESS",
      "cancellationOutcome.settlementStatus": "PENDING",
      "cancellationOutcome.refundOwedCents": operation.expectedRefundAmountCents,
      $or: [
        { "cancellationOutcome.settlementProviderReference": { $exists: false } },
        { "cancellationOutcome.settlementProviderReference": operation.providerRefundId },
      ],
    },
    {
      $set: {
        "cancellationOutcome.settlementStatus": status,
        "cancellationOutcome.settlementProviderReference": operation.providerRefundId,
      },
    },
    { runValidators: true },
  ).exec();
  return updated.modifiedCount === 1;
}
