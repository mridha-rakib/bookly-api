import { pathToFileURL } from "node:url";

import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingRepository } from "../modules/booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { createFinancialRelationshipService } from "../modules/client/financial-relationship.factory.js";
import { PackageProgressRepository } from "../modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../modules/payment/money-recovery.service.js";
import { PaymentService } from "../modules/payment/payment.service.js";
import { PaymentAttemptRepository } from "../modules/payment/payment-attempt.repository.js";
import { PaymentTaxAssociationReconciler } from "../modules/payment/payment-tax-association-reconciler.js";
import { RefundOperationRepository } from "../modules/payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../modules/payment/stripe-payment-gateway.js";
import { StripeWebhookService } from "../modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserRepository } from "../modules/user/user.repository.js";

const POLL_INTERVAL_MS = 30_000;

const buildService = (): MoneyRecoveryService => {
  const gateway = new StripePaymentGateway();
  const attempts = new PaymentAttemptRepository();
  const refunds = new RefundOperationRepository();
  const bookingRepository = new BookingRepository();
  const financials = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const packageProgressRepository = new PackageProgressRepository();
  const paymentService = new PaymentService(
    gateway,
    new CustomerPaymentProfileRepository(),
    new UserRepository(),
    attempts,
    refunds,
  );
  const relationshipService = createFinancialRelationshipService({
    paymentAttemptRepository: attempts,
    refundOperationRepository: refunds,
    bookingRepository,
  });
  const webhookService = new StripeWebhookService(
    gateway,
    new StripeWebhookEventRepository(),
    financials,
    new PaymentTaxAssociationReconciler(gateway, bookingRepository),
    attempts,
    refunds,
    packageProgressRepository,
    bookingRepository,
    relationshipService,
  );
  return new MoneyRecoveryService(
    paymentService,
    attempts,
    refunds,
    bookingRepository,
    financials,
    webhookService,
    packageProgressRepository,
    relationshipService,
  );
};

const runOnce = async (service: MoneyRecoveryService): Promise<void> => {
  const counts = await service.runOnce();
  logger.info({ counts }, "Money recovery worker pass complete");
};

const runContinuous = async (
  service: MoneyRecoveryService,
  shouldStop: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  while (!shouldStop()) {
    try {
      await runOnce(service);
    } catch (error) {
      logger.error({ err: error }, "Money recovery worker pass failed");
    }
    if (!shouldStop()) await wait(POLL_INTERVAL_MS);
  }
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const service = buildService();
  const runForever = !process.argv.includes("--once");
  try {
    await databaseManager.connect();
    if (!runForever) {
      await runOnce(service);
      return;
    }
    let stopping = false;
    let releaseWait: (() => void) | undefined;
    const shutdown = (): void => {
      stopping = true;
      releaseWait?.();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await runContinuous(
      service,
      () => stopping,
      (milliseconds) =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            releaseWait = undefined;
            resolve();
          }, milliseconds);
          releaseWait = () => {
            clearTimeout(timeout);
            releaseWait = undefined;
            resolve();
          };
        }),
    );
  } finally {
    await databaseManager.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

export { buildService, runContinuous, runOnce };
