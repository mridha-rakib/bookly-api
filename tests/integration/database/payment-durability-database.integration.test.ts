import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import type { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { StripeWebhookEventModel } from "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import type { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("durable payment/refund/webhook foundation", () => {
  const userId = new Types.ObjectId();
  const businessId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const businessClientId = new Types.ObjectId();
  let gateway: FakePaymentGateway;
  let attempts: PaymentAttemptRepository;
  let refunds: RefundOperationRepository;
  let service: PaymentService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
    await Promise.all([
      PaymentAttemptModel.init(),
      RefundOperationModel.init(),
      StripeWebhookEventModel.init(),
      BookingCreationClaimModel.init(),
    ]);
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    gateway = new FakePaymentGateway();
    attempts = new PaymentAttemptRepository();
    refunds = new RefundOperationRepository();
    const profiles = {
      findByUserId: async () => ({
        userId,
        stripeCustomerId: "cus_durable",
        defaultPaymentMethodId: "pm_durable",
      }),
    } as unknown as CustomerPaymentProfileRepository;
    service = new PaymentService(gateway, profiles, {} as UserRepository, attempts, refunds);
  });

  afterAll(async () => stopIsolatedReplicaSet());

  const metadata = (purpose = "BOOKING_DEPOSIT") => ({
    bookingId: String(bookingId),
    businessId: String(businessId),
    businessClientId: String(businessClientId),
    purpose,
  });

  it("persists the attempt before provider creation and stores the PI immediately", async () => {
    const original = gateway.createAndConfirmPaymentIntent.bind(gateway);
    gateway.createAndConfirmPaymentIntent = async (input) => {
      expect(await PaymentAttemptModel.countDocuments()).toBe(1);
      return original(input);
    };

    const result = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:durable-1",
      metadata: metadata(),
    });

    const attempt = await attempts.findByLogicalKey("booking:durable-1");
    expect(attempt?.providerPaymentIntentId).toBe(result.paymentIntentId);
    expect(attempt?.providerStatus).toBe("SUCCEEDED");
  });

  it("resumes one PI for duplicate and requires-action retries", async () => {
    gateway.queueNextChargeOutcome("requires_action");
    const first = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:3ds",
      metadata: metadata(),
    });
    gateway.succeedPaymentIntent(first.paymentIntentId);

    const second = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:3ds",
      metadata: metadata(),
    });

    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    expect(second.status).toBe("succeeded");
    expect(gateway.paymentIntentInputs).toHaveLength(1);
  });

  it("fails closed when one logical key changes immutable payment parameters", async () => {
    await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:conflict",
      metadata: metadata(),
    });
    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2100,
        idempotencyKey: "booking:conflict",
        metadata: metadata(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.paymentIntentInputs).toHaveLength(1);
  });

  it("rejects customer and purpose conflicts at the durable repository boundary", async () => {
    await attempts.createOrResume({
      logicalIdempotencyKey: "booking:repo-conflict",
      customerUserId: userId,
      businessId,
      bookingId,
      purpose: "BOOKING_DEPOSIT",
      productKind: "NORMAL_BOOKING",
      currency: "EUR",
      expectedAmountCents: 2000,
      providerCustomerId: "cus_durable",
    });
    await expect(
      attempts.createOrResume({
        logicalIdempotencyKey: "booking:repo-conflict",
        customerUserId: new Types.ObjectId(),
        businessId,
        bookingId,
        purpose: "PACKAGE_PURCHASE",
        productKind: "PACKAGE_PURCHASE",
        currency: "EUR",
        expectedAmountCents: 2000,
        providerCustomerId: "cus_other",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reconciles an ambiguous PI response before creating any replacement", async () => {
    const original = gateway.createAndConfirmPaymentIntent.bind(gateway);
    let first = true;
    gateway.createAndConfirmPaymentIntent = async (input) => {
      const result = await original(input);
      if (first) {
        first = false;
        throw new Error("connection lost after provider accepted request");
      }
      return result;
    };
    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: "booking:ambiguous",
        metadata: metadata(),
      }),
    ).rejects.toThrow("connection lost");

    const recovered = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:ambiguous",
      metadata: metadata(),
    });
    expect(recovered.status).toBe("succeeded");
    expect(gateway.paymentIntentInputs).toHaveLength(1);
  });

  it("finds a provider PI after a hard crash left the durable attempt at NOT_CREATED", async () => {
    const attempt = await attempts.createOrResume({
      logicalIdempotencyKey: "booking:hard-crash",
      customerUserId: userId,
      businessId,
      bookingId,
      purpose: "BOOKING_DEPOSIT",
      productKind: "NORMAL_BOOKING",
      currency: "EUR",
      expectedAmountCents: 2000,
      providerCustomerId: "cus_durable",
    });
    const providerResult = await gateway.createAndConfirmPaymentIntent({
      stripeCustomerId: "cus_durable",
      paymentMethodId: "pm_durable",
      amountCents: 2000,
      currency: "eur",
      idempotencyKey: `payment-attempt:${String(attempt._id)}`,
      offSession: false,
      saveForFutureUse: true,
      metadata: {
        ...metadata(),
        booklyPaymentAttemptId: String(attempt._id),
        booklyPaymentKey: "booking:hard-crash",
        booklyPaymentSchema: "p0-v1",
      },
    });

    const recovered = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:hard-crash",
      metadata: metadata(),
    });

    expect(recovered.paymentIntentId).toBe(providerResult.paymentIntentId);
    expect(gateway.paymentIntentInputs).toHaveLength(1);
    expect((await attempts.findByLogicalKey("booking:hard-crash"))?.providerStatus).toBe(
      "SUCCEEDED",
    );
  });

  it("fails closed when multiple provider PaymentIntents match one attempt", async () => {
    const attempt = await attempts.createOrResume({
      logicalIdempotencyKey: "booking:multiple-provider-pis",
      customerUserId: userId,
      businessId,
      bookingId,
      purpose: "BOOKING_DEPOSIT",
      productKind: "NORMAL_BOOKING",
      currency: "EUR",
      expectedAmountCents: 2000,
      providerCustomerId: "cus_durable",
    });
    for (const key of ["provider-pi-a", "provider-pi-b"]) {
      await gateway.createAndConfirmPaymentIntent({
        stripeCustomerId: "cus_durable",
        paymentMethodId: "pm_durable",
        amountCents: 2000,
        currency: "eur",
        idempotencyKey: key,
        offSession: false,
        saveForFutureUse: true,
        metadata: { ...metadata(), booklyPaymentAttemptId: String(attempt._id) },
      });
    }

    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: "booking:multiple-provider-pis",
        metadata: metadata(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.paymentIntentInputs).toHaveLength(2);
    expect((await attempts.findById(attempt._id))?.providerStatus).toBe("UNKNOWN");
  });

  it("binds a booking creation claim to its customer and business", async () => {
    const repository = new BookingCreationClaimRepository();
    await repository.claim({
      idempotencyKey: "booking:actor-bound",
      businessId,
      actorUserId: userId,
      bookingId,
    });
    await expect(
      repository.claim({
        idempotencyKey: "booking:actor-bound",
        businessId,
        actorUserId: new Types.ObjectId(),
        bookingId: new Types.ObjectId(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists and resumes an exact durable refund operation", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:refund-source",
      metadata: metadata(),
    });
    const sourceAttempt = await attempts.findByLogicalKey("booking:refund-source");
    const first = await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:durable-1",
      domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
      sourcePaymentAttemptId: sourceAttempt?._id,
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });
    const second = await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:durable-1",
      domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
      sourcePaymentAttemptId: sourceAttempt?._id,
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });

    expect(second.refundId).toBe(first.refundId);
    expect(gateway.refundInputs).toHaveLength(1);
    expect((await RefundOperationModel.findOne())?.providerRefundId).toBe(first.refundId);
  });

  it("reconciles an ambiguous refund response without issuing another refund", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:refund-ambiguous-source",
      metadata: metadata(),
    });
    const original = gateway.createRefund.bind(gateway);
    let first = true;
    gateway.createRefund = async (input) => {
      const result = await original(input);
      if (first) {
        first = false;
        throw new Error("connection lost after refund accepted");
      }
      return result;
    };
    const refundInput = {
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:ambiguous",
      domainReason: "BUSINESS_CANCELLATION",
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    } as const;
    await expect(service.refund(refundInput)).rejects.toThrow("connection lost");
    const recovered = await service.refund(refundInput);

    expect(recovered.status).toBe("succeeded");
    expect(gateway.refundInputs).toHaveLength(1);
  });

  it("recovers a refund accepted before a hard crash without creating another refund", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:refund-hard-crash-source",
      metadata: metadata(),
    });
    const operation = await refunds.createOrResume({
      logicalIdempotencyKey: "refund:hard-crash",
      sourcePaymentIntentId: payment.paymentIntentId,
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
      expectedRefundAmountCents: 2000,
      currency: "EUR",
      reason: "BUSINESS_CANCELLATION",
    });
    await refunds.markProviderCallStarted(operation._id);
    const providerRefund = await gateway.createRefund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      idempotencyKey: `refund-operation:${String(operation._id)}`,
      metadata: { booklyRefundOperationId: String(operation._id) },
    });

    const recovered = await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:hard-crash",
      domainReason: "BUSINESS_CANCELLATION",
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });

    expect(recovered.refundId).toBe(providerRefund.refundId);
    expect(gateway.refundInputs).toHaveLength(1);
    expect((await refunds.findById(operation._id))?.providerStatus).toBe("SUCCEEDED");
  });

  it("fails closed when multiple provider refunds match one operation", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:refund-multiple-source",
      metadata: metadata(),
    });
    const operation = await refunds.createOrResume({
      logicalIdempotencyKey: "refund:multiple",
      sourcePaymentIntentId: payment.paymentIntentId,
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
      expectedRefundAmountCents: 1000,
      currency: "EUR",
      reason: "BUSINESS_CANCELLATION",
    });
    await refunds.markProviderCallStarted(operation._id);
    for (const key of ["provider-refund-a", "provider-refund-b"]) {
      await gateway.createRefund({
        paymentIntentId: payment.paymentIntentId,
        amountCents: 1000,
        idempotencyKey: key,
        metadata: { booklyRefundOperationId: String(operation._id) },
      });
    }

    await expect(
      service.refund({
        paymentIntentId: payment.paymentIntentId,
        amountCents: 1000,
        currency: "EUR",
        idempotencyKey: "refund:multiple",
        domainReason: "BUSINESS_CANCELLATION",
        bookingId,
        businessId,
        businessClientId,
        customerUserId: userId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.refundInputs).toHaveLength(2);
    expect((await refunds.findById(operation._id))?.providerStatus).toBe("RECONCILIATION_REQUIRED");
  });

  it("does not mark a pending refund ledger as succeeded", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:pending-refund-source",
      metadata: metadata(),
    });
    gateway.queueNextRefundOutcome("pending");
    const result = await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:pending-ledger",
      domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });
    const operation = await refunds.findByLogicalKey("refund:pending-ledger");
    const ledgerId = new Types.ObjectId();
    await refunds.markLedgerSucceeded(operation?._id as Types.ObjectId, ledgerId);
    expect(
      (await refunds.findById(operation?._id as Types.ObjectId))?.succeededLedgerTransactionId,
    ).toBeUndefined();

    gateway.succeedRefund(result.refundId);
    await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:pending-ledger",
      domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });
    await refunds.markLedgerSucceeded(operation?._id as Types.ObjectId, ledgerId);
    expect(
      String(
        (await refunds.findById(operation?._id as Types.ObjectId))?.succeededLedgerTransactionId,
      ),
    ).toBe(String(ledgerId));
  });

  it("keeps terminal payment and refund provider states monotonic", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:monotonic",
      metadata: metadata(),
    });
    const attempt = await attempts.findByLogicalKey("booking:monotonic");
    await attempts.recordProviderResult(attempt?._id as Types.ObjectId, {
      providerPaymentIntentId: payment.paymentIntentId,
      providerStatus: "FAILED",
    });
    expect((await attempts.findById(attempt?._id as Types.ObjectId))?.providerStatus).toBe(
      "SUCCEEDED",
    );

    const refund = await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: "refund:monotonic",
      domainReason: "BUSINESS_CANCELLATION",
    });
    const operation = await refunds.findByLogicalKey("refund:monotonic");
    await refunds.recordProviderResult(operation?._id as Types.ObjectId, {
      providerRefundId: refund.refundId,
      providerStatus: "PROVIDER_PENDING",
    });
    expect((await refunds.findById(operation?._id as Types.ObjectId))?.providerStatus).toBe(
      "SUCCEEDED",
    );
  });

  it("P1.1: re-confirmable FAILED is superseded by provider SUCCEEDED; terminal states never regress", async () => {
    const charge = async (key: string) => {
      gateway.queueNextChargeOutcome("requires_action");
      const payment = await service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: key,
        metadata: metadata(),
      });
      const attempt = await attempts.findByLogicalKey(key);
      return { paymentIntentId: payment.paymentIntentId, id: attempt?._id as Types.ObjectId };
    };
    const statusOf = async (id: Types.ObjectId) => (await attempts.findById(id))?.providerStatus;

    // requires_payment_method after the client_secret was exposed -> FAILED, not a seal.
    const reconfirmed = await charge("booking:reconfirmed");
    await attempts.recordProviderResult(reconfirmed.id, {
      providerPaymentIntentId: reconfirmed.paymentIntentId,
      providerStatus: "FAILED",
    });
    await attempts.recordProviderResult(reconfirmed.id, {
      providerPaymentIntentId: reconfirmed.paymentIntentId,
      providerStatus: "SUCCEEDED",
    });
    expect(await statusOf(reconfirmed.id)).toBe("SUCCEEDED");
    // ...and the success is monotonic: neither a stale FAILED nor a CANCELED can reverse it.
    for (const providerStatus of ["FAILED", "CANCELED", "REQUIRES_ACTION"] as const) {
      await attempts.recordProviderResult(reconfirmed.id, {
        providerPaymentIntentId: reconfirmed.paymentIntentId,
        providerStatus,
      });
      expect(await statusOf(reconfirmed.id)).toBe("SUCCEEDED");
    }
    expect(await attempts.claimPersistence(reconfirmed.id)).toEqual(expect.any(String));

    // CANCELED is terminal: it supersedes FAILED and nothing supersedes it.
    const canceled = await charge("booking:canceled");
    await attempts.recordProviderResult(canceled.id, {
      providerPaymentIntentId: canceled.paymentIntentId,
      providerStatus: "FAILED",
    });
    await attempts.recordProviderResult(canceled.id, {
      providerPaymentIntentId: canceled.paymentIntentId,
      providerStatus: "CANCELED",
      lastErrorCode: "PROVIDER_CANCELED",
    });
    for (const providerStatus of [
      "SUCCEEDED",
      "FAILED",
      "REQUIRES_ACTION",
      "PROCESSING",
    ] as const) {
      await attempts.recordProviderResult(canceled.id, {
        providerPaymentIntentId: canceled.paymentIntentId,
        providerStatus,
      });
      expect(await statusOf(canceled.id)).toBe("CANCELED");
    }
    await attempts.markProviderUnknown(canceled.id, "late ambiguous response");
    const terminal = await attempts.findById(canceled.id);
    expect(terminal).toMatchObject({
      providerStatus: "CANCELED",
      lastErrorCode: "PROVIDER_CANCELED",
    });
    expect(await attempts.claimPersistence(canceled.id)).toBeNull();
  });

  it("P1.1: provider reconciliation records a canceled PaymentIntent with its terminal reason", async () => {
    gateway.queueNextChargeOutcome("requires_action");
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:reconcile-canceled",
      metadata: metadata(),
    });
    gateway.setPaymentIntentStatus(payment.paymentIntentId, "canceled");
    const attempt = await attempts.findByLogicalKey("booking:reconcile-canceled");

    const { attempt: reconciled, snapshot } = await service.reconcilePaymentAttempt(
      attempt?._id as Types.ObjectId,
    );

    expect(snapshot?.status).toBe("canceled");
    expect(reconciled).toMatchObject({
      providerStatus: "CANCELED",
      lastErrorCode: "PROVIDER_CANCELED",
      lastErrorMessage: "Stripe cancellation_reason: abandoned",
    });
  });

  it("P1.1.1: providerSucceededAt is stamped once, on the first transition into SUCCEEDED", async () => {
    // Synchronous success at creation.
    const before = Date.now();
    await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:success-clock-sync",
      metadata: metadata(),
    });
    const sync = await attempts.findByLogicalKey("booking:success-clock-sync");
    expect(sync?.providerSucceededAt?.getTime()).toBeGreaterThanOrEqual(before);

    // requires_action -> FAILED (re-confirmable) -> SUCCEEDED, then duplicate SUCCEEDED writes.
    gateway.queueNextChargeOutcome("requires_action");
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:success-clock",
      metadata: metadata(),
    });
    const id = (await attempts.findByLogicalKey("booking:success-clock"))?._id as Types.ObjectId;
    const record = (providerStatus: "FAILED" | "SUCCEEDED") =>
      attempts.recordProviderResult(id, {
        providerPaymentIntentId: payment.paymentIntentId,
        providerStatus,
      });
    expect((await attempts.findById(id))?.providerSucceededAt).toBeUndefined();
    await record("FAILED");
    expect((await attempts.findById(id))?.providerSucceededAt).toBeUndefined();
    const first = (await record("SUCCEEDED")).providerSucceededAt?.getTime();
    expect(first).toEqual(expect.any(Number));
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 3; index += 1) {
      expect((await record("SUCCEEDED")).providerSucceededAt?.getTime()).toBe(first);
    }
    // Persistence and compensation retries never touch it either.
    const token = (await attempts.claimPersistence(id)) as string;
    await attempts.markCompensationRequired(id, "persistence failed", token);
    await attempts.claimCompensation(id);
    expect((await attempts.findById(id))?.providerSucceededAt?.getTime()).toBe(first);
  });

  it("P1.1.1: markProviderNotCreated closes only an attempt with no recorded provider state", async () => {
    const create = async (key: string) =>
      attempts.createOrResume({
        logicalIdempotencyKey: key,
        customerUserId: userId,
        businessId,
        bookingId,
        purpose: "BOOKING_DEPOSIT",
        productKind: "NORMAL_BOOKING",
        currency: "EUR",
        expectedAmountCents: 2000,
        providerCustomerId: "cus_durable",
      });

    // Eligible: NOT_CREATED and UNKNOWN with no PaymentIntent recorded.
    const unsent = await create("booking:unsent");
    expect(await attempts.markProviderNotCreated(unsent._id)).toBe(true);
    expect(await attempts.markProviderNotCreated(unsent._id)).toBe(false);
    expect(await attempts.findById(unsent._id)).toMatchObject({
      providerStatus: "FAILED",
      lastErrorCode: "PROVIDER_NOT_CREATED",
    });
    const unknown = await create("booking:unknown");
    await attempts.markProviderUnknown(unknown._id, "timeout");
    expect(await attempts.markProviderNotCreated(unknown._id)).toBe(true);

    // Refused: a recorded PaymentIntent, a terminal state, or started persistence/compensation.
    const withPi = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:with-pi",
      metadata: metadata(),
    });
    const withPiAttempt = await attempts.findByLogicalKey("booking:with-pi");
    expect(await attempts.markProviderNotCreated(withPiAttempt?._id as Types.ObjectId)).toBe(false);
    expect((await attempts.findById(withPiAttempt?._id as Types.ObjectId))?.providerStatus).toBe(
      "SUCCEEDED",
    );
    expect(withPi.status).toBe("succeeded");
    for (const field of [{ persistenceStatus: "PERSISTING" }, { compensationStatus: "REQUIRED" }]) {
      const guarded = await create(`booking:guarded-${Object.keys(field)[0]}`);
      await PaymentAttemptModel.collection.updateOne({ _id: guarded._id }, { $set: field });
      expect(await attempts.markProviderNotCreated(guarded._id), JSON.stringify(field)).toBe(false);
    }

    // A closed attempt can never dispatch again under its logical key...
    const inputsBefore = gateway.paymentIntentInputs.length;
    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: "booking:unsent",
        metadata: metadata(),
      }),
    ).rejects.toMatchObject({ statusCode: 402, details: [{ code: "PAYMENT_FAILED" }] });
    expect(gateway.paymentIntentInputs).toHaveLength(inputsBefore);

    // ...yet an authoritative later success (a PaymentIntent that surfaced anyway) supersedes it.
    const surfaced = await attempts.recordProviderResult(unsent._id, {
      providerPaymentIntentId: "pi_surfaced_late",
      providerStatus: "SUCCEEDED",
    });
    expect(surfaced).toMatchObject({
      providerStatus: "SUCCEEDED",
      providerPaymentIntentId: "pi_surfaced_late",
    });
    expect(surfaced.providerSucceededAt).toBeInstanceOf(Date);
  });

  it("P1.1.1: the strong existence check records a found PI and closes only a proven-absent one", async () => {
    // Created at Stripe but the response was lost, and search lags.
    const original = gateway.createAndConfirmPaymentIntent.bind(gateway);
    gateway.createAndConfirmPaymentIntent = async (input) => {
      gateway.createAndConfirmPaymentIntent = original;
      await original(input);
      throw new Error("connection lost after provider accepted request");
    };
    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: "booking:lost",
        metadata: metadata(),
      }),
    ).rejects.toThrow("connection lost");
    gateway.searchLagging = true;
    const lost = await attempts.findByLogicalKey("booking:lost");
    expect(lost?.providerStatus).toBe("UNKNOWN");

    const found = await service.resolveUnsentPaymentAttempt(lost?._id as Types.ObjectId);
    expect(found.providerStatus).toBe("SUCCEEDED");
    expect(found.providerPaymentIntentId).toEqual(expect.any(String));
    expect(gateway.paymentIntentInputs).toHaveLength(1);

    // Never reached Stripe.
    gateway.createAndConfirmPaymentIntent = async () => {
      gateway.createAndConfirmPaymentIntent = original;
      throw new Error("connection refused before the request was sent");
    };
    await expect(
      service.chargeBookingDeposit({
        userId,
        amountCents: 2000,
        idempotencyKey: "booking:never-sent",
        metadata: metadata(),
      }),
    ).rejects.toThrow("connection refused");
    const neverSent = await attempts.findByLogicalKey("booking:never-sent");
    const closed = await service.resolveUnsentPaymentAttempt(neverSent?._id as Types.ObjectId);
    expect(closed).toMatchObject({
      providerStatus: "FAILED",
      lastErrorCode: "PROVIDER_NOT_CREATED",
    });

    // Provider uncertainty writes nothing.
    const uncertain = await attempts.createOrResume({
      logicalIdempotencyKey: "booking:uncertain",
      customerUserId: userId,
      businessId,
      bookingId,
      purpose: "BOOKING_DEPOSIT",
      productKind: "NORMAL_BOOKING",
      currency: "EUR",
      expectedAmountCents: 2000,
      providerCustomerId: "cus_durable",
    });
    gateway.failNextCustomerList(new Error("stripe list unavailable"));
    await expect(service.resolveUnsentPaymentAttempt(uncertain._id)).rejects.toThrow(
      "stripe list unavailable",
    );
    expect((await attempts.findById(uncertain._id))?.providerStatus).toBe("NOT_CREATED");
  });

  it("enriches an existing business-cancellation refund for package void reuse", async () => {
    const packageProgressId = new Types.ObjectId();
    const original = await refunds.createOrResume({
      logicalIdempotencyKey: `business-cancel-refund:${String(bookingId)}`,
      sourcePaymentIntentId: "pi_package_reuse",
      sourceFinancialTransactionId: new Types.ObjectId(),
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
      expectedRefundAmountCents: 2000,
      currency: "EUR",
      reason: "BUSINESS_CANCELLATION",
    });
    const reused = await refunds.createOrResume({
      logicalIdempotencyKey: `business-cancel-refund:${String(bookingId)}`,
      sourcePaymentIntentId: "pi_package_reuse",
      sourceFinancialTransactionId: original.sourceFinancialTransactionId,
      bookingId,
      packageProgressId,
      businessId,
      businessClientId,
      customerUserId: userId,
      expectedRefundAmountCents: 2000,
      currency: "EUR",
      reason: "PACKAGE_VOID",
    });
    expect(String(reused._id)).toBe(String(original._id));
    expect(String(reused.packageProgressId)).toBe(String(packageProgressId));
  });

  it("keeps provider success anchored through persistence failure and compensation", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:persistence-failure",
      metadata: metadata(),
    });
    const persistenceToken = await service.claimPaymentPersistence(payment.paymentAttemptId);
    expect(persistenceToken).toEqual(expect.any(String));
    await service.markPaymentCompensationRequired(
      payment.paymentAttemptId,
      new Error("boom"),
      persistenceToken ?? undefined,
    );
    let attempt = await attempts.findByLogicalKey("booking:persistence-failure");
    expect(attempt).toMatchObject({
      providerStatus: "SUCCEEDED",
      persistenceStatus: "FAILED",
      compensationStatus: "REQUIRED",
    });

    await service.refund({
      paymentIntentId: payment.paymentIntentId,
      amountCents: 2000,
      currency: "EUR",
      idempotencyKey: `refund:${payment.paymentIntentId}:compensation`,
      domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
      sourcePaymentAttemptId: attempt?._id,
      bookingId,
      businessId,
      businessClientId,
      customerUserId: userId,
    });
    attempt = await attempts.findByLogicalKey("booking:persistence-failure");
    expect(attempt?.compensationStatus).toBe("REFUNDED");
  });

  it("rejects stale payment persistence completion and compensation after lease reclaim", async () => {
    const payment = await service.chargeBookingDeposit({
      userId,
      amountCents: 2000,
      idempotencyKey: "booking:fenced-persistence",
      metadata: metadata(),
    });
    const tokenA = await attempts.claimPersistence(payment.paymentAttemptId as string);
    await PaymentAttemptModel.updateOne(
      { _id: new Types.ObjectId(payment.paymentAttemptId) },
      { $set: { persistenceLeaseExpiresAt: new Date(Date.now() - 1000) } },
    );
    const tokenB = await attempts.claimPersistence(payment.paymentAttemptId as string);

    expect(tokenA).toEqual(expect.any(String));
    expect(tokenB).toEqual(expect.any(String));
    expect(tokenB).not.toBe(tokenA);
    expect(
      await attempts.markCompleted(
        payment.paymentAttemptId as string,
        { bookingId },
        tokenA as string,
      ),
    ).toBe(false);
    expect(
      await attempts.markCompensationRequired(
        payment.paymentAttemptId as string,
        "stale owner",
        tokenA as string,
      ),
    ).toBe(false);
    expect(
      await attempts.markCompleted(
        payment.paymentAttemptId as string,
        { bookingId },
        tokenB as string,
      ),
    ).toBe(true);
  });

  it("reclaims an expired webhook lease but not an active lease", async () => {
    const repository = new StripeWebhookEventRepository();
    expect(await repository.claim("evt_1", "payment_intent.succeeded", { id: "evt_1" })).toEqual(
      expect.any(String),
    );
    expect(await repository.claim("evt_1", "payment_intent.succeeded", { id: "evt_1" })).toBeNull();
    await StripeWebhookEventModel.updateOne(
      { eventId: "evt_1" },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await repository.claimNextDue())?.eventId).toBe("evt_1");
  });

  it("internally reclaims a due RETRYABLE webhook without Stripe redelivery", async () => {
    const repository = new StripeWebhookEventRepository();
    const token = await repository.claim("evt_retry", "payment_intent.succeeded", {
      id: "evt_retry",
    });
    await repository.markRetryable("evt_retry", token as string, "dependency not ready");
    await StripeWebhookEventModel.updateOne(
      { eventId: "evt_retry" },
      { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
    );
    const reclaimed = await repository.claimNextDue();
    expect(reclaimed).toMatchObject({ eventId: "evt_retry", status: "PROCESSING" });
    expect(reclaimed?.attemptCount).toBe(2);
  });

  it("prevents a stale webhook worker from regressing a newer processed claim", async () => {
    const repository = new StripeWebhookEventRepository();
    const tokenA = await repository.claim("evt_fenced", "payment_intent.succeeded", {
      id: "evt_fenced",
    });
    await StripeWebhookEventModel.updateOne(
      { eventId: "evt_fenced" },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
    );
    const reclaimed = await repository.claimNextDue();
    const tokenB = reclaimed?.processingLeaseToken as string;
    expect(await repository.markProcessed("evt_fenced", tokenB)).toBe(true);
    expect(await repository.markRetryable("evt_fenced", tokenA as string, "stale")).toBe(false);
    expect(await repository.markFailed("evt_fenced", tokenA as string, "stale")).toBe(false);
    expect(await repository.markProcessed("evt_fenced", tokenA as string)).toBe(false);
    expect((await StripeWebhookEventModel.findOne({ eventId: "evt_fenced" }))?.status).toBe(
      "PROCESSED",
    );
  });

  it("moves a poison webhook to FAILED at the bounded retry ceiling", async () => {
    const repository = new StripeWebhookEventRepository();
    let token = await repository.claim("evt_poison", "payment_intent.succeeded", {
      id: "evt_poison",
    });
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await repository.markRetryable("evt_poison", token as string, "malformed payload");
      if (attempt < 8) {
        await StripeWebhookEventModel.updateOne(
          { eventId: "evt_poison" },
          { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
        );
        token = (await repository.claimNextDue())?.processingLeaseToken ?? null;
      }
    }
    expect((await StripeWebhookEventModel.findOne({ eventId: "evt_poison" }))?.status).toBe(
      "FAILED",
    );
  });
});
