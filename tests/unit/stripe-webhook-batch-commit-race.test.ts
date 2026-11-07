import { Types } from "mongoose";
import { expect, it, vi } from "vitest";
import { inspectBatchPaymentAuthority } from "../../src/modules/booking/package-batch-payment-recovery.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import type { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventRepository } from "../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";

vi.mock("../../src/modules/booking/package-batch-payment-recovery.js", () => ({
  inspectBatchPaymentAuthority: vi.fn(),
}));

it("retains an early provider success for retry until canonical batch proof exists", async () => {
  const attempt = {
    _id: new Types.ObjectId(),
    expectedAmountCents: 3500,
    currency: "EUR",
    providerCustomerId: "cus_race",
    purpose: "PACKAGE_PURCHASE",
  };
  const events = {
    claim: vi.fn(async () => "original-event-lease"),
    markProcessed: vi.fn(),
    markFailed: vi.fn(),
    markRetryable: vi.fn(),
  };
  const attempts = {
    findByProviderPaymentIntentId: vi.fn(async () => attempt),
    recordProviderResult: vi.fn(async () => ({ providerStatus: "SUCCEEDED" })),
  };
  const financials = { listForBooking: vi.fn(), record: vi.fn(), settleStatus: vi.fn() };
  const service = new StripeWebhookService(
    {} as PaymentGateway,
    events as unknown as StripeWebhookEventRepository,
    financials as unknown as BookingFinancialTransactionService,
    undefined,
    attempts as unknown as PaymentAttemptRepository,
  );
  const event = {
    id: "evt_batch_commit_race",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_batch_commit_race",
        amount: 3500,
        currency: "eur",
        customer: "cus_race",
        metadata: {},
      },
    },
  } as unknown as Parameters<StripeWebhookService["process"]>[0];
  vi.mocked(inspectBatchPaymentAuthority).mockResolvedValueOnce({
    kind: "BATCH_PAYMENT_UNRESOLVED",
  } as Awaited<ReturnType<typeof inspectBatchPaymentAuthority>>);
  await expect(service.process(event)).rejects.toThrow(
    "Canonical complete batch monetary proof is unresolved",
  );
  expect(events.markRetryable).toHaveBeenCalledWith(
    event.id,
    "original-event-lease",
    "Canonical complete batch monetary proof is unresolved",
  );
  expect(events.markFailed).not.toHaveBeenCalled();
  expect(events.markProcessed).not.toHaveBeenCalled();
  expect(financials.listForBooking).not.toHaveBeenCalled();
  expect(financials.record).not.toHaveBeenCalled();
  expect(financials.settleStatus).not.toHaveBeenCalled();
  expect(attempts.recordProviderResult).toHaveBeenCalledWith(attempt._id, {
    providerPaymentIntentId: "pi_batch_commit_race",
    providerStatus: "SUCCEEDED",
  });
  vi.mocked(inspectBatchPaymentAuthority).mockResolvedValueOnce({
    kind: "BATCH_PAYMENT_COMPLETE",
  } as Awaited<ReturnType<typeof inspectBatchPaymentAuthority>>);
  await expect(service.process(event)).resolves.toBe(true);
  expect(events.markProcessed).toHaveBeenCalledWith(event.id, "original-event-lease");
});
