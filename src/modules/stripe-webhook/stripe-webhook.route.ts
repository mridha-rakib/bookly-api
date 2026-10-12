import express, { Router } from "express";
import { StripeWebhookController } from "./stripe-webhook.controller.js";
import { createStripeWebhookService } from "./stripe-webhook.factory.js";

/**
 * MUST be mounted BEFORE the application's global `express.json()` body parser (see app.ts's own
 * comment on this) — Stripe's signature verification requires the exact RAW request bytes;
 * anything that parses the body first (even to re-stringify it) breaks the signature check.
 * `express.raw({ type: "application/json" })` here is scoped to this one route only, so every
 * other route is unaffected and keeps using the app-level JSON parser as before.
 */
export const createStripeWebhookRoute = (): Router => {
  const router = Router();

  const controller = new StripeWebhookController(createStripeWebhookService());

  router.post(
    "/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    controller.handle,
  );

  return router;
};
