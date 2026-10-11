import { beforeEach, describe, expect, it, vi } from "vitest";

const { retrievePaymentIntent } = vi.hoisted(() => ({
  retrievePaymentIntent: vi.fn(),
}));

vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => ({
    paymentIntents: { retrieve: retrievePaymentIntent },
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
