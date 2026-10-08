import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingFinancialTransactionDocument } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import { buildPaymentIntentMetadata } from "../../src/modules/payment/payment-intent-metadata.js";
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
      markRetryable: vi.fn(async () => undefined),
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
      findTaxAssociation: async () => null,
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
      findByIdempotencyKey: vi.fn(async (idempotencyKey: string) => {
        const existing = recordedEntries.find(
          (entry) => entry["idempotencyKey"] === idempotencyKey,
        );
        return (existing as unknown as BookingFinancialTransactionDocument | undefined) ?? null;
      }),
    } as unknown as BookingFinancialTransactionService;

    return new StripeWebhookService(gateway, eventRepository, financialTransactionService);
  };

  const paymentIntentSucceededEvent = (
    paymentIntentId: string,
    bookingId: string,
    overrides: { amount?: number; metadata?: Record<string, string> } = {},
  ) =>
    ({
      id: `evt_${paymentIntentId}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          amount: overrides.amount ?? 2000,
          currency: "eur",
          metadata: overrides.metadata ?? { bookingId },
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

  it("does not consume an early success webhook; a retry after its source row exists completes once", async () => {
    const bookingId = new Types.ObjectId();
    const eventualEntry = makeEntry({
      bookingId,
      providerReference: "pi_test_1",
      status: "SUCCEEDED",
    });
    const service = buildService(undefined);
    const event = paymentIntentSucceededEvent("pi_test_1", String(bookingId));

    await expect(service.process(event)).rejects.toThrow("source ledger row");
    expect(eventRepository.markRetryable).toHaveBeenCalledOnce();
    financialTransactionService.listForBooking = vi.fn(async () => [eventualEntry]);

    await expect(service.process(event)).resolves.toBe(true);
    expect(recordedEntries.filter((entry) => entry["type"] === "PROCESSING_FEE")).toHaveLength(1);
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

  it("keeps the event retryable when the balance transaction is not yet available", async () => {
    const bookingId = new Types.ObjectId();
    const pending = makeEntry({ bookingId, providerReference: "pi_test_1", status: "PENDING" });
    gateway.retrieveProcessingFeeForPaymentIntent = async () => null;
    const service = buildService(pending);

    await expect(
      service.process(paymentIntentSucceededEvent("pi_test_1", String(bookingId))),
    ).rejects.toThrow("balance transaction");
    expect(settleStatusCalls).toEqual([{ id: pending._id, status: "SUCCEEDED" }]);
    expect(recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE")).toBeUndefined();
    expect(eventRepository.markRetryable).toHaveBeenCalledOnce();
  });

  it("keeps the event retryable when Stripe fee lookup fails", async () => {
    const bookingId = new Types.ObjectId();
    const pending = makeEntry({ bookingId, providerReference: "pi_test_1", status: "PENDING" });
    gateway.retrieveProcessingFeeForPaymentIntent = async () => {
      throw new Error("stripe unavailable");
    };
    const service = buildService(pending);

    await expect(
      service.process(paymentIntentSucceededEvent("pi_test_1", String(bookingId))),
    ).rejects.toThrow("processing fee");
    expect(settleStatusCalls).toEqual([{ id: pending._id, status: "SUCCEEDED" }]);
    expect(eventRepository.markRetryable).toHaveBeenCalledOnce();
  });

  it("keeps the event retryable when processing-fee persistence fails before an idempotent row exists", async () => {
    const bookingId = new Types.ObjectId();
    const settled = makeEntry({ bookingId, providerReference: "pi_test_1", status: "SUCCEEDED" });
    const service = buildService(settled);
    financialTransactionService.record = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      service.process(paymentIntentSucceededEvent("pi_test_1", String(bookingId))),
    ).rejects.toThrow("ledger persistence");
    expect(eventRepository.markRetryable).toHaveBeenCalledOnce();
    expect(eventRepository.markProcessed).not.toHaveBeenCalled();
  });

  it("does not post a fee when Stripe currencies are not comparable", async () => {
    const bookingId = new Types.ObjectId();
    const settled = makeEntry({ bookingId, providerReference: "pi_test_1", status: "SUCCEEDED" });
    gateway.retrieveProcessingFeeForPaymentIntent = async () => ({ feeCents: 87, currency: "USD" });
    const service = buildService(settled);

    // Investigation failures are acknowledged to Stripe, but remain durably visible as FAILED.
    await expect(
      service.process(paymentIntentSucceededEvent("pi_test_1", String(bookingId))),
    ).resolves.toBe(true);
    expect(recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE")).toBeUndefined();
    expect(eventRepository.markFailed).toHaveBeenCalledOnce();
  });

  it("fails closed when C3 metadata amount or ownership does not match its source row", async () => {
    const bookingId = new Types.ObjectId();
    const settled = makeEntry({ bookingId, providerReference: "pi_test_1", status: "SUCCEEDED" });
    const service = buildService(settled);
    const metadata = buildPaymentIntentMetadata({
      bookingId: String(bookingId),
      businessId: String(settled.businessId),
      businessClientId: String(settled.businessClientId),
      purpose: "BOOKING_DEPOSIT",
      preTaxChargeCents: 2000,
      taxCents: 0,
      chargedAmountCents: 2000,
      taxMode: "PRE_ACTIVATION",
    });

    await expect(
      service.process(
        paymentIntentSucceededEvent("pi_test_1", String(bookingId), { amount: 2001, metadata }),
      ),
    ).resolves.toBe(true);
    expect(recordedEntries.find((entry) => entry["type"] === "PROCESSING_FEE")).toBeUndefined();
    expect(eventRepository.markFailed).toHaveBeenCalledOnce();
  });
});
