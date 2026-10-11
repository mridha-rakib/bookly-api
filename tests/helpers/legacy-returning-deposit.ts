import { Types } from "mongoose";

import { type BookingDocument, BookingModel } from "../../src/modules/booking/booking.model.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentService } from "../../src/modules/payment/payment.service.js";
import { buildPaymentIntentMetadata } from "../../src/modules/payment/payment-intent-metadata.js";

/** The legacy (pre-P3) RETURNING deposit formula: clamp(20%, €5, €35) of the eligible basis. */
export const legacyReturningDepositCents = (eligibleBasisCents: number): number =>
  Math.min(Math.max(Math.round(eligibleBasisCents * 0.2), 500), 3500);

/**
 * TEST-ONLY — turns a freshly created P3 RETURNING booking (€0 online) into the exact durable
 * state a PRE-P3 RETURNING booking has: a real Business-owned DEPOSIT charge. Since P3 no new
 * purchase ever writes a DEPOSIT row, but historical DEPOSIT rows must stay readable and keep
 * driving cancellation/no-show netting, business-cancellation refunds, payout and finance —
 * this is how those legacy paths stay covered.
 *
 * Every write goes through the real services (no hand-built ledger documents):
 *  1. a genuine PaymentIntent + durable PaymentAttempt via PaymentService.chargeBookingDeposit
 *     (RETURNING correlation, the booking's own id/business/client in the PI metadata);
 *  2. the DEPOSIT ledger row via BookingFinancialTransactionService.record, referencing that PI;
 *  3. the attempt's persistence completed under its own lease (so P0 recovery never mistakes it
 *     for an orphan to compensate);
 *  4. the booking's snapshot rewritten to its legacy shape: depositCents > 0,
 *     balanceDueCents = totalCents − depositCents, and the frozen contract's upfront = deposit.
 */
export const seedLegacyReturningDeposit = async (
  services: {
    paymentService: PaymentService;
    financialTransactionService: BookingFinancialTransactionService;
  },
  booking: BookingDocument,
  depositCents = legacyReturningDepositCents(booking.financials.eligiblePlatformFeeBasisCents),
): Promise<{ booking: BookingDocument; depositCents: number; paymentIntentId: string }> => {
  if (
    booking.financials.depositCents !== 0 ||
    booking.financialContract?.classification !== "RETURNING"
  ) {
    throw new Error("seedLegacyReturningDeposit expects a P3 RETURNING booking (€0 online)");
  }
  if (depositCents <= 0 || depositCents > booking.financials.totalCents) {
    throw new Error("A legacy RETURNING deposit must be positive and within the booking total");
  }
  const customerUserId = booking.customer.customerUserId;
  if (!customerUserId) throw new Error("A customer booking always has a customerUserId");

  const contract = booking.financialContract;
  const idempotencyKey = `legacy-returning-deposit:${String(booking._id)}`;
  const charge = await services.paymentService.chargeBookingDeposit({
    userId: customerUserId,
    amountCents: depositCents,
    idempotencyKey,
    metadata: buildPaymentIntentMetadata({
      bookingId: String(booking._id),
      businessId: String(booking.businessId),
      businessClientId: String(booking.customer.businessClientId),
      purpose: contract.productKind === "PACKAGE_PURCHASE" ? "PACKAGE_PURCHASE" : "BOOKING_DEPOSIT",
      preTaxChargeCents: depositCents,
      taxCents: 0,
      chargedAmountCents: depositCents,
      taxMode: "PRE_ACTIVATION",
      financialContract: {
        version: contract.version,
        classification: "RETURNING",
        productKind: contract.productKind,
      },
    }),
    financialContract: {
      version: contract.version,
      classification: "RETURNING",
      productKind: contract.productKind,
      businessClientId: booking.customer.businessClientId,
    },
  });
  if (charge.status !== "succeeded") throw new Error(`legacy deposit charge ${charge.status}`);

  const ledger = await services.financialTransactionService.record({
    businessId: booking.businessId,
    bookingId: booking._id,
    businessClientId: booking.customer.businessClientId,
    customerUserId,
    type: "DEPOSIT",
    direction: "DEBIT",
    amountCents: depositCents,
    currency: "EUR",
    status: "SUCCEEDED",
    providerReference: charge.paymentIntentId,
    idempotencyKey: `${idempotencyKey}:deposit`,
  });

  const lease = await services.paymentService.claimPaymentPersistence(charge.paymentAttemptId);
  if (!lease) throw new Error("Could not claim the legacy deposit attempt's persistence lease");
  const completed = await services.paymentService.markPaymentCompleted(
    charge.paymentAttemptId,
    { bookingId: booking._id, succeededTransactionId: ledger._id },
    lease,
  );
  if (!completed) throw new Error("Could not complete the legacy deposit attempt");

  await BookingModel.collection.updateOne(
    { _id: new Types.ObjectId(String(booking._id)) },
    {
      $set: {
        "financials.depositCents": depositCents,
        "financials.balanceDueCents": booking.financials.totalCents - depositCents,
        "financialContract.requiredUpfrontCents": depositCents,
        "financialContract.onlineChargeCents": depositCents,
      },
    },
  );
  const seeded = await BookingModel.findById(booking._id).orFail().exec();
  return { booking: seeded, depositCents, paymentIntentId: charge.paymentIntentId };
};
