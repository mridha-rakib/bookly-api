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
      listStaleSessionExtrasUnsent: vi.fn(async () => []),
      scheduleRecoveryRetry: vi.fn(async () => undefined),
    } as unknown as PaymentAttemptRepository;
    const refundOperationRepository = {
      listRecoverable: vi.fn(async () => []),
      listFinalNotificationPending: vi.fn(async () => []),
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

  describe("Option A — generic requires_action scope", () => {
    const build = (maximumAgeMs?: number) => {
      const paymentAttemptRepository = {
        listRecoverable: vi.fn(async () => [] as PaymentAttemptDocument[]),
        listStaleSessionExtrasUnsent: vi.fn(async () => []),
        scheduleRecoveryRetry: vi.fn(async () => undefined),
      } as unknown as PaymentAttemptRepository;
      const service = new MoneyRecoveryService(
        {} as PaymentService,
        paymentAttemptRepository,
        {
          listRecoverable: vi.fn(async () => []),
          listFinalNotificationPending: vi.fn(async () => []),
        } as unknown as RefundOperationRepository,
        {} as BookingRepository,
        {} as BookingFinancialTransactionService,
        {
          recoverDue: vi.fn(async () => ({ processed: 0, failed: 0 })),
        } as unknown as StripeWebhookService,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maximumAgeMs,
      );
      return { service, listRecoverable: vi.mocked(paymentAttemptRepository.listRecoverable) };
    };

    it.each([undefined, 0, -1, Number.NaN, 1.5])(
      "does not ask for requires_action candidates when the expiry policy is %s",
      async (maximumAgeMs) => {
        const { service, listRecoverable } = build(maximumAgeMs);
        await service.runOnce();
        expect(listRecoverable).toHaveBeenCalledWith(50, {});
      },
    );

    it("asks only for attempts created at or before now minus the configured maximum age", async () => {
      const now = new Date("2026-11-19T12:00:00Z").getTime();
      const spy = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const { service, listRecoverable } = build(600_000);
        await service.runOnce();
        expect(listRecoverable).toHaveBeenCalledWith(50, {
          authenticationExpiredBefore: new Date(now - 600_000),
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
