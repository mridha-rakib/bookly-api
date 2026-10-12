import { beforeEach, describe, expect, it, vi } from "vitest";

const { retrieveDispute, listDisputes, listRefunds } = vi.hoisted(() => ({
  retrieveDispute: vi.fn(),
  listDisputes: vi.fn(),
  listRefunds: vi.fn(),
}));

vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => ({
    disputes: { retrieve: retrieveDispute, list: listDisputes },
    refunds: { list: listRefunds },
  }),
}));

import { StripePaymentGateway } from "../../src/modules/payment/stripe-payment-gateway.js";

const dispute = (overrides: Record<string, unknown> = {}) => ({
  id: "dp_1",
  charge: "ch_1",
  payment_intent: { id: "pi_1" },
  amount: 2000,
  currency: "eur",
  status: "needs_response",
  reason: "fraudulent",
  evidence_details: { due_by: 1_900_000_000 },
  is_charge_refundable: false,
  created: 1_800_000_000,
  balance_transactions: [
    {
      id: "txn_w",
      amount: -2000,
      fee: 1500,
      currency: "eur",
      created: 1_800_000_010,
      reporting_category: "dispute",
    },
    {
      id: "txn_r",
      amount: 2000,
      fee: -1500,
      currency: "eur",
      created: 1_800_000_020,
      reporting_category: "dispute_reversal",
    },
  ],
  ...overrides,
});

const refund = (id: string, status: string) => ({
  id,
  status,
  payment_intent: "pi_1",
  amount: 500,
  currency: "eur",
  metadata: {},
  created: 1_800_000_000,
});

describe("StripePaymentGateway — P6 disputes and refunds", () => {
  beforeEach(() => {
    retrieveDispute.mockReset();
    listDisputes.mockReset();
    listRefunds.mockReset();
  });

  it("maps a dispute with its signed provider balance transactions exactly (no evidence)", async () => {
    retrieveDispute.mockResolvedValue(dispute());
    const snapshot = await new StripePaymentGateway().retrieveDispute("dp_1");
    expect(snapshot).toEqual({
      disputeId: "dp_1",
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      amountCents: 2000,
      currency: "EUR",
      status: "needs_response",
      reason: "fraudulent",
      evidenceDueAt: new Date(1_900_000_000 * 1000),
      isChargeRefundable: false,
      createdAt: new Date(1_800_000_000 * 1000),
      balanceTransactions: [
        {
          balanceTransactionId: "txn_w",
          amountCents: -2000,
          feeCents: 1500,
          currency: "EUR",
          createdAt: new Date(1_800_000_010 * 1000),
          reportingCategory: "dispute",
        },
        {
          balanceTransactionId: "txn_r",
          amountCents: 2000,
          feeCents: -1500,
          currency: "EUR",
          createdAt: new Date(1_800_000_020 * 1000),
          reportingCategory: "dispute_reversal",
        },
      ],
    });
  });

  it("lists disputes in a bounded created window, paginating and honouring the cap", async () => {
    listDisputes
      .mockResolvedValueOnce({
        data: [dispute({ id: "dp_1" }), dispute({ id: "dp_2" })],
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [dispute({ id: "dp_3" })], has_more: true });
    const since = new Date(1_700_000_000_500);
    const listed = await new StripePaymentGateway().listDisputesCreatedSince(since, 3);
    expect(listed.map((item) => item.disputeId)).toEqual(["dp_1", "dp_2", "dp_3"]);
    expect(listDisputes).toHaveBeenCalledTimes(2);
    expect(listDisputes.mock.calls[0]?.[0]).toMatchObject({
      created: { gte: 1_700_000_000 },
      limit: 100,
    });
    expect(listDisputes.mock.calls[1]?.[0]).toMatchObject({ starting_after: "dp_2" });
  });

  it("lists every refund of a PaymentIntent with its provider time and folds canceled into failed", async () => {
    listRefunds
      .mockResolvedValueOnce({ data: [refund("re_1", "succeeded")], has_more: true })
      .mockResolvedValueOnce({ data: [refund("re_2", "canceled")], has_more: false });
    const refunds = await new StripePaymentGateway().listRefundsForPaymentIntent("pi_1");
    expect(refunds.map((item) => [item.refundId, item.status])).toEqual([
      ["re_1", "succeeded"],
      ["re_2", "failed"],
    ]);
    expect(refunds[0]?.createdAt).toEqual(new Date(1_800_000_000 * 1000));
    expect(listRefunds.mock.calls[0]?.[0]).toMatchObject({ payment_intent: "pi_1", limit: 100 });
    expect(listRefunds.mock.calls[1]?.[0]).toMatchObject({ starting_after: "re_1" });
  });

  it("provider errors surface as a typed retryable error, never a partial result", async () => {
    retrieveDispute.mockRejectedValue(new Error("network down"));
    await expect(new StripePaymentGateway().retrieveDispute("dp_1")).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});
