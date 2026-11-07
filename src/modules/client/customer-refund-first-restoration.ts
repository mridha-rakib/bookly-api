import type { ClientSession, Types } from "mongoose";

import { type BookingDocument, BookingModel } from "../booking/booking.model.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { NORMAL_CANCELLATION_TERMS_VERSION } from "../business-cancellation-policy/cancellation-terms.js";
import { PackageProgressModel } from "../package-progress/package-progress.model.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { RefundOperationModel } from "../payment/refund-operation.model.js";
import { BusinessClientModel } from "./client.model.js";

/** RefundOperation / relationship release reason for the approved v2 customer refund. */
export const CUSTOMER_EARLY_CANCELLATION = "CUSTOMER_EARLY_CANCELLATION" as const;

export type CustomerFirstRestoration =
  | "RESTORED"
  | "ALREADY_RESTORED"
  | "NOT_APPLICABLE"
  | "NOT_ELIGIBLE"
  | "NOT_READY";

const STATE = "financialRelationship.state";
const REVISION = "financialRelationship.revision";

/**
 * Owner-approved rule (2026-11-05): when a Customer cancels the Normal Booking that consumed
 * their FIRST relationship with this Business more than 24 h ahead (cancellation terms v2) and
 * the deposit they actually paid has been refunded IN FULL, the relationship returns to
 * ELIGIBLE — but only if no other qualifying Booking or Package purchase exists for this same
 * Customer–Business relationship (`BusinessClient`, which is already per Business).
 *
 * Never on submission and never while a refund is pending: the paid path is evaluated only from
 * a SUCCEEDED RefundOperation whose REFUND ledger row exists. A €0 FIRST booking (nothing was
 * charged) is evaluated at cancellation, as the existing Business-cancellation contract does.
 *
 * Retry-safe: the only write is a CAS on the relationship's state + revision + the exact
 * consumed Booking, and a release already recorded for this refund reports ALREADY_RESTORED.
 * A RETURNING booking is €0 online and never writes the relationship, so after restoring the
 * qualifying-history check runs again and the restoration is reverted if a concurrent booking
 * committed in between.
 */
export async function restoreFirstAfterCustomerCancellation(input: {
  bookingId: Types.ObjectId;
  refundOperationId?: Types.ObjectId | undefined;
  session?: ClientSession | undefined;
}): Promise<CustomerFirstRestoration> {
  const { session } = input;
  const booking = await BookingModel.findById(input.bookingId)
    .session(session ?? null)
    .exec();
  const contract = booking?.financialContract;
  if (
    !booking ||
    !contract ||
    contract.classification !== "FIRST" ||
    contract.productKind !== "NORMAL_BOOKING" ||
    booking.status !== "CANCELLED_BY_CUSTOMER" ||
    booking.cancellationTermsVersion !== NORMAL_CANCELLATION_TERMS_VERSION ||
    booking.cancellationOutcome?.tier !== "MORE_THAN_24_HOURS" ||
    booking.source === "MANUAL" ||
    booking.serviceLines.some((line) => line.pricingInput?.packageProgressId || line.packageContext)
  )
    return "NOT_APPLICABLE";

  let refundOperationId: Types.ObjectId | undefined;
  if (contract.onlineChargeCents > 0) {
    if (!input.refundOperationId) return "NOT_READY";
    const evidence = await refundEvidence(booking, input.refundOperationId, session);
    if (evidence !== "OK") return evidence;
    refundOperationId = input.refundOperationId;
  } else if (input.refundOperationId) return "NOT_APPLICABLE";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await BusinessClientModel.findById(contract.businessClientId)
      .session(session ?? null)
      .exec();
    const relationship = row?.financialRelationship;
    if (!row || !relationship) return "NOT_APPLICABLE";
    if (
      relationship.state === "ELIGIBLE" &&
      relationship.lastRelease?.reason === CUSTOMER_EARLY_CANCELLATION &&
      relationship.lastRelease.idempotencyKey === contract.idempotencyKey
    )
      return "ALREADY_RESTORED";
    const consumed = relationship.consumed;
    if (
      relationship.state !== "CONSUMED" ||
      !consumed ||
      !consumed.bookingId.equals(booking._id) ||
      consumed.idempotencyKey !== contract.idempotencyKey ||
      consumed.productKind !== "NORMAL_BOOKING" ||
      !row.businessId.equals(contract.businessId) ||
      !row.businessId.equals(booking.businessId) ||
      !row.linkedUserId?.equals(contract.customerUserId)
    )
      return "NOT_APPLICABLE";
    if (await hasOtherQualifyingHistory(row._id, booking._id, session)) return "NOT_ELIGIBLE";

    const restored = await BusinessClientModel.updateOne(
      {
        _id: row._id,
        [STATE]: "CONSUMED",
        [REVISION]: relationship.revision,
        "financialRelationship.consumed.bookingId": booking._id,
        "financialRelationship.consumed.idempotencyKey": contract.idempotencyKey,
      },
      {
        $set: {
          [STATE]: "ELIGIBLE",
          "financialRelationship.stateChangedAt": new Date(),
          "financialRelationship.lastRelease": {
            idempotencyKey: contract.idempotencyKey,
            reason: CUSTOMER_EARLY_CANCELLATION,
            ...(refundOperationId ? { refundOperationId } : {}),
            releasedAt: new Date(),
          },
        },
        $inc: { [REVISION]: 1 },
      },
      session ? { session } : {},
    ).exec();
    if (restored.modifiedCount !== 1) continue;

    // A concurrent RETURNING booking does not touch the relationship; re-check after the write.
    if (await hasOtherQualifyingHistory(row._id, booking._id, session)) {
      await BusinessClientModel.updateOne(
        {
          _id: row._id,
          [STATE]: "ELIGIBLE",
          [REVISION]: relationship.revision + 1,
          "financialRelationship.lastRelease.reason": CUSTOMER_EARLY_CANCELLATION,
          "financialRelationship.lastRelease.idempotencyKey": contract.idempotencyKey,
        },
        {
          // Put back exactly the audit record that existed before this restoration.
          ...(relationship.lastRelease
            ? {
                $set: {
                  [STATE]: "CONSUMED",
                  "financialRelationship.stateChangedAt": new Date(),
                  "financialRelationship.lastRelease": relationship.lastRelease,
                },
              }
            : {
                $set: { [STATE]: "CONSUMED", "financialRelationship.stateChangedAt": new Date() },
                $unset: { "financialRelationship.lastRelease": 1 },
              }),
          $inc: { [REVISION]: 1 },
        },
        session ? { session } : {},
      ).exec();
      return "NOT_ELIGIBLE";
    }
    return "RESTORED";
  }
  return "NOT_READY";
}

