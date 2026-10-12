import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import { ProviderReversalCorrelationError } from "../../src/modules/provider-reversal/provider-reversal.service.js";
import { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventRepository } from "../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";

const DISPUTE_EVENTS = [
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;

const event = (type: string, object: Record<string, unknown>): Stripe.Event =>
  ({ id: `evt_${type}`, type, data: { object } }) as unknown as Stripe.Event;

const build = (
  reversals?: ConstructorParameters<typeof StripeWebhookService>[10],
  stored: { status: string; replayCount?: number; error?: string } = { status: "PROCESSED" },
) => {
  const eventRepository = {
    claim: vi.fn(async () => "lease"),
    markProcessed: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    markRetryable: vi.fn(async () => true),
    findByEventId: vi.fn(async () => stored),
  } as unknown as StripeWebhookEventRepository;
  const service = new StripeWebhookService(
    {} as PaymentGateway,
    eventRepository,
    {} as BookingFinancialTransactionService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reversals,
  );
  return { service, eventRepository };
};

const reversalsMock = () => ({
  syncDispute: vi.fn(async () => ({}) as never),
  reconcileRefundsForPaymentIntent: vi.fn(async () => []),
  alertWebhookFailed: vi.fn(async () => undefined),
});

describe("StripeWebhookService — P6 provider reversals", () => {
  it("handles every dispute lifecycle event and charge.refund.updated", () => {
    const { service } = build();
    for (const type of [...DISPUTE_EVENTS, "charge.refund.updated", "charge.refunded"]) {
      expect(service.isHandled(type)).toBe(true);
    }
  });

  it("every dispute event re-reads the dispute from the provider (by id only)", async () => {
    const reversals = reversalsMock();
    const { service, eventRepository } = build(reversals);
    for (const type of DISPUTE_EVENTS) {
      await service.process(event(type, { id: "dp_1", status: "lost", amount: 999 }));
    }
    expect(reversals.syncDispute).toHaveBeenCalledTimes(DISPUTE_EVENTS.length);
    expect(reversals.syncDispute).toHaveBeenCalledWith("dp_1", "WEBHOOK");
    expect(eventRepository.markProcessed).toHaveBeenCalledTimes(DISPUTE_EVENTS.length);
  });

  it("stores a minimal replay payload for dispute events (identity, never evidence)", async () => {
    const reversals = reversalsMock();
    const { service, eventRepository } = build(reversals);
    await service.process(
      event("charge.dispute.created", {
        id: "dp_1",
        charge: "ch_1",
        payment_intent: "pi_1",
        amount: 2000,
        currency: "eur",
        status: "needs_response",
        evidence: { customer_name: "secret" },
      }),
    );
    const payload = vi.mocked(eventRepository.claim).mock.calls[0]?.[2] as {
      data: { object: Record<string, unknown> };
    };
    expect(payload.data.object).toEqual({
      id: "dp_1",
      charge: "ch_1",
      payment_intent: "pi_1",
      amount: 2000,
      currency: "eur",
      status: "needs_response",
    });
  });

  it("a dispute event without the reversal dependency stays retryable (never silently acknowledged)", async () => {
    const { service, eventRepository } = build(undefined);
    await expect(
      service.process(event("charge.dispute.created", { id: "dp_1" })),
    ).rejects.toThrow();
    expect(eventRepository.markRetryable).toHaveBeenCalled();
    expect(eventRepository.markProcessed).not.toHaveBeenCalled();
  });

  it("corrupt provider/ledger identity is retained for investigation, transient errors are retried", async () => {
    const reversals = reversalsMock();
    reversals.syncDispute.mockRejectedValueOnce(new ProviderReversalCorrelationError("mismatch"));
    const { service, eventRepository } = build(reversals, { status: "FAILED" });
    await service.process(event("charge.dispute.updated", { id: "dp_1" }));
    expect(eventRepository.markFailed).toHaveBeenCalledWith(
      "evt_charge.dispute.updated",
      "lease",
      "mismatch",
    );
    expect(reversals.alertWebhookFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_charge.dispute.updated", providerObjectId: "dp_1" }),
    );

    reversals.syncDispute.mockRejectedValueOnce(new Error("Stripe unavailable"));
    const retried = build(reversals, { status: "RETRYABLE" });
    await expect(
      retried.service.process(event("charge.dispute.updated", { id: "dp_2" })),
    ).rejects.toThrow("Stripe unavailable");
    expect(retried.eventRepository.markRetryable).toHaveBeenCalled();
    expect(reversals.alertWebhookFailed).toHaveBeenCalledTimes(1); // not FAILED yet: no alert
  });

  it("charge.refunded / charge.refund.updated reconcile the PaymentIntent's provider refunds", async () => {
    const reversals = reversalsMock();
    const { service } = build(reversals);
    await service.process(
      event("charge.refunded", {
        id: "ch_1",
        payment_intent: "pi_1",
        metadata: {},
        refunds: { data: [] },
      }),
    );
    await service.process(event("charge.refund.updated", { id: "re_1", payment_intent: "pi_2" }));
    expect(reversals.reconcileRefundsForPaymentIntent.mock.calls).toEqual([
      ["pi_1", "WEBHOOK"],
      ["pi_2", "WEBHOOK"],
    ]);
  });

  it("a FAILED-alert problem never changes the event outcome", async () => {
    const reversals = reversalsMock();
    reversals.syncDispute.mockRejectedValueOnce(new ProviderReversalCorrelationError("mismatch"));
    reversals.alertWebhookFailed.mockRejectedValueOnce(new Error("outbox down"));
    const { service, eventRepository } = build(reversals, { status: "FAILED" });
    await expect(service.process(event("charge.dispute.updated", { id: "dp_1" }))).resolves.toBe(
      true,
    );
    expect(eventRepository.markFailed).toHaveBeenCalled();
  });
});
