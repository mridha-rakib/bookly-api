import { beforeEach, describe, expect, it, vi } from "vitest";

const { retrievePaymentIntent, listPaymentIntents } = vi.hoisted(() => ({
  retrievePaymentIntent: vi.fn(),
  listPaymentIntents: vi.fn(),
}));

vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => ({
    paymentIntents: { retrieve: retrievePaymentIntent, list: listPaymentIntents },
  }),
}));

import { StripePaymentGateway } from "../../src/modules/payment/stripe-payment-gateway.js";

const paymentIntent = (overrides: Record<string, unknown>) => ({
  id: "pi_lifecycle",
  amount: 2000,
  currency: "eur",
  customer: "cus_1",
  metadata: {},
  latest_charge: null,
  client_secret: "pi_lifecycle_secret",
  cancellation_reason: null,
  ...overrides,
});

describe("StripePaymentGateway — P1.1 PaymentIntent lifecycle mapping", () => {
  beforeEach(() => {
    retrievePaymentIntent.mockReset();
  });

  it("maps a canceled PaymentIntent to the terminal `canceled` status with its reason", async () => {
    retrievePaymentIntent.mockResolvedValue(
      paymentIntent({ status: "canceled", cancellation_reason: "abandoned" }),
    );

    const snapshot = await new StripePaymentGateway().retrievePaymentIntent("pi_lifecycle");

    expect(snapshot).toMatchObject({
      paymentIntentId: "pi_lifecycle",
      status: "canceled",
      cancellationReason: "abandoned",
    });
    expect(snapshot.clientSecret).toBeUndefined();
  });

  it("keeps requires_payment_method as the re-confirmable `failed` status (never `canceled`)", async () => {
    retrievePaymentIntent.mockResolvedValue(paymentIntent({ status: "requires_payment_method" }));

    const snapshot = await new StripePaymentGateway().retrievePaymentIntent("pi_lifecycle");

    expect(snapshot.status).toBe("failed");
    expect(snapshot.cancellationReason).toBeUndefined();
  });

  it("keeps requires_action, processing and succeeded unchanged", async () => {
    const gateway = new StripePaymentGateway();
    for (const [status, expected] of [
      ["requires_action", "requires_action"],
      ["processing", "processing"],
      ["succeeded", "succeeded"],
    ] as const) {
      retrievePaymentIntent.mockResolvedValueOnce(paymentIntent({ status }));
      expect((await gateway.retrievePaymentIntent("pi_lifecycle")).status).toBe(expected);
    }
  });
});

describe("StripePaymentGateway — P1.1.1 strongly consistent PaymentIntent existence check", () => {
  const attemptId = "65f000000000000000000001";
  const input = {
    stripeCustomerId: "cus_1",
    paymentAttemptId: attemptId,
    createdSince: new Date("2030-01-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    listPaymentIntents.mockReset();
  });

  it("lists the Customer's PaymentIntents since the cutoff (never search) across pages and matches the attempt id locally", async () => {
    listPaymentIntents
      .mockResolvedValueOnce({
        data: [
          paymentIntent({ id: "pi_other", status: "succeeded", metadata: {} }),
          paymentIntent({
            id: "pi_unrelated",
            status: "succeeded",
            metadata: { booklyPaymentAttemptId: "65f000000000000000000002" },
          }),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          paymentIntent({
            id: "pi_match",
            status: "requires_action",
            metadata: { booklyPaymentAttemptId: attemptId },
          }),
        ],
        has_more: false,
      });

    const lookup = await new StripePaymentGateway().findCustomerPaymentIntentByAttempt(input);

    expect(lookup).toMatchObject({
      outcome: "FOUND_ONE",
      value: { paymentIntentId: "pi_match", status: "requires_action", customerId: "cus_1" },
    });
    expect(listPaymentIntents).toHaveBeenNthCalledWith(1, {
      customer: "cus_1",
      created: { gte: Math.floor(input.createdSince.getTime() / 1000) },
      limit: 100,
    });
    expect(listPaymentIntents).toHaveBeenNthCalledWith(2, {
      customer: "cus_1",
      created: { gte: Math.floor(input.createdSince.getTime() / 1000) },
      limit: 100,
      starting_after: "pi_unrelated",
    });
  });

  it("returns NOT_FOUND when no PaymentIntent carries the attempt id, AMBIGUOUS for more than one", async () => {
    listPaymentIntents.mockResolvedValueOnce({ data: [], has_more: false });
    expect(await new StripePaymentGateway().findCustomerPaymentIntentByAttempt(input)).toEqual({
      outcome: "NOT_FOUND",
    });

    listPaymentIntents.mockResolvedValueOnce({
      data: ["pi_a", "pi_b"].map((id) =>
        paymentIntent({ id, status: "succeeded", metadata: { booklyPaymentAttemptId: attemptId } }),
      ),
      has_more: false,
    });
    expect(await new StripePaymentGateway().findCustomerPaymentIntentByAttempt(input)).toEqual({
      outcome: "AMBIGUOUS",
    });
  });

  it("surfaces provider errors instead of treating them as absence", async () => {
    listPaymentIntents.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" }),
    );
    await expect(
      new StripePaymentGateway().findCustomerPaymentIntentByAttempt(input),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
