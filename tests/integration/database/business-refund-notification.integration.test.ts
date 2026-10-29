import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingEmailDeliveryEligibility } from "../../../src/modules/booking/booking-email-delivery-eligibility.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import {
  convergeBusinessRefundSettlementProjection,
  ensureBusinessRefundNotification,
} from "../../../src/modules/payment/business-refund-notification.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import type { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import type { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { buildBusiness, buildCancelledBooking } from "../../unit/stage-d-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("ordinary Business refund final notification", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const seed = async (
    status: "SUCCEEDED" | "FAILED" | "PROVIDER_PENDING" = "SUCCEEDED",
    version: 1 | undefined = 1,
  ) => {
    const business = buildBusiness();
    const booking = buildCancelledBooking(
      {
        refundOwedCents: 700,
        settlementStatus: status === "PROVIDER_PENDING" ? "PENDING" : status,
        settlementProviderReference: "re_exact",
      },
      { businessId: business._id, status: "CANCELLED_BY_BUSINESS" },
    );
    const sourceId = new Types.ObjectId(),
      refundLedgerId = new Types.ObjectId(),
      operationId = new Types.ObjectId();
    const source = {
      _id: sourceId,
      bookingId: booking._id,
      businessId: business._id,
      businessClientId: booking.customer.businessClientId,
      customerUserId: booking.customer.customerUserId,
      type: "PLATFORM_FEE",
      direction: "CREDIT",
      status: "SUCCEEDED",
      amountCents: 700,
      currency: "EUR",
      providerReference: "pi_exact",
    };
    await BusinessModel.collection.insertOne(business as never);
    await BookingModel.collection.insertOne(booking as never);
    await UserModel.collection.insertOne({
      _id: business.ownerUserId,
      normalizedEmail: "owner@example.com",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    } as never);
    await BookingFinancialTransactionModel.collection.insertOne(source as never);
    await PaymentAttemptModel.collection.insertOne({
      _id: new Types.ObjectId(),
      providerPaymentIntentId: "pi_exact",
      bookingId: booking._id,
      businessId: business._id,
      businessClientId: booking.customer.businessClientId,
      customerUserId: booking.customer.customerUserId,
      purpose: "BOOKING_DEPOSIT",
      productKind: "NORMAL_BOOKING",
      providerStatus: "SUCCEEDED",
      persistenceStatus: "COMPLETED",
      compensationStatus: "NOT_REQUIRED",
      succeededTransactionId: sourceId,
    } as never);
    if (status === "SUCCEEDED")
      await BookingFinancialTransactionModel.collection.insertOne({
        _id: refundLedgerId,
        bookingId: booking._id,
        businessId: business._id,
        businessClientId: booking.customer.businessClientId,
        customerUserId: booking.customer.customerUserId,
        type: "REFUND",
        direction: "CREDIT",
        status: "SUCCEEDED",
        amountCents: 700,
        currency: "EUR",
        providerReference: "re_exact",
        idempotencyKey: `refund-operation:${String(operationId)}:ledger`,
        metadata: { sourceTransactionId: String(sourceId), sourceType: "PLATFORM_FEE" },
      } as never);
    await RefundOperationModel.collection.insertOne({
      _id: operationId,
      logicalIdempotencyKey: `business-cancel-refund:${String(booking._id)}`,
      sourceFinancialTransactionId: sourceId,
      sourcePaymentIntentId: "pi_exact",
      bookingId: booking._id,
      businessId: business._id,
      businessClientId: booking.customer.businessClientId,
      customerUserId: booking.customer.customerUserId,
      expectedRefundAmountCents: 700,
      currency: "EUR",
      reason: "BUSINESS_CANCELLATION",
      provider: "STRIPE",
      providerRefundId: "re_exact",
      providerStatus: status,
      ...(version ? { finalNotificationProtocolVersion: version } : {}),
      ...(status === "SUCCEEDED" ? { succeededLedgerTransactionId: refundLedgerId } : {}),
      updatedAt: new Date(),
      createdAt: new Date(),
    } as never);
    return { booking, business, operationId, refundLedgerId };
  };

  it("records the exact settled event and marker once, then treats webhook/recovery replay as the same event", async () => {
    const { booking, operationId } = await seed();
    expect(
      (await new RefundOperationRepository().listFinalNotificationPending(10)).map((row) =>
        String(row._id),
      ),
    ).toContain(String(operationId));
    expect(await ensureBusinessRefundNotification(operationId)).toBe("RECORDED");
    expect(await ensureBusinessRefundNotification(operationId)).toBe("ALREADY_RECORDED");
    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.eventKey ===
            `BUSINESS_REFUND:${String(booking._id)}:${String(operationId)}:SUCCEEDED` &&
          row.status === "PENDING",
      ),
    ).toBe(true);
    expect(
      (await RefundOperationModel.findById(operationId))?.finalNotificationRecordedAt,
    ).toBeInstanceOf(Date);
    expect(await new RefundOperationRepository().listFinalNotificationPending(10)).toHaveLength(0);
  });

  it("does not promote pending, historical, or mismatched financial evidence", async () => {
    const pending = await seed("PROVIDER_PENDING");
    expect(await ensureBusinessRefundNotification(pending.operationId)).toBe("NOT_READY");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    await clearIsolatedDatabase();
    const historical = await seed("SUCCEEDED", undefined);
    expect(await ensureBusinessRefundNotification(historical.operationId)).toBe("NOT_APPLICABLE");
    expect(await new RefundOperationRepository().listFinalNotificationPending(10)).toHaveLength(0);
    await clearIsolatedDatabase();
    const wrong = await seed();
    await BookingFinancialTransactionModel.updateOne(
      { _id: wrong.refundLedgerId },
      { $set: { amountCents: 701 } },
    );
    expect(await ensureBusinessRefundNotification(wrong.operationId)).toBe("NOT_READY");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
  });

  it("uses a definitive provider FAILED result without describing a pending result as final", async () => {
    const { booking, operationId } = await seed("FAILED");
    expect(await ensureBusinessRefundNotification(operationId)).toBe("RECORDED");
    expect(
      (await EmailOutboxModel.find({}).lean()).every(
        (row) =>
          row.eventKey === `BUSINESS_REFUND:${String(booking._id)}:${String(operationId)}:FAILED`,
      ),
    ).toBe(true);
  });

  it("refuses a foreign Business binding and an unusable original Customer recipient", async () => {
    const foreign = await seed();
    await RefundOperationModel.updateOne(
      { _id: foreign.operationId },
      { $set: { businessId: new Types.ObjectId() } },
    );
    expect(await ensureBusinessRefundNotification(foreign.operationId)).toBe("NOT_READY");
    await clearIsolatedDatabase();
    const recipient = await seed();
    await BookingModel.updateOne(
      { _id: recipient.booking._id },
      { $set: { "customer.contact.normalizedEmail": "" } },
    );
    expect(await ensureBusinessRefundNotification(recipient.operationId)).toBe("NOT_READY");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
  });

  it("rolls back both intent and marker if an outbox insert fails after the first recipient", async () => {
    const { operationId } = await seed();
    const realRepository = new EmailOutboxRepository();
    const original = realRepository.enqueue.bind(realRepository);
    let calls = 0;
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockImplementation(
      async (input, session) => {
        calls += 1;
        if (calls === 2) throw new Error("outbox unavailable");
        return original(input, session);
      },
    );
    await expect(ensureBusinessRefundNotification(operationId)).rejects.toThrow(
      "outbox unavailable",
    );
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    expect(
      (await RefundOperationModel.findById(operationId))?.finalNotificationRecordedAt,
    ).toBeUndefined();
    vi.restoreAllMocks();
    expect(await ensureBusinessRefundNotification(operationId)).toBe("RECORDED");
  });

  // --- P4B-1R completion (Claude) ----------------------------------------------------------

  const customerRow = (bookingId: Types.ObjectId, operationId: Types.ObjectId, status: string) =>
    EmailOutboxModel.findOne({
      eventKey: `BUSINESS_REFUND:${String(bookingId)}:${String(operationId)}:${status}`,
      templateKey: "BOOKING_CANCELLED_CUSTOMER",
    });

  const recovery = () =>
    new MoneyRecoveryService(
      {} as PaymentService,
      new PaymentAttemptRepository(),
      new RefundOperationRepository(),
      new BookingRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      { recoverDue: async () => ({ processed: 0, failed: 0 }) } as unknown as StripeWebhookService,
    );

  it("refuses a different Customer binding and conflicting provider references", async () => {
    const customer = await seed();
    await RefundOperationModel.updateOne(
      { _id: customer.operationId },
      { $set: { customerUserId: new Types.ObjectId() } },
    );
    expect(await ensureBusinessRefundNotification(customer.operationId)).toBe("NOT_READY");
    await clearIsolatedDatabase();
    const bookingReference = await seed();
    await BookingModel.updateOne(
      { _id: bookingReference.booking._id },
      { $set: { "cancellationOutcome.settlementProviderReference": "re_other" } },
    );
    expect(await ensureBusinessRefundNotification(bookingReference.operationId)).toBe("NOT_READY");
    await clearIsolatedDatabase();
    const ledgerReference = await seed();
    await BookingFinancialTransactionModel.updateOne(
      { _id: ledgerReference.refundLedgerId },
      { $set: { providerReference: "re_other" } },
    );
    expect(await ensureBusinessRefundNotification(ledgerReference.operationId)).toBe("NOT_READY");
    await clearIsolatedDatabase();
    const wrongBooking = await seed();
    await RefundOperationModel.updateOne(
      { _id: wrongBooking.operationId },
      { $set: { bookingId: new Types.ObjectId() } },
    );
    expect(await ensureBusinessRefundNotification(wrongBooking.operationId)).toBe("NOT_READY");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
  });

  it("never applies the ordinary event to a Package-linked refund operation", async () => {
    const { operationId } = await seed();
    await RefundOperationModel.updateOne(
      { _id: operationId },
      { $set: { packageProgressId: new Types.ObjectId() } },
    );
    expect(await ensureBusinessRefundNotification(operationId)).toBe("NOT_APPLICABLE");
    expect(await new RefundOperationRepository().listFinalNotificationPending(10)).toHaveLength(0);
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
  });

  it("does not record the marker when the Customer outbox row was not established", async () => {
    const { operationId } = await seed();
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockImplementation(async () => ({
      created: false,
      record: {} as never,
    }));
    await expect(ensureBusinessRefundNotification(operationId)).rejects.toThrow(
      "Refund notification outbox intent was not established",
    );
    vi.restoreAllMocks();
    expect(
      (await RefundOperationModel.findById(operationId))?.finalNotificationRecordedAt,
    ).toBeUndefined();
    expect(await new RefundOperationRepository().listFinalNotificationPending(10)).toHaveLength(1);
  });

  it("concurrent synchronous and webhook convergence produce one intent set and one marker", async () => {
    const { booking, operationId } = await seed();
    const results = await Promise.allSettled([
      ensureBusinessRefundNotification(operationId),
      ensureBusinessRefundNotification(operationId),
    ]);
    const values = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(values).toContain("RECORDED");
    expect(values.every((value) => value === "RECORDED" || value === "ALREADY_RECORDED")).toBe(
      true,
    );
    expect(values.filter((value) => value === "RECORDED")).toHaveLength(1);
    expect(await EmailOutboxModel.countDocuments({})).toBe(2);
    expect(await customerRow(booking._id, operationId, "SUCCEEDED")).not.toBeNull();
    expect(await ensureBusinessRefundNotification(operationId)).toBe("ALREADY_RECORDED");
  });

  it("money recovery converges a crash after settlement and is idempotent across passes", async () => {
    const { booking, operationId } = await seed();
    const first = await recovery().runOnce(10);
    expect(first.errors).toBe(0);
    expect(await customerRow(booking._id, operationId, "SUCCEEDED")).not.toBeNull();
    const second = await recovery().runOnce(10);
    expect(second.errors).toBe(0);
    expect(await EmailOutboxModel.countDocuments({})).toBe(2);
    expect(
      (await RefundOperationModel.findById(operationId))?.finalNotificationRecordedAt,
    ).toBeInstanceOf(Date);
  });

  it("recovery projects a definitive FAILED result whose Booking write was interrupted", async () => {
    const { booking, operationId } = await seed("FAILED");
    // Crash window: the RefundOperation recorded FAILED but the Booking still says PENDING.
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: { "cancellationOutcome.settlementStatus": "PENDING" },
        $unset: { "cancellationOutcome.settlementProviderReference": 1 },
      },
    );
    expect(await ensureBusinessRefundNotification(operationId)).toBe("NOT_READY");
    await recovery().runOnce(10);
    const projected = await BookingModel.findById(booking._id).lean();
    expect(projected?.cancellationOutcome?.settlementStatus).toBe("FAILED");
    expect(projected?.cancellationOutcome?.settlementProviderReference).toBe("re_exact");
    expect(await customerRow(booking._id, operationId, "FAILED")).not.toBeNull();
    expect(await EmailOutboxModel.countDocuments({ eventKey: { $regex: ":SUCCEEDED$" } })).toBe(0);
  });

  it("recovery never overwrites conflicting Booking settlement evidence", async () => {
    const { booking, operationId } = await seed("FAILED");
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { "cancellationOutcome.settlementStatus": "SUCCEEDED" } },
    );
    expect(await convergeBusinessRefundSettlementProjection(operationId)).toBe(false);
    const result = await recovery().runOnce(10);
    expect(result.errors).toBe(0);
    expect(
      (await BookingModel.findById(booking._id).lean())?.cancellationOutcome?.settlementStatus,
    ).toBe("SUCCEEDED");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    const operation = await RefundOperationModel.findById(operationId);
    expect(operation?.finalNotificationRecordedAt).toBeUndefined();
    expect(operation?.nextRecoveryAt).toBeInstanceOf(Date);
  });

  it("recovery leaves pending and historical operations untouched", async () => {
    const pending = await seed("PROVIDER_PENDING");
    expect(await convergeBusinessRefundSettlementProjection(pending.operationId)).toBe(false);
    await recovery().runOnce(10);
    expect(
      (await BookingModel.findById(pending.booking._id).lean())?.cancellationOutcome
        ?.settlementStatus,
    ).toBe("PENDING");
    await clearIsolatedDatabase();
    const historical = await seed("FAILED", undefined);
    await BookingModel.updateOne(
      { _id: historical.booking._id },
      { $set: { "cancellationOutcome.settlementStatus": "PENDING" } },
    );
    expect(await convergeBusinessRefundSettlementProjection(historical.operationId)).toBe(false);
    await recovery().runOnce(10);
    expect(
      (await BookingModel.findById(historical.booking._id).lean())?.cancellationOutcome
        ?.settlementStatus,
    ).toBe("PENDING");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    const row = await RefundOperationModel.findById(historical.operationId).lean();
    expect(row?.finalNotificationRecordedAt).toBeUndefined();
    expect(row?.nextRecoveryAt).toBeUndefined();
  });

  it("final-send eligibility accepts the recorded event and rejects it without the marker", async () => {
    const { booking, operationId } = await seed();
    expect(await ensureBusinessRefundNotification(operationId)).toBe("RECORDED");
    const eligibility = new BookingEmailDeliveryEligibility();
    const customer = await customerRow(booking._id, operationId, "SUCCEEDED");
    const owner = await EmailOutboxModel.findOne({ templateKey: "BOOKING_CANCELLED_OWNER" });
    expect(customer && (await eligibility.check(customer, new Date()))).toBe(true);
    expect(owner && (await eligibility.check(owner, new Date()))).toBe(true);
    await RefundOperationModel.updateOne(
      { _id: operationId },
      { $unset: { finalNotificationRecordedAt: 1 } },
    );
    expect(customer && (await eligibility.check(customer, new Date()))).toBe(false);
  });
});
