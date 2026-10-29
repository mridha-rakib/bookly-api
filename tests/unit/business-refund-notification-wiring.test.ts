import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P4B-1R — how the shared refund convergence paths reach the exact-event helper. The helper's
// own financial checks and atomicity are covered against a replica set in
// tests/integration/database/business-refund-notification.integration.test.ts.
const helper = vi.hoisted(() => ({
  ensureBusinessRefundNotification: vi.fn(),
  convergeBusinessRefundSettlementProjection: vi.fn(),
}));
vi.mock("../../src/modules/payment/business-refund-notification.js", () => helper);
vi.mock("../../src/modules/payment/refund-accounting.js", () => ({
  ensureRefundAccounting: vi.fn(async () => undefined),
}));

import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { MoneyRecoveryService } from "../../src/modules/payment/money-recovery.service.js";
import type { PaymentService } from "../../src/modules/payment/payment.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import type { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import type { RefundOperationRepository } from "../../src/modules/payment/refund-operation.repository.js";
import type { RefundRecoveryIncidentService } from "../../src/modules/payment/refund-recovery-incident.js";
import { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventRepository } from "../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";

beforeEach(() => {
  vi.clearAllMocks();
  helper.convergeBusinessRefundSettlementProjection.mockResolvedValue(false);
});

