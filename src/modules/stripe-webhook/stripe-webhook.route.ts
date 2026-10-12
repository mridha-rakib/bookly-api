import express, { Router } from "express";
import { BookingRepository } from "../booking/booking.repository.js";
import { createPenaltyCollectionService } from "../booking/penalty-collection.factory.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentService } from "../payment/payment.service.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { PaymentTaxAssociationReconciler } from "../payment/payment-tax-association-reconciler.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { UserRepository } from "../user/user.repository.js";
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
  const bookingRepository = new BookingRepository();
  const paymentAttemptRepository = new PaymentAttemptRepository();
  const refundOperationRepository = new RefundOperationRepository();
  const packageProgressRepository = new PackageProgressRepository();
  const paymentService = new PaymentService(
    gateway,
    new CustomerPaymentProfileRepository(),
    new UserRepository(),
    paymentAttemptRepository,
    refundOperationRepository,
  );
  const webhookService = new StripeWebhookService(
    gateway,
    eventRepository,
    financialTransactionService,
    new PaymentTaxAssociationReconciler(gateway, bookingRepository),
    paymentAttemptRepository,
    refundOperationRepository,
    packageProgressRepository,
    bookingRepository,
    createFinancialRelationshipService({
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
    }),
    createPenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      packageProgressRepository,
    }),
  );
  const controller = new StripeWebhookController(webhookService);

  router.post(
    "/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    controller.handle,
  );

  return router;
};
