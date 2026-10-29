import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundRecoveryIncidentService } from "../../../src/modules/payment/refund-recovery-incident.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("P5-F1 durable refund incident observations and alert intent", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });
  const seed = async () =>
    RefundOperationModel.create({
      logicalIdempotencyKey: `test:${new Types.ObjectId()}`,
      sourcePaymentIntentId: "pi_private",
      businessId: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      businessClientId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      expectedRefundAmountCents: 701,
      currency: "EUR",
      reason: "BUSINESS_CANCELLATION",
      finalNotificationProtocolVersion: 1,
      providerStatus: "SUCCEEDED",
      providerRefundId: "re_private",
    });
  const policy = { recipients: ["ops@example.com"], minObservations: 2, minAgeMs: 0 };

  it("deduplicates concurrent observations into one episode, retaining exact Business and operation", async () => {
    const row = await seed();
    const before = row.toObject();
    const monitor = new RefundRecoveryIncidentService();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        monitor.observe(row._id, "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED"),
      ),
    );
    const after = (await RefundOperationModel.findById(row._id).orFail()).toObject();
    expect(after.recoveryIncident).toMatchObject({ state: "OPEN", observations: 6 });
    expect(after.businessId).toEqual(before.businessId);
    for (const field of [
      "providerStatus",
      "expectedRefundAmountCents",
      "providerRefundId",
      "logicalIdempotencyKey",
    ] as const)
      expect(after[field]).toEqual(before[field]);
    expect(after.updatedAt).toEqual(before.updatedAt);
    await monitor.poll(5);
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    expect((await RefundOperationModel.findById(row._id))?.updatedAt).toEqual(before.updatedAt);
  });

  it("requires both thresholds, atomically queues once per episode/recipient and exposes no financial payload", async () => {
    const row = await seed();
    const monitor = new RefundRecoveryIncidentService(policy);
    await monitor.observe(row._id, "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED");
    await monitor.poll(5);
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    await monitor.observe(row._id, "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED");
    await Promise.all([monitor.poll(5), monitor.poll(5)]);
    await monitor.poll(5);
    const emails = await EmailOutboxModel.find({}).lean();
    expect(emails).toHaveLength(1);
    expect(emails[0]?.payload).toMatchObject({
      kind: "REFUND_RECOVERY_CONFLICT",
      businessId: String(row.businessId),
    });
    expect(emails[0]?.eventKey).toContain(String(row._id));
    expect(emails[0]?.recipient).toBe("ops@example.com");
    const payload = JSON.stringify(emails[0]?.payload);
    for (const value of ["pi_private", "re_private", "customerUserId", "logicalIdempotencyKey"])
      expect(payload).not.toContain(value);
    expect(emails[0]?.payload).not.toHaveProperty("amountFormatted");
    expect(emails[0]?.payload).not.toHaveProperty("amountCents");
    expect(
      (await RefundOperationModel.findById(row._id))?.recoveryIncident?.alertedAt,
    ).toBeInstanceOf(Date);
  });

  it("does not queue before the explicitly configured age threshold", async () => {
    const row = await seed();
    const monitor = new RefundRecoveryIncidentService({
      ...policy,
      minObservations: 1,
      minAgeMs: 60_000,
    });
    await monitor.observe(row._id, "REFUND_RECOVERY_FAILED");
    await monitor.poll(5);
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { "recoveryIncident.openedAt": new Date(Date.now() - 60_001) } },
    );
    await monitor.poll(5);
    expect(await EmailOutboxModel.countDocuments({})).toBe(1);
  });

  it("rolls back outbox writes and the intent marker together on enqueue failure, then retries", async () => {
    const row = await seed();
    const twoRecipients = {
      ...policy,
      recipients: ["ops@example.com", "reviewer@example.com"],
      minObservations: 1,
    };
    const outbox = new EmailOutboxService();
    let enqueued = 0;
    const monitor = new RefundRecoveryIncidentService(twoRecipients, {
      enqueue: async (input, session) => {
        const result = await outbox.enqueue(input, session);
        if (++enqueued === 2) throw new Error("sensitive provider exception must not be logged");
        return result;
      },
    });
    await monitor.observe(row._id, "FINAL_NOTIFICATION_RECONCILIATION_FAILED");
    await expect(monitor.poll(5)).rejects.toThrow("monitoring incomplete");
    expect(
      (await RefundOperationModel.findById(row._id))?.recoveryIncident?.alertedAt,
    ).toBeUndefined();
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    await new RefundRecoveryIncidentService(twoRecipients).poll(5);
    expect(await EmailOutboxModel.countDocuments({})).toBe(2);
  });

  it("resolves only after a new authoritative final-notification marker, and a later conflict opens a new episode", async () => {
    const row = await seed();
    const monitor = new RefundRecoveryIncidentService();
    await monitor.observe(row._id, "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED");
    const episode = (await RefundOperationModel.findById(row._id))?.recoveryIncident?.episodeId;
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe("OPEN");
    // Synthetic canonical transaction result; real financial checks remain in the P4B-1R suite.
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { finalNotificationRecordedAt: new Date() } },
    );
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe(
      "RESOLVED",
    );
    await monitor.observe(row._id, "REFUND_RECOVERY_FAILED");
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.episodeId).not.toEqual(
      episode,
    );
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.observations).toBe(1);
  });

  it("does not resolve a new conflict from an old marker or a provider success alone", async () => {
    const row = await seed();
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { finalNotificationRecordedAt: new Date(0) } },
    );
    const monitor = new RefundRecoveryIncidentService();
    await monitor.observe(row._id, "REFUND_RECOVERY_FAILED");
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe("OPEN");
  });

  it("does not open an incident for a stale notification observation after the canonical marker committed", async () => {
    const row = await seed();
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { finalNotificationRecordedAt: new Date() } },
    );
    await new RefundRecoveryIncidentService().observe(
      row._id,
      "FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED",
    );
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident).toBeUndefined();
  });

  it("leaves Package authority incidents open even if provider evidence is terminal", async () => {
    const row = await seed();
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { packageProgressId: new Types.ObjectId() } },
    );
    const monitor = new RefundRecoveryIncidentService();
    await monitor.observe(row._id, "REFUND_RECOVERY_FAILED");
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $set: { finalNotificationRecordedAt: new Date(), lastReconciledAt: new Date() } },
    );
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe("OPEN");
  });

  it("requires exact ledger correlation and newly reconciled evidence for non-opt-in refunds", async () => {
    const row = await seed();
    await RefundOperationModel.updateOne(
      { _id: row._id },
      { $unset: { finalNotificationProtocolVersion: 1 } },
    );
    const monitor = new RefundRecoveryIncidentService();
    await monitor.observe(row._id, "REFUND_RECOVERY_FAILED");
    const ledgerId = new Types.ObjectId();
    await BookingFinancialTransactionModel.collection.insertOne({
      _id: ledgerId,
      businessId: row.businessId,
      bookingId: row.bookingId,
      businessClientId: row.businessClientId,
      customerUserId: row.customerUserId,
      type: "REFUND",
      direction: "CREDIT",
      status: "SUCCEEDED",
      currency: "EUR",
      amountCents: 700,
      providerReference: row.providerRefundId,
      idempotencyKey: `refund-operation:${String(row._id)}:ledger`,
    } as never);
    await RefundOperationModel.updateOne(
      { _id: row._id },
      {
        $set: {
          succeededLedgerTransactionId: ledgerId,
          lastReconciledAt: new Date(),
        },
      },
    );
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe("OPEN");
    await BookingFinancialTransactionModel.collection.updateOne(
      { _id: ledgerId },
      { $set: { amountCents: 701 } },
    );
    await monitor.poll(5);
    expect((await RefundOperationModel.findById(row._id))?.recoveryIncident?.state).toBe(
      "RESOLVED",
    );
  });
});
