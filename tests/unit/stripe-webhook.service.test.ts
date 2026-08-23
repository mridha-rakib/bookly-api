import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingFinancialTransactionDocument } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import { StripeWebhookService } from "../../src/modules/stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventRepository } from "../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";

const makeEntry = (
  overrides: Partial<BookingFinancialTransactionDocument> = {},
): BookingFinancialTransactionDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    bookingId: new Types.ObjectId(),
    businessClientId: new Types.ObjectId(),
    customerUserId: new Types.ObjectId(),
    type: "DEPOSIT",
    direction: "DEBIT",
    amountCents: 2000,
    currency: "EUR",
    status: "PENDING",
    providerReference: "pi_test_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as BookingFinancialTransactionDocument;

describe("StripeWebhookService — PROCESSING_FEE capture (Batch 7)", () => {
  let eventRepository: StripeWebhookEventRepository;
  let recordedEntries: Array<Record<string, unknown>>;
  let financialTransactionService: BookingFinancialTransactionService;
  let gateway: PaymentGateway;
  let settleStatusCalls: Array<{ id: unknown; status: string }>;

  beforeEach(() => {
    recordedEntries = [];
    settleStatusCalls = [];

    eventRepository = {
      claim: vi.fn(async () => true),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    } as unknown as StripeWebhookEventRepository;

    gateway = {
      getOrCreateCustomer: async () => ({ stripeCustomerId: "cus_1" }),
      createSetupIntent: async () => ({ setupIntentId: "seti_1", clientSecret: "secret" }),
      retrieveSetupIntent: async () => ({ status: "succeeded" }),
      getPaymentMethodSummary: async () => ({
        paymentMethodId: "pm_1",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
      }),
      setDefaultPaymentMethod: async () => undefined,
      createAndConfirmPaymentIntent: async () => ({
        paymentIntentId: "pi_test_1",
        status: "succeeded",
      }),
      createRefund: async () => ({ refundId: "re_1", status: "succeeded" }),
      retrieveBalanceTransactionFee: async () => ({ feeCents: 55, currency: "EUR" }),
      retrieveProcessingFeeForPaymentIntent: async () => ({ feeCents: 87, currency: "EUR" }),
      constructWebhookEvent: () => {
        throw new Error("not used");
      },
    };
  });

  const buildService = (pendingEntry: BookingFinancialTransactionDocument | undefined) => {
    financialTransactionService = {
      listForBooking: vi.fn(async () => (pendingEntry ? [pendingEntry] : [])),
      settleStatus: vi.fn(async (id: unknown, status: string) => {
        settleStatusCalls.push({ id, status });
        return null;
      }),
      record: vi.fn(async (input: Record<string, unknown>) => {
        recordedEntries.push(input);
        return {
          _id: new Types.ObjectId(),
          ...input,
        } as unknown as BookingFinancialTransactionDocument;
      }),
    } as unknown as BookingFinancialTransactionService;

    return new StripeWebhookService(gateway, eventRepository, financialTransactionService);
  };

  const paymentIntentSucceededEvent = (paymentIntentId: string, bookingId: string) =>
    ({
      id: `evt_${paymentIntentId}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          metadata: { bookingId },
        },
      },
    }) as unknown as Parameters<StripeWebhookService["process"]>[0];

  it("records a real PROCESSING_FEE ledger entry using the actual Stripe fee once the primary charge settles", async () => {
    const bookingId = new Types.ObjectId();
    const pending = makeEntry({
      bookingId,
      providerReference: "pi_test_1",
      status: "PENDING",
      type: "DEPOSIT",
    });
    const service = buildService(pending);

    const handled = await service.process(
      paymentIntentSucceededEvent("pi_test_1", String(bookingId)),
    );

    expect(handled).toBe(true);
    expect(settleStatusCalls).toEqual([{ id: pending._id, status: "SUCCEEDED" }]);

    const processingFeeEntry = recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE");
    expect(processingFeeEntry).toBeDefined();
    expect(processingFeeEntry?.["amountCents"]).toBe(87);
    expect(processingFeeEntry?.["direction"]).toBe("DEBIT");
    expect(processingFeeEntry?.["status"]).toBe("SUCCEEDED");
    expect(processingFeeEntry?.["idempotencyKey"]).toBe("processing-fee:pi_test_1");
    expect(processingFeeEntry?.["businessId"]).toBe(pending.businessId);
  });

  it("still attempts PROCESSING_FEE capture when the entry was ALREADY SUCCEEDED (Batch 8 correction — most real charges settle synchronously, so the ledger entry is usually already SUCCEEDED by the time this webhook arrives, not PENDING)", async () => {
    const bookingId = new Types.ObjectId();
    const alreadySettled = makeEntry({
      bookingId,
      providerReference: "pi_test_1",
      status: "SUCCEEDED",
    });
    const service = buildService(alreadySettled);

    await service.process(paymentIntentSucceededEvent("pi_test_1", String(bookingId)));

    // No PENDING -> SUCCEEDED transition happened (it was already SUCCEEDED)...
    expect(settleStatusCalls).toEqual([]);
    // ...but the processing fee is still captured, since Stripe's own webhook delivery is a
    // separate real-world event from our synchronous charge confirmation.
    const processingFeeEntry = recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE");
    expect(processingFeeEntry).toBeDefined();
    expect(processingFeeEntry?.["idempotencyKey"]).toBe("processing-fee:pi_test_1");
  });

  it("never records a duplicate PROCESSING_FEE entry on true webhook redelivery (the ledger's real unique idempotencyKey index rejects the second insert)", async () => {
    const bookingId = new Types.ObjectId();
    const alreadySettled = makeEntry({
      bookingId,
      providerReference: "pi_test_1",
      status: "SUCCEEDED",
    });
    const service = buildService(alreadySettled);
    // Simulate the real Mongo unique index: a second `record()` call with the same
    // idempotencyKey throws, exactly like BookingFinancialTransactionService.record does on a
    // duplicate-key error.
    let processingFeeAttempts = 0;
    financialTransactionService.record = vi.fn(async (input: Record<string, unknown>) => {
      if (input["type"] === "PROCESSING_FEE") {
        processingFeeAttempts += 1;
        if (processingFeeAttempts > 1) {
          throw new Error("duplicate key");
        }
      }
      recordedEntries.push(input);
      return {
        _id: new Types.ObjectId(),
        ...input,
      } as unknown as BookingFinancialTransactionDocument;
    });

    const event = paymentIntentSucceededEvent("pi_test_1", String(bookingId));
    await service.process(event);
    await service.process(event);

    expect(recordedEntries.filter((entry) => entry["type"] === "PROCESSING_FEE")).toHaveLength(1);
  });

  it("never throws when the balance transaction is not yet available (returns null) — the primary settlement still succeeds", async () => {
    const bookingId = new Types.ObjectId();
    const pending = makeEntry({ bookingId, providerReference: "pi_test_1", status: "PENDING" });
    gateway.retrieveProcessingFeeForPaymentIntent = async () => null;
    const service = buildService(pending);

    const handled = await service.process(
      paymentIntentSucceededEvent("pi_test_1", String(bookingId)),
    );

    expect(handled).toBe(true);
    expect(settleStatusCalls).toEqual([{ id: pending._id, status: "SUCCEEDED" }]);
    expect(recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE")).toBeUndefined();
  });

  it("swallows a Stripe error from the fee lookup without failing the whole webhook", async () => {
    const bookingId = new Types.ObjectId();
    const pending = makeEntry({ bookingId, providerReference: "pi_test_1", status: "PENDING" });
    gateway.retrieveProcessingFeeForPaymentIntent = async () => {
      throw new Error("stripe unavailable");
    };
    const service = buildService(pending);

    const handled = await service.process(
      paymentIntentSucceededEvent("pi_test_1", String(bookingId)),
    );

    expect(handled).toBe(true);
    expect(settleStatusCalls).toEqual([{ id: pending._id, status: "SUCCEEDED" }]);
  });
});
