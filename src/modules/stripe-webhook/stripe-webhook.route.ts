import express, { Router } from "express";

import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { StripeWebhookController } from "./stripe-webhook.controller.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "./stripe-webhook-event.repository.js";

/**
 * MUST be mounted BEFORE the application's global `express.json()` body parser (see app.ts's own
 * comment on this) — Stripe's signature verification requires the exact RAW request bytes;
 * anything that parses the body first (even to re-stringify it) breaks the signature check.
 * `express.raw({ type: "application/json" })` here is scoped to this one route only, so every
 * other route is unaffected and keeps using the app-level JSON parser as before.
 */
export const createStripeWebhookRoute = (): Router => {
  const router = Router();

  const gateway = new StripePaymentGateway();
  const eventRepository = new StripeWebhookEventRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const webhookService = new StripeWebhookService(
    gateway,
    eventRepository,
    financialTransactionService,
  );
  const controller = new StripeWebhookController(webhookService);

  router.post(
    "/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    controller.handle,
  );

  return router;
};
