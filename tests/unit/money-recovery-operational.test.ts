import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { MoneyRecoveryService } from "../../src/modules/payment/money-recovery.service.js";
import type { PaymentService } from "../../src/modules/payment/payment.service.js";
import type { PaymentAttemptDocument } from "../../src/modules/payment/payment-attempt.model.js";
import type { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import type { RefundOperationRepository } from "../../src/modules/payment/refund-operation.repository.js";
import type { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";

const fixture = () => {
  const attempt = {
    _id: new Types.ObjectId(),
    bookingId: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    customerUserId: new Types.ObjectId(),
    logicalIdempotencyKey: "booking:synthetic-f3a",
    purpose: "BOOKING_DEPOSIT",
    providerStatus: "SUCCEEDED",
    expectedAmountCents: 2000,
    currency: "EUR",
    createdAt: new Date(Date.now() - 600_000),
    providerSucceededAt: new Date(Date.now() - 600_000),
  } as unknown as PaymentAttemptDocument;
  const snapshot = {
    status: "succeeded",
    paymentIntentId: "pi_synthetic_f3a",
    metadata: { businessClientId: String(new Types.ObjectId()) },
  };
  const payment = {
    reconcilePaymentAttempt: vi.fn(
      async (): Promise<{
        attempt: PaymentAttemptDocument;
        snapshot: typeof snapshot | null;
      }> => ({ attempt, snapshot }),
    ),
    claimPaymentPersistence: vi.fn(async (): Promise<string | null> => "synthetic-owner"),
    markPaymentCompleted: vi.fn(async () => undefined),
    claimPaymentCompensation: vi.fn(async () => true),
    refund: vi.fn(async () => ({ status: "pending" })),
    chargeBookingDeposit: vi.fn(),
  };
  const attempts = {
    listStaleSessionExtrasUnsent: vi.fn(async () => []),
    listRecoverable: vi.fn(async () => [attempt]),
    scheduleRecoveryRetry: vi.fn(async () => undefined),
  };
  const bookings = { findById: vi.fn(async (): Promise<unknown> => null) };
  const sourceId = new Types.ObjectId();
  const financials = {
    listForBooking: vi.fn(async () => [
      { _id: sourceId, providerReference: snapshot.paymentIntentId },
    ]),
  };
  const service = new MoneyRecoveryService(
    payment as unknown as PaymentService,
    attempts as unknown as PaymentAttemptRepository,
    {
      listRecoverable: vi.fn(async () => []),
      listFinalNotificationPending: vi.fn(async () => []),
    } as unknown as RefundOperationRepository,
    bookings as unknown as BookingRepository,
    financials as unknown as BookingFinancialTransactionService,
    {
      recoverDue: vi.fn(async () => ({ processed: 0, failed: 0 })),
    } as unknown as StripeWebhookService,
  );
  return { attempt, snapshot, payment, attempts, bookings, financials, sourceId, service };
};

describe("F3A existing recovery orchestration (mocked persistence, not a financial integration proof)", () => {
  it("detects an existing Booking/source and requires persistence ownership on repeated observation", async () => {
    const f = fixture();
    f.bookings.findById.mockResolvedValue({ _id: f.attempt.bookingId, serviceLines: [] });
    f.payment.claimPaymentPersistence
      .mockResolvedValueOnce("first-owner")
      .mockResolvedValueOnce(null);
    await f.service.runOnce();
    await f.service.runOnce();
    expect(f.payment.markPaymentCompleted).toHaveBeenCalledOnce();
    expect(f.payment.markPaymentCompleted).toHaveBeenCalledWith(
      String(f.attempt._id),
      { bookingId: f.attempt.bookingId, succeededTransactionId: f.sourceId },
      "first-owner",
    );
    expect(f.payment.refund).not.toHaveBeenCalled();
    expect(f.payment.chargeBookingDeposit).not.toHaveBeenCalled();
  });

  it("resumes aged orphan compensation through the existing claim/key, never another charge", async () => {
    const f = fixture();
    f.payment.claimPaymentCompensation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.service.runOnce();
    await f.service.runOnce();
    expect(f.payment.refund).toHaveBeenCalledOnce();
    expect(f.payment.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "refund:pi_synthetic_f3a:compensation",
        sourcePaymentAttemptId: f.attempt._id,
        domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
        amountCents: 2000,
      }),
    );
    expect(f.payment.markPaymentCompleted).not.toHaveBeenCalled();
    expect(f.payment.chargeBookingDeposit).not.toHaveBeenCalled();
  });

  it("retains uncertainty without provider evidence and schedules another observation", async () => {
    const f = fixture();
    f.payment.reconcilePaymentAttempt.mockResolvedValue({
      attempt: { ...f.attempt, providerStatus: "UNKNOWN" } as PaymentAttemptDocument,
      snapshot: null,
    });
    await f.service.runOnce();
    expect(f.attempts.scheduleRecoveryRetry).toHaveBeenCalledOnce();
    expect(f.payment.markPaymentCompleted).not.toHaveBeenCalled();
    expect(f.payment.claimPaymentCompensation).not.toHaveBeenCalled();
    expect(f.payment.refund).not.toHaveBeenCalled();
    expect(f.payment.chargeBookingDeposit).not.toHaveBeenCalled();
  });

  it("does not activate first-class Package recovery when the shipped authority denies", async () => {
    const f = fixture();
    // No authority mock: the actual shipped denial must precede provider/domain dispatch.
    f.attempt.purpose = "PACKAGE_LIFECYCLE_MONEY";
    const counts = await f.service.runOnce();
    expect(counts.errors).toBe(1);
    expect(f.attempts.scheduleRecoveryRetry).toHaveBeenCalledOnce();
    expect(f.payment.reconcilePaymentAttempt).not.toHaveBeenCalled();
    expect(f.payment.markPaymentCompleted).not.toHaveBeenCalled();
    expect(f.payment.refund).not.toHaveBeenCalled();
    expect(f.payment.chargeBookingDeposit).not.toHaveBeenCalled();
  });
});
