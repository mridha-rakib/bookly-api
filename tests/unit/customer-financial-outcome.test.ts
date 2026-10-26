import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import {
  type CustomerFinancialEvidence,
  projectCustomerFinancialOutcome,
} from "../../src/modules/booking/customer-financial-outcome.projection.js";

const objectId = () => new Types.ObjectId();
/** Synthetic read-only fixtures: intentionally isolated from production writes/state transitions. */
function fixture() {
  const user = objectId(),
    business = objectId(),
    client = objectId(),
    bookingId = objectId();
  const sourceId = objectId(),
    attemptId = objectId(),
    operationId = objectId(),
    refundLedgerId = objectId();
  const now = new Date("2026-10-26T10:00:00Z");
  const booking = {
    _id: bookingId,
    businessId: business,
    source: "BOOKLY_MANAGED",
    customer: { customerUserId: user, businessClientId: client },
    financials: { currency: "EUR" },
    serviceLines: [{ serviceSnapshot: { pricingMode: "HOURLY" }, pricingInput: {} }],
    financialContract: {
      bookingId,
      businessId: business,
      businessClientId: client,
      customerUserId: user,
      productKind: "NORMAL_BOOKING",
      currency: "EUR",
      idempotencyKey: "checkout",
      onlineChargeCents: 2000,
      upfrontLedgerType: "PLATFORM_FEE",
    },
  } as unknown as BookingDocument;
  const scope = {
    bookingId,
    businessId: business,
    businessClientId: client,
    customerUserId: user,
    currency: "EUR",
  };
  const source = {
    ...scope,
    _id: sourceId,
    type: "PLATFORM_FEE",
    direction: "DEBIT",
    amountCents: 2000,
    status: "SUCCEEDED",
    providerReference: "pi_private",
  };
  const attempt = {
    ...scope,
    _id: attemptId,
    purpose: "BOOKING_DEPOSIT",
    logicalIdempotencyKey: "checkout",
    expectedAmountCents: 2000,
    providerPaymentIntentId: "pi_private",
    providerStatus: "SUCCEEDED",
    persistenceStatus: "COMPLETED",
    compensationStatus: "NOT_REQUIRED",
    succeededTransactionId: sourceId,
    clientSecret: "never_public",
    createdAt: now,
    updatedAt: now,
  };
  const operation = {
    ...scope,
    _id: operationId,
    sourceFinancialTransactionId: sourceId,
    sourcePaymentAttemptId: attemptId,
    sourcePaymentIntentId: "pi_private",
    providerRefundId: "re_private",
    expectedRefundAmountCents: 2000,
    providerStatus: "SUCCEEDED",
    succeededLedgerTransactionId: refundLedgerId,
    providerCallStartedAt: now,
    createdAt: now,
    updatedAt: now,
    lastErrorMessage: "private error",
  };
  const refundLedger = {
    ...scope,
    _id: refundLedgerId,
    type: "REFUND",
    direction: "CREDIT",
    amountCents: 2000,
    providerReference: "re_private",
    status: "SUCCEEDED",
    idempotencyKey: `refund-operation:${operationId}:ledger`,
    metadata: { sourceTransactionId: String(sourceId), sourceType: "PLATFORM_FEE" },
  };
  const data = {
    payments: [attempt],
    refunds: [operation],
    relatedAttempts: [attempt],
    duplicateRefunds: [],
    externalRefunds: [],
    disputes: [],
    ledger: [source, refundLedger],
  } as unknown as CustomerFinancialEvidence;
  const read = () => projectCustomerFinancialOutcome(booking, String(user), data, now)!;
  return { booking, scope, now, sourceId, data, read, user };
}

