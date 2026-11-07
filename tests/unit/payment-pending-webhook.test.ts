import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type {
  PaymentGateway,
  PaymentIntentSnapshot,
} from "../../src/modules/payment/payment.types.js";
import type { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventRepository } from "../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";

function fixture(status: PaymentIntentSnapshot["status"] = "requires_action") {
  const attempt = {
    _id: new Types.ObjectId(),
    providerPaymentIntentId: "pi_original",
    providerCustomerId: "cus_original",
    expectedAmountCents: 2000,
    currency: "EUR",
    purpose: "BOOKING_DEPOSIT",
  };
  const snapshot: PaymentIntentSnapshot = {
    paymentIntentId: "pi_original",
    status,
    amountCents: 2000,
    amountRefundedCents: 0,
    currency: "eur",
    customerId: "cus_original",
    metadata: { booklyPaymentAttemptId: String(attempt._id) },
  };
  const claimed = new Set<string>();
  const events = {
    claim: vi.fn(async (id: string) => {
      if (claimed.has(id)) return null;
      claimed.add(id);
      return "lease";
    }),
    markProcessed: vi.fn(),
    markFailed: vi.fn(),
    markRetryable: vi.fn(),
  };
  const attempts = {
    findByProviderPaymentIntentId: vi.fn(async () => attempt),
    recordProviderResult: vi.fn(async (_id, input) => ({ ...attempt, ...input })),
  };
  const retrieve = vi.fn(async () => snapshot);
  const finance = { listForBooking: vi.fn(async () => []), record: vi.fn(), settleStatus: vi.fn() };
  const service = new StripeWebhookService(
    { retrievePaymentIntent: retrieve } as unknown as PaymentGateway,
    events as unknown as StripeWebhookEventRepository,
    finance as unknown as BookingFinancialTransactionService,
    undefined,
    attempts as unknown as PaymentAttemptRepository,
  );
  const event = (type: string) =>
    ({
      id: "evt_original",
      type,
      data: {
        object: {
          id: "pi_original",
          amount: 2000,
          currency: "eur",
          customer: "cus_original",
          metadata: snapshot.metadata,
        },
      },
    }) as Parameters<StripeWebhookService["process"]>[0];
  return { attempt, snapshot, events, attempts, retrieve, finance, service, event };
}

describe("PaymentIntent pending webhook continuity", () => {
  it.each(["requires_action", "processing"] as const)(
    "tracks %s and deduplicates replay without recording revenue",
    async (status) => {
      const f = fixture(status);
      expect(await f.service.process(f.event(`payment_intent.${status}`))).toBe(true);
      expect(await f.service.process(f.event(`payment_intent.${status}`))).toBe(false);
      expect(f.attempts.recordProviderResult).toHaveBeenCalledExactlyOnceWith(f.attempt._id, {
        providerPaymentIntentId: "pi_original",
        providerStatus: status.toUpperCase(),
        clientSecret: undefined,
      });
      expect(f.events.claim.mock.calls[0]?.[0]).toBe("evt_original");
      expect(f.finance.record).not.toHaveBeenCalled();
      expect(f.finance.settleStatus).not.toHaveBeenCalled();
    },
  );

  it("uses current success when a delayed requires_action event arrives", async () => {
    const f = fixture("succeeded");
    await f.service.process(f.event("payment_intent.requires_action"));
    expect(f.attempts.recordProviderResult).toHaveBeenCalledWith(f.attempt._id, {
      providerPaymentIntentId: "pi_original",
      providerStatus: "SUCCEEDED",
    });
    expect(f.finance.record).not.toHaveBeenCalled();
  });

  it("keeps provider retrieval failures retryable without fabricating payment status", async () => {
    const f = fixture();
    f.retrieve.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(f.service.process(f.event("payment_intent.processing"))).rejects.toThrow();
    expect(f.events.markRetryable).toHaveBeenCalled();
    expect(f.attempts.recordProviderResult).not.toHaveBeenCalled();
  });

  it("refuses mismatched authoritative ownership before writing", async () => {
    const f = fixture();
    f.snapshot.customerId = "cus_other";
    await f.service.process(f.event("payment_intent.processing"));
    expect(f.events.markFailed).toHaveBeenCalled();
    expect(f.attempts.recordProviderResult).not.toHaveBeenCalled();
  });

  it("does not release a retrying payment on a delayed failure event", async () => {
    const f = fixture("processing");
    await f.service.process(f.event("payment_intent.payment_failed"));
    expect(f.attempts.recordProviderResult).toHaveBeenCalledWith(f.attempt._id, {
      providerPaymentIntentId: "pi_original",
      providerStatus: "PROCESSING",
      clientSecret: undefined,
    });
    expect(f.finance.settleStatus).not.toHaveBeenCalled();
  });
});
