import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import type { PaymentAttemptDocument } from "../../src/modules/payment/payment-attempt.model.js";
import type { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import type { RefundOperationDocument } from "../../src/modules/payment/refund-operation.model.js";
import type { RefundOperationRepository } from "../../src/modules/payment/refund-operation.repository.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

vi.mock("../../src/modules/booking/package-batch-payment-recovery.js", () => ({
  isCanonicalRetainedBatch: async () => false,
}));

function fixture() {
  const attempt = {
    _id: new Types.ObjectId(),
    providerStatus: "NOT_CREATED",
    expectedAmountCents: 2000,
    currency: "EUR",
    providerCustomerId: "cus_original",
    purpose: "BOOKING_DEPOSIT",
    logicalIdempotencyKey: "original-operation",
  } as PaymentAttemptDocument;
  const intent = {
    paymentIntentId: "pi_original",
    status: "succeeded" as const,
    amountCents: 2000,
    amountRefundedCents: 0,
    currency: "EUR",
    customerId: "cus_original",
    metadata: { booklyPaymentAttemptId: String(attempt._id) },
  };
  const attempts = {
    createOrResumeWithDisposition: vi.fn(async () => ({
      attempt,
      isNew: !attempt.providerPaymentIntentId,
    })),
    recordProviderResult: vi.fn(async (_id, input) => Object.assign(attempt, input)),
    findById: vi.fn(async () => attempt),
    findByProviderPaymentIntentId: vi.fn(async () => null),
  };
  const refund = {
    _id: new Types.ObjectId(),
    sourcePaymentIntentId: "pi_original",
    expectedRefundAmountCents: 2000,
    currency: "EUR",
    providerStatus: "CREATED",
  } as RefundOperationDocument;
  const refunds = {
    createOrResumeWithDisposition: vi.fn(async () => ({ operation: refund, isNew: false })),
    recordProviderResult: vi.fn(async (_id, input) => Object.assign(refund, input)),
    markProviderCallStarted: vi.fn(),
    markFailed: vi.fn(),
    markReconciliationRequired: vi.fn(),
  };
  const gateway = {
    createAndConfirmPaymentIntent: vi.fn(async () => intent),
    retrievePaymentIntent: vi.fn(async () => intent),
    createRefund: vi.fn(),
    retrieveRefund: vi.fn(async () => ({
      refundId: "re_original",
      status: "pending" as const,
      paymentIntentId: "pi_original",
      amountCents: 2000,
      currency: "EUR",
    })),
    findRefundByMetadata: vi.fn(async () => ({
      outcome: "FOUND_ONE" as const,
      value: {
        refundId: "re_original",
        status: "pending" as const,
        paymentIntentId: "pi_original",
        amountCents: 2000,
        currency: "EUR",
      },
    })),
  };
  const service = new PaymentService(
    gateway as unknown as PaymentGateway,
    {
      findByUserId: async () => ({
        defaultPaymentMethodId: "pm_original",
        stripeCustomerId: "cus_original",
      }),
    } as unknown as CustomerPaymentProfileRepository,
    {} as UserRepository,
    attempts as unknown as PaymentAttemptRepository,
    refunds as unknown as RefundOperationRepository,
  );
  return { attempt, intent, attempts, refund, refunds, gateway, service };
}

describe("Durable collection and refund identity", () => {
  it("collects a FIRST deposit once and retrieves the original payment on replay", async () => {
    const f = fixture();
    const input = {
      userId: new Types.ObjectId(),
      amountCents: 2000,
      idempotencyKey: "original-operation",
      metadata: { purpose: "BOOKING_DEPOSIT" },
    };
    const first = await f.service.chargeBookingDeposit(input);
    const replay = await f.service.chargeBookingDeposit(input);
    expect(replay.paymentAttemptId).toBe(first.paymentAttemptId);
    expect(f.gateway.createAndConfirmPaymentIntent).toHaveBeenCalledOnce();
    expect(f.gateway.retrievePaymentIntent).toHaveBeenCalledWith("pi_original");
  });

  it.each(["CANCELLATION_FEE", "NO_SHOW_FEE"])(
    "never redispatches the original %s charge",
    async (purpose) => {
      const f = fixture();
      f.attempt.purpose = purpose;
      const input = {
        stripeCustomerId: "cus_original",
        paymentMethodId: "pm_original",
        metadata: { purpose },
      };
      await f.service.dispatchPenaltyAttempt(f.attempt._id, input);
      await f.service.dispatchPenaltyAttempt(f.attempt._id, input);
      expect(f.gateway.createAndConfirmPaymentIntent).toHaveBeenCalledOnce();
    },
  );

  it("recovers a pending refund by its original provider ID without reporting settlement", async () => {
    const f = fixture();
    f.refund.providerRefundId = "re_original";
    for (let replay = 0; replay < 2; replay++) {
      const result = await f.service.refund({
        paymentIntentId: "pi_original",
        amountCents: 2000,
        currency: "EUR",
        idempotencyKey: "original-refund",
      });
      expect(result).toMatchObject({
        refundId: "re_original",
        status: "pending",
        refundOperationId: String(f.refund._id),
      });
    }
    expect(f.gateway.createRefund).not.toHaveBeenCalled();
  });

  it("recovers a lost refund response by original operation metadata before any resend", async () => {
    const f = fixture();
    f.refund.providerCallStartedAt = new Date();
    const result = await f.service.refund({
      paymentIntentId: "pi_original",
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "original-refund",
    });
    expect(result.status).toBe("pending");
    expect(f.gateway.findRefundByMetadata).toHaveBeenCalledWith({
      refundOperationId: String(f.refund._id),
      paymentIntentId: "pi_original",
    });
    expect(f.gateway.createRefund).not.toHaveBeenCalled();
  });

  it("refuses a refund larger than the remaining paid amount", async () => {
    const f = fixture();
    f.intent.amountRefundedCents = 1000;
    f.refunds.createOrResumeWithDisposition.mockResolvedValue({ operation: f.refund, isNew: true });
    await expect(
      f.service.refund({
        paymentIntentId: "pi_original",
        amountCents: 2000,
        currency: "EUR",
        idempotencyKey: "original-refund",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.gateway.createRefund).not.toHaveBeenCalled();
    expect(f.refunds.markFailed).toHaveBeenCalled();
  });
});
