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

describe("MoneyRecoveryService", () => {
  it("backs off a failed record and continues processing later records", async () => {
    const first = { _id: new Types.ObjectId(), providerStatus: "UNKNOWN" };
    const second = { _id: new Types.ObjectId(), providerStatus: "UNKNOWN" };
    const paymentService = {
      reconcilePaymentAttempt: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary provider failure"))
        .mockResolvedValueOnce({ attempt: second, snapshot: null }),
    } as unknown as PaymentService;
    const paymentAttemptRepository = {
      listRecoverable: vi.fn(async () => [first, second] as PaymentAttemptDocument[]),
      scheduleRecoveryRetry: vi.fn(async () => undefined),
    } as unknown as PaymentAttemptRepository;
    const refundOperationRepository = {
      listRecoverable: vi.fn(async () => []),
    } as unknown as RefundOperationRepository;
    const webhookService = {
      recoverDue: vi.fn(async () => ({ processed: 0, failed: 0 })),
    } as unknown as StripeWebhookService;
    const service = new MoneyRecoveryService(
      paymentService,
      paymentAttemptRepository,
      refundOperationRepository,
      {} as BookingRepository,
      {} as BookingFinancialTransactionService,
      webhookService,
    );

    const result = await service.runOnce();

    expect(paymentService.reconcilePaymentAttempt).toHaveBeenCalledTimes(2);
    expect(paymentAttemptRepository.scheduleRecoveryRetry).toHaveBeenCalledWith(
      first._id,
      "temporary provider failure",
    );
    expect(result).toMatchObject({ paymentAttempts: 1, errors: 1 });
  });
});