/** The refund must be the exact, complete reversal of the FIRST deposit actually paid. */
async function refundEvidence(
  booking: BookingDocument,
  refundOperationId: Types.ObjectId,
  session: ClientSession | undefined,
): Promise<"OK" | "NOT_READY" | "NOT_APPLICABLE"> {
  const contract = booking.financialContract;
  const operation = await RefundOperationModel.findById(refundOperationId)
    .session(session ?? null)
    .exec();
  if (!contract || !operation?.sourceFinancialTransactionId) return "NOT_APPLICABLE";
  if (
    operation.reason !== CUSTOMER_EARLY_CANCELLATION ||
    operation.logicalIdempotencyKey !== `customer-cancel-refund:${String(booking._id)}` ||
    !operation.bookingId?.equals(booking._id) ||
    !operation.businessClientId?.equals(contract.businessClientId) ||
    operation.packageProgressId
  )
    return "NOT_APPLICABLE";
  // Pending or failed refunds never restore FIRST.
  if (
    operation.providerStatus !== "SUCCEEDED" ||
    !operation.succeededLedgerTransactionId ||
    !operation.providerRefundId
  )
    return "NOT_READY";
  const source = await BookingFinancialTransactionModel.findOne({
    _id: operation.sourceFinancialTransactionId,
    bookingId: booking._id,
    type: "PLATFORM_FEE",
    status: "SUCCEEDED",
    amountCents: contract.onlineChargeCents,
    idempotencyKey: `${contract.idempotencyKey}:deposit`,
    providerReference: operation.sourcePaymentIntentId,
  })
    .session(session ?? null)
    .exec();
  const ledger = await BookingFinancialTransactionModel.findOne({
    _id: operation.succeededLedgerTransactionId,
    bookingId: booking._id,
    type: "REFUND",
    direction: "CREDIT",
    status: "SUCCEEDED",
    amountCents: contract.onlineChargeCents,
    providerReference: operation.providerRefundId,
  })
    .session(session ?? null)
    .exec();
  if (
    !source ||
    !ledger ||
    operation.expectedRefundAmountCents !== contract.onlineChargeCents ||
    booking.cancellationOutcome?.refundOwedCents !== contract.onlineChargeCents
  )
    return "NOT_APPLICABLE";
  return "OK";
}

/**
 * Other qualifying history for this Customer–Business relationship: another customer Booking or
 * Package purchase origin carrying a financial contract that was not cancelled without service
 * (an upcoming, completed, late-cancelled or no-show Booking), or any Package (legacy or
 * First-Class) that has not been voided. MANUAL and Session 2+ Bookings never carry a contract.
 */
async function hasOtherQualifyingHistory(
  businessClientId: Types.ObjectId,
  bookingId: Types.ObjectId,
  session: ClientSession | undefined,
): Promise<boolean> {
  const [booking, legacyPackage, firstClassPackage] = await Promise.all([
    BookingModel.exists({
      "customer.businessClientId": businessClientId,
      _id: { $ne: bookingId },
      financialContract: { $exists: true },
      status: { $nin: ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS"] },
    }).session(session ?? null),
    PackageProgressModel.exists({ businessClientId, voidedAt: { $exists: false } }).session(
      session ?? null,
    ),
    PackageProgressV2Model.exists({ businessClientId, voidedAt: { $exists: false } }).session(
      session ?? null,
    ),
  ]);
  return Boolean(booking || legacyPackage || firstClassPackage);
}