describe("MoneyRecoveryService exact refund notification pass", () => {
  const build = (
    operations: Array<{ _id: Types.ObjectId }>,
    incidents?: Pick<RefundRecoveryIncidentService, "observe" | "poll">,
  ) => {
    const refunds = {
      listRecoverable: vi.fn(async () => []),
      listFinalNotificationPending: vi.fn(async () => operations),
      scheduleRecoveryRetry: vi.fn(async () => undefined),
    };
    const service = new MoneyRecoveryService(
      {} as PaymentService,
      {
        listRecoverable: vi.fn(async () => []),
        listStaleSessionExtrasUnsent: vi.fn(async () => []),
      } as unknown as PaymentAttemptRepository,
      refunds as unknown as RefundOperationRepository,
      {} as BookingRepository,
      {} as BookingFinancialTransactionService,
      {
        recoverDue: vi.fn(async () => ({ processed: 0, failed: 0 })),
      } as unknown as StripeWebhookService,
      undefined,
      undefined,
      undefined,
      undefined,
      incidents,
    );
    return { service, refunds };
  };

  it("runs after the refund pass, projects first, and backs off evidence that has not converged", async () => {
    const ready = { _id: new Types.ObjectId() };
    const waiting = { _id: new Types.ObjectId() };
    helper.ensureBusinessRefundNotification
      .mockResolvedValueOnce("RECORDED")
      .mockResolvedValueOnce("NOT_READY");
    const { service, refunds } = build([ready, waiting]);

    const result = await service.runOnce(7);

    expect(refunds.listFinalNotificationPending).toHaveBeenCalledWith(7);
    expect(refunds.listRecoverable.mock.invocationCallOrder[0]).toBeLessThan(
      refunds.listFinalNotificationPending.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      helper.convergeBusinessRefundSettlementProjection.mock.invocationCallOrder[0],
    ).toBeLessThan(helper.ensureBusinessRefundNotification.mock.invocationCallOrder[0] ?? 0);
    expect(helper.ensureBusinessRefundNotification).toHaveBeenNthCalledWith(1, ready._id);
    expect(helper.ensureBusinessRefundNotification).toHaveBeenNthCalledWith(2, waiting._id);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledWith(
      waiting._id,
      "Final refund notification evidence not yet converged",
    );
    expect(result.errors).toBe(0);
  });

  it("does not retry an already recorded or non-applicable operation", async () => {
    helper.ensureBusinessRefundNotification
      .mockResolvedValueOnce("ALREADY_RECORDED")
      .mockResolvedValueOnce("NOT_APPLICABLE");
    const { service, refunds } = build([
      { _id: new Types.ObjectId() },
      { _id: new Types.ObjectId() },
    ]);
    const result = await service.runOnce();
    expect(refunds.scheduleRecoveryRetry).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it("P5-F1 observes unresolved evidence and polls incidents without changing the existing retry", async () => {
    const waiting = { _id: new Types.ObjectId() };
    const incidents = { observe: vi.fn(async () => undefined), poll: vi.fn(async () => undefined) };
    helper.ensureBusinessRefundNotification.mockResolvedValueOnce("NOT_READY");
    const { service, refunds } = build([waiting], incidents);
    expect((await service.runOnce(7)).errors).toBe(0);
    expect(incidents.observe).toHaveBeenCalledWith(
      waiting._id,
      "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED",
    );
    expect(incidents.poll).toHaveBeenCalledWith(7);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
  });

  it("P5-F1 isolates monitoring failure and reports it without skipping refund retries", async () => {
    const waiting = { _id: new Types.ObjectId() };
    const incidents = {
      observe: vi.fn(async () => {
        throw new Error("monitor unavailable");
      }),
      poll: vi.fn(async () => {
        throw new Error("monitor unavailable");
      }),
    };
    helper.ensureBusinessRefundNotification.mockResolvedValueOnce("NOT_READY");
    const { service, refunds } = build([waiting], incidents);
    expect((await service.runOnce()).errors).toBe(2);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
  });

  it("P5-F1 records an ordinary refund recovery failure without issuing another provider request", async () => {
    const operation = {
      _id: new Types.ObjectId(),
      sourcePaymentIntentId: "pi_private",
      expectedRefundAmountCents: 700,
      currency: "EUR",
      logicalIdempotencyKey: "same-original-refund",
      reason: "BUSINESS_CANCELLATION",
    };
    const payment = {
      refund: vi.fn(async () => {
        throw new Error("private provider payload");
      }),
    };
    const refunds = {
      listRecoverable: vi.fn(async () => [operation]),
      listFinalNotificationPending: vi.fn(async () => []),
      scheduleRecoveryRetry: vi.fn(async () => undefined),
    };
    const incidents = { observe: vi.fn(async () => undefined), poll: vi.fn(async () => undefined) };
    const service = new MoneyRecoveryService(
      payment as unknown as PaymentService,
      {
        listRecoverable: vi.fn(async () => []),
        listStaleSessionExtrasUnsent: vi.fn(async () => []),
      } as unknown as PaymentAttemptRepository,
      refunds as unknown as RefundOperationRepository,
      {} as BookingRepository,
      {} as BookingFinancialTransactionService,
      {
        recoverDue: vi.fn(async () => ({ processed: 0, failed: 0 })),
      } as unknown as StripeWebhookService,
      undefined,
      undefined,
      undefined,
      undefined,
      incidents,
    );
    expect((await service.runOnce()).errors).toBe(1);
    expect(incidents.observe).toHaveBeenCalledWith(operation._id, "REFUND_RECOVERY_FAILED");
    expect(payment.refund).toHaveBeenCalledTimes(1);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
  });

  it("isolates an outbox or projection failure and continues with later operations", async () => {
    const failing = { _id: new Types.ObjectId() };
    const projectionFailing = { _id: new Types.ObjectId() };
    const later = { _id: new Types.ObjectId() };
    helper.ensureBusinessRefundNotification
      .mockRejectedValueOnce(new TypeError("outbox unavailable"))
      .mockResolvedValueOnce("RECORDED");
    helper.convergeBusinessRefundSettlementProjection
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce(false);
    const { service, refunds } = build([failing, projectionFailing, later]);

    const result = await service.runOnce();

    expect(result.errors).toBe(2);
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledWith(failing._id, "TypeError");
    expect(refunds.scheduleRecoveryRetry).toHaveBeenCalledWith(projectionFailing._id, "Error");
    expect(helper.ensureBusinessRefundNotification).not.toHaveBeenCalledWith(projectionFailing._id);
    expect(helper.ensureBusinessRefundNotification).toHaveBeenCalledWith(later._id);
  });
});

describe("StripeWebhookService charge.refunded exact refund notification", () => {
  const operationId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();

  const build = (stored: { providerStatus: string; finalNotificationProtocolVersion?: 1 }) => {
    const operation = {
      _id: operationId,
      bookingId,
      businessId: new Types.ObjectId(),
      businessClientId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      reason: "BUSINESS_CANCELLATION",
      logicalIdempotencyKey: `business-cancel-refund:${String(bookingId)}`,
      sourcePaymentIntentId: "pi_1",
      expectedRefundAmountCents: 700,
      currency: "EUR",
      providerRefundId: "re_1",
      ...(stored.finalNotificationProtocolVersion ? { finalNotificationProtocolVersion: 1 } : {}),
    };
    const events = {
      claim: vi.fn(async () => "lease"),
      markProcessed: vi.fn(async () => undefined),
      markRetryable: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const bookings = { updateCancellationSettlement: vi.fn(async () => null) };
    const refunds = {
      findByProviderRefundId: vi.fn(async () => operation),
      recordProviderResult: vi.fn(async () => ({
        ...operation,
        providerStatus: stored.providerStatus,
      })),
      markDomainReconciled: vi.fn(async () => undefined),
    };
    const service = new StripeWebhookService(
      {} as PaymentGateway,
      events as unknown as StripeWebhookEventRepository,
      {
        listForBooking: vi.fn(async () => []),
        findByIdempotencyKey: vi.fn(async () => null),
        settleStatus: vi.fn(async () => null),
      } as unknown as BookingFinancialTransactionService,
      undefined,
      {
        findByProviderPaymentIntentId: vi.fn(async () => null),
      } as unknown as PaymentAttemptRepository,
      refunds as unknown as RefundOperationRepository,
      undefined,
      bookings as unknown as BookingRepository,
    );
    return { service, events, bookings };
  };

  const refunded = (status: string) =>
    ({
      id: `evt_${status}_${new Types.ObjectId().toString()}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          metadata: {},
          refunds: { data: [{ id: "re_1", amount: 700, currency: "eur", status, metadata: {} }] },
        },
      },
    }) as unknown as Parameters<StripeWebhookService["process"]>[0];

  it("reaches the helper after the Booking projection for a definitive opted-in result", async () => {
    for (const [providerStatus, stripeStatus] of [
      ["SUCCEEDED", "succeeded"],
      ["FAILED", "failed"],
    ] as const) {
      vi.clearAllMocks();
      helper.ensureBusinessRefundNotification.mockResolvedValueOnce("RECORDED");
      const { service, events, bookings } = build({
        providerStatus,
        finalNotificationProtocolVersion: 1,
      });
      expect(await service.process(refunded(stripeStatus))).toBe(true);
      expect(helper.ensureBusinessRefundNotification).toHaveBeenCalledWith(operationId);
      expect(bookings.updateCancellationSettlement.mock.invocationCallOrder[0]).toBeLessThan(
        helper.ensureBusinessRefundNotification.mock.invocationCallOrder[0] ?? 0,
      );
      expect(events.markProcessed).toHaveBeenCalled();
    }
  });

  it("never treats a pending provider refund or a historical operation as a final notice", async () => {
    const pending = build({
      providerStatus: "PROVIDER_PENDING",
      finalNotificationProtocolVersion: 1,
    });
    expect(await pending.service.process(refunded("pending"))).toBe(true);
    const historical = build({ providerStatus: "SUCCEEDED" });
    expect(await historical.service.process(refunded("succeeded"))).toBe(true);
    expect(helper.ensureBusinessRefundNotification).not.toHaveBeenCalled();
  });

  it("a notification failure leaves the financial webhook processed for recovery to finish", async () => {
    helper.ensureBusinessRefundNotification.mockRejectedValueOnce(new Error("outbox unavailable"));
    const { service, events } = build({
      providerStatus: "SUCCEEDED",
      finalNotificationProtocolVersion: 1,
    });
    expect(await service.process(refunded("succeeded"))).toBe(true);
    expect(events.markProcessed).toHaveBeenCalled();
    expect(events.markRetryable).not.toHaveBeenCalled();
    expect(events.markFailed).not.toHaveBeenCalled();
  });
});
