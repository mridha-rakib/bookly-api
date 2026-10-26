import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  secret: "whsec_f3b_synthetic_local_signature_only",
  process: vi.fn(async (_event: unknown): Promise<boolean> => true),
}));

vi.mock("../../src/config/env.js", () => ({
  env: { NODE_ENV: "test", STRIPE_WEBHOOK_SECRET: fixture.secret },
}));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../src/modules/payment/stripe-client.js", async () => {
  const { default: Stripe } = await import("stripe");
  // Only local webhook signature verification is invoked. No network method is used.
  const client = new Stripe("sk_test_synthetic_local_verification_only");
  return { getStripeClient: () => client };
});
vi.mock("../../src/modules/stripe-webhook/stripe-webhook.factory.js", async () => {
  const { StripePaymentGateway } = await import(
    "../../src/modules/payment/stripe-payment-gateway.js"
  );
  return {
    createStripeWebhookService: () => ({
      verifyAndParse: (body: Buffer, signature: string) =>
        new StripePaymentGateway().constructWebhookEvent(body, signature),
      process: fixture.process,
    }),
  };
});

import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { createStripeWebhookRoute } from "../../src/modules/stripe-webhook/stripe-webhook.route.js";

const raw =
  '{ "id": "evt_f3b_synthetic", "type": "setup_intent.succeeded", "data": {"object": {"id": "seti_synthetic"}} }';
const signedHeader = () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", fixture.secret).update(`${timestamp}.${raw}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
};
const app = (parseFirst = false) => {
  const instance = express();
  if (parseFirst) instance.use(express.json());
  instance.use("/payments/webhooks", createStripeWebhookRoute());
  instance.use(express.json());
  instance.use(createErrorHandler());
  return instance;
};

describe("F3B actual webhook route/controller + offline SDK signature boundary", () => {
  beforeEach(() => {
    fixture.process.mockReset().mockResolvedValue(true);
  });

  it("accepts the signed original bytes, then acknowledges processing", async () => {
    const response = await request(app())
      .post("/payments/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signedHeader())
      .send(raw);
    expect(response.status).toBe(200);
    expect(fixture.process).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt_f3b_synthetic" }),
    );
  });

  it("rejects invalid signatures and never dispatches the event", async () => {
    const response = await request(app())
      .post("/payments/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=0,v1=invalid")
      .send(raw);
    expect(response.status).toBe(400);
    expect(fixture.process).not.toHaveBeenCalled();
  });

  it("rejects a missing signature or an already parsed body", async () => {
    expect(
      (
        await request(app())
          .post("/payments/webhooks/stripe")
          .set("Content-Type", "application/json")
          .send(raw)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app(true))
          .post("/payments/webhooks/stripe")
          .set("Content-Type", "application/json")
          .set("stripe-signature", signedHeader())
          .send(raw)
      ).status,
    ).toBe(400);
    expect(fixture.process).not.toHaveBeenCalled();
  });

  it("acknowledges an already-claimed/ignored event without promising financial completion", async () => {
    fixture.process.mockResolvedValue(false);
    const response = await request(app())
      .post("/payments/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signedHeader())
      .send(raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: "Webhook received" });
    // Actual durable deduplication/leases are tested by the existing DB suites.
  });

  it("returns a generic 500 for processing failure, allowing redelivery without exposing payloads", async () => {
    fixture.process.mockRejectedValue(new Error("synthetic-private-provider-error"));
    const response = await request(app())
      .post("/payments/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signedHeader())
      .send(raw);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: "Webhook processing failed" });
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private");
  });
});