describe("Customer financial allowlist projection (F2D)", () => {
  it("publishes exact correlated observations without secrets/provider or investigation fields", () => {
    const f = fixture();
    const result = f.read();
    expect(result.payments.items[0]).toMatchObject({
      amountCents: 2000,
      providerConfirmed: true,
      accountingConfirmed: true,
    });
    expect(result.refunds.items[0]).toMatchObject({
      origin: "BOOKLY",
      amountCents: 2000,
      providerConfirmed: true,
      accountingConfirmed: true,
    });
    expect(result.payments.items[0]).not.toHaveProperty("lastObservedAt"); // updatedAt is not a provider timestamp
    expect(JSON.stringify(result)).not.toMatch(
      /pi_private|re_private|never_public|private error|providerRefundId|logicalIdempotencyKey|customerUserId/,
    );
  });
  it("refuses foreign ownership, MANUAL, package and unsupported currency contexts", () => {
    const f = fixture();
    expect(
      projectCustomerFinancialOutcome(f.booking, String(objectId()), f.data, f.now),
    ).toBeUndefined();
    f.booking.source = "MANUAL";
    expect(f.read()).toBeUndefined();
    f.booking.source = "BOOKLY_MANAGED";
    f.booking.serviceLines[0]!.serviceSnapshot.pricingMode = "PACKAGE";
    expect(f.read()).toBeUndefined();
  });
  it.each(["businessId", "businessClientId", "customerUserId", "bookingId", "currency"] as const)(
    "omits mismatched %s instead of inferring ownership from amounts",
    (key) => {
      const f = fixture();
      const value = key === "currency" ? "USD" : objectId();
      Object.assign(f.data.payments[0]!, { [key]: value });
      Object.assign(f.data.refunds[0]!, { [key]: value });
      expect(f.read().payments.items).toEqual([]);
      expect(f.read().refunds.items).toEqual([]);
    },
  );
  it.each(["PROCESSING", "UNKNOWN", "REQUIRES_ACTION", "FAILED", "CANCELED"] as const)(
    "preserves %s observations without a successful source/confirmation",
    (state) => {
      const f = fixture();
      const attempt = f.data.payments[0]!;
      attempt.providerStatus = state;
      attempt.persistenceStatus = "NOT_STARTED";
      delete attempt.succeededTransactionId;
      f.data.ledger = [];
      expect(f.read().payments.items[0]).toMatchObject({
        providerStatus: state,
        providerConfirmed: false,
        accountingConfirmed: false,
      });
    },
  );
  it("does not synthesize an operation from refund owed, or treat provider call start as success", () => {
    const f = fixture();
    f.data.refunds = [];
    expect(f.read().refunds.items).toEqual([]);
    const pending = fixture();
    const operation = pending.data.refunds[0]!;
    operation.providerStatus = "CREATED";
    delete operation.providerRefundId;
    delete operation.succeededLedgerTransactionId;
    pending.data.ledger = pending.data.ledger.filter((row) => row.type !== "REFUND");
    expect(pending.read().refunds.items[0]).toMatchObject({
      status: "CREATED",
      providerCallStarted: true,
      providerConfirmed: false,
      accountingConfirmed: false,
    });
  });
  it.each(["PROVIDER_PENDING", "FAILED", "RECONCILIATION_REQUIRED"] as const)(
    "preserves %s refund without false success",
    (state) => {
      const f = fixture();
      f.data.refunds[0]!.providerStatus = state;
      delete f.data.refunds[0]!.succeededLedgerTransactionId;
      f.data.ledger = f.data.ledger.filter((row) => row.type !== "REFUND");
      expect(f.read().refunds.items[0]).toMatchObject({
        status: state,
        providerConfirmed: false,
        accountingConfirmed: false,
      });
    },
  );
  it("distinguishes provider confirmation from missing accounting; rejects contradictory terminal evidence", () => {
    const f = fixture();
    delete f.data.refunds[0]!.succeededLedgerTransactionId;
    f.data.ledger = f.data.ledger.filter((row) => row.type !== "REFUND");
    expect(f.read().refunds.items[0]).toMatchObject({
      providerConfirmed: true,
      accountingConfirmed: false,
    });
    const conflict = fixture();
    conflict.data.ledger.find((row) => row.type === "REFUND")!.status = "FAILED";
    expect(conflict.read().refunds.items).toEqual([]);
  });
  it("requires exact source, amount, provider reference and currency, even for an operation marked succeeded", () => {
    const f = fixture();
    f.data.refunds[0]!.sourcePaymentIntentId = "pi_foreign";
    expect(f.read().refunds.items).toEqual([]);
    const amount = fixture();
    amount.data.refunds[0]!.expectedRefundAmountCents = 3000;
    expect(amount.read().refunds.items).toEqual([]);
    const ledger = fixture();
    ledger.data.ledger[1]!.providerReference = "re_foreign";
    expect(ledger.read().refunds.items).toEqual([]);
  });
  it("publishes distinct external partial refunds once, excludes investigation and deduplicates internal provider identity", () => {
    const f = fixture();
    const source = f.data.ledger[0]!;
    f.data.refunds[0]!.expectedRefundAmountCents = 1000;
    f.data.ledger[1]!.amountCents = 1000;
    const add = (providerId: string, amount: number) => {
      const ledgerId = objectId();
      f.data.ledger.push({
        ...source,
        _id: ledgerId,
        type: "REFUND",
        direction: "CREDIT",
        amountCents: amount,
        providerReference: providerId,
        metadata: {
          sourceTransactionId: String(f.sourceId),
          sourceType: "PLATFORM_FEE",
          refundOrigin: "PROVIDER_EXTERNAL",
        },
      });
      f.data.externalRefunds.push({
        ...f.scope,
        _id: objectId(),
        providerRefundId: providerId,
        providerPaymentIntentId: "pi_private",
        sourceTransactionId: f.sourceId,
        sourceType: "PLATFORM_FEE",
        ledgerTransactionId: ledgerId,
        state: "ACCOUNTED",
        amountCents: amount,
        createdAt: f.now,
        updatedAt: f.now,
        detectedVia: "WEBHOOK",
      });
    };
    add("partial_one", 200);
    add("partial_two", 300);
    add("re_private", 1000);
    expect(f.read().refunds.items).toHaveLength(3); // one internal, two distinct partials
    f.data.externalRefunds[0]!.state = "INVESTIGATION";
    expect(f.read().refunds.items).toHaveLength(2);
    f.data.duplicateRefunds = [{ ...f.data.refunds[0]!, providerRefundId: "partial_two" }];
    expect(f.read().refunds.items).toHaveLength(1); // duplicate outside internal page is excluded too
  });
  it("publishes only correlated disputes and no merchant financial or customer payout fields", () => {
    const f = fixture();
    f.data.disputes = [
      {
        ...f.scope,
        _id: objectId(),
        providerDisputeId: "dp_private",
        providerPaymentIntentId: "pi_private",
        sourceTransactionId: f.sourceId,
        sourceType: "PLATFORM_FEE",
        amountCents: 500,
        providerStatus: "lost",
        final: true,
        outcome: "LOST",
        correlation: "CORRELATED",
        providerCreatedAt: f.now,
        lastSyncedAt: f.now,
        lastSyncedVia: "WEBHOOK",
        createdAt: f.now,
        updatedAt: f.now,
      },
    ];
    expect(f.read().disputes.items[0]).toMatchObject({
      providerStatus: "lost",
      outcome: "LOST",
      amountCents: 500,
    });
    expect(JSON.stringify(f.read())).not.toMatch(/dp_private|netLoss|payout|fundsWithdrawn/);
    f.data.disputes[0]!.correlation = "INVESTIGATION";
    expect(f.read().disputes.items).toEqual([]);
  });
  it("bounds every collection, keeps hasMore and never produces truncated totals", () => {
    const f = fixture();
    f.data.payments = Array.from({ length: 21 }, () => ({
      ...f.data.payments[0]!,
      _id: objectId(),
    }));
    const result = f.read();
    expect(result.payments.items).toHaveLength(20);
    expect(result.payments.hasMore).toBe(true);
    expect(result).not.toHaveProperty("totalRefundedCents");
  });
  it("bounds combined refund/dispute windows and orders genuine partial refunds without collapsing them", () => {
    const f = fixture();
    f.data.refunds = [];
    f.data.ledger = [f.data.ledger[0]!];
    for (let index = 0; index < 21; index++) {
      const ledgerId = objectId(),
        createdAt = new Date(f.now.getTime() - index * 1000);
      f.data.ledger.push({
        ...f.data.ledger[0]!,
        _id: ledgerId,
        type: "REFUND",
        direction: "CREDIT",
        amountCents: 20,
        providerReference: `partial_${index}`,
        metadata: {
          sourceTransactionId: String(f.sourceId),
          sourceType: "PLATFORM_FEE",
          refundOrigin: "PROVIDER_EXTERNAL",
        },
      });
      f.data.externalRefunds.push({
        ...f.scope,
        _id: objectId(),
        providerRefundId: `partial_${index}`,
        providerPaymentIntentId: "pi_private",
        sourceTransactionId: f.sourceId,
        sourceType: "PLATFORM_FEE",
        ledgerTransactionId: ledgerId,
        state: "ACCOUNTED",
        amountCents: 20,
        createdAt,
        updatedAt: createdAt,
        detectedVia: "WEBHOOK",
      });
      f.data.disputes.push({
        ...f.scope,
        _id: objectId(),
        providerDisputeId: `dp_${index}`,
        providerPaymentIntentId: "pi_private",
        sourceTransactionId: f.sourceId,
        sourceType: "PLATFORM_FEE",
        amountCents: 20,
        providerStatus: "under_review",
        final: false,
        correlation: "CORRELATED",
        providerCreatedAt: createdAt,
        lastSyncedAt: createdAt,
        lastSyncedVia: "WEBHOOK",
        createdAt,
        updatedAt: createdAt,
      });
    }
    const result = f.read();
    expect(result.refunds.items).toHaveLength(20);
    expect(result.refunds.hasMore).toBe(true);
    expect(new Set(result.refunds.items.map((row) => row.id)).size).toBe(20);
    expect(result.disputes.items).toHaveLength(20);
    expect(result.disputes.hasMore).toBe(true);
  });
  it("does not mutate any input evidence or the booking during projection", () => {
    const f = fixture();
    const before = JSON.stringify({ booking: f.booking, data: f.data });
    f.read();
    expect(JSON.stringify({ booking: f.booking, data: f.data })).toBe(before);
  });
});
