import { pathToFileURL } from "node:url";

import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingRepository } from "../modules/booking/booking.repository.js";
import { createPenaltyCollectionService } from "../modules/booking/penalty-collection.factory.js";
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
import {
  parseRefundIncidentAlertPolicy,
  RefundRecoveryIncidentService,
} from "../modules/payment/refund-recovery-incident.js";
import { StripePaymentGateway } from "../modules/payment/stripe-payment-gateway.js";
import { createProviderReversalService } from "../modules/provider-reversal/provider-reversal.factory.js";
import { StripeWebhookService } from "../modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserRepository } from "../modules/user/user.repository.js";

import {
  assertMoneyRecoveryLaunch,
  MoneyRecoveryLaunchError,
  withMoneyRecoveryLifecycle,
} from "./money-recovery-runtime.js";

const POLL_INTERVAL_MS = 30_000;

const buildService = (): MoneyRecoveryService => {
  const incidentAlertPolicy = parseRefundIncidentAlertPolicy(process.env);
  if (!incidentAlertPolicy)
    logger.warn(
      { event: "REFUND_RECOVERY_INCIDENT_ALERTS_UNCONFIGURED" },
      "Refund incidents are durable and logged; explicit alert recipients and thresholds are not configured",
    );
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
  const penaltyCollection = createPenaltyCollectionService({
    paymentService,
    financialTransactionService: financials,
    bookingRepository,
    packageProgressRepository,
  });
  const relationshipService = createFinancialRelationshipService({
    paymentAttemptRepository: attempts,
    refundOperationRepository: refunds,
    bookingRepository,
  });
  const providerReversals = createProviderReversalService({
    gateway,
    financialTransactionService: financials,
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
    penaltyCollection,
    providerReversals,
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
    penaltyCollection,
    providerReversals,
    new RefundRecoveryIncidentService(incidentAlertPolicy),
  );
};

const runOnce = async (service: MoneyRecoveryService): Promise<void> => {
  const counts = await service.runOnce();
  if (counts.errors > 0 || counts.webhooksFailed > 0) {
    logger.warn({ counts }, "Money recovery worker pass completed with unresolved errors");
  } else {
    logger.info({ counts }, "Money recovery worker pass complete");
  }
};

const runContinuous = async (
  service: MoneyRecoveryService,
  shouldStop: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  while (!shouldStop()) {
    try {
      await runOnce(service);
    } catch {
      logger.error({ event: "MONEY_RECOVERY_PASS_FAILED" }, "Money recovery worker pass failed");
    }
    if (!shouldStop()) await wait(POLL_INTERVAL_MS);
  }
};

const runCli = async (): Promise<void> => {
  // env.ts still validates the shared application configuration; these checks add launch intent.
  assertMoneyRecoveryLaunch(process.env, process.argv.slice(2));
  const databaseManager = new DatabaseManager();
  const runForever = !process.argv.includes("--once");
  await withMoneyRecoveryLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () => logger.info("Money recovery worker stopping after the active pass"),
    execute: async (shouldStop, wait) => {
      const service = buildService();
      logger.info({ mode: runForever ? "continuous" : "once" }, "Money recovery worker started");
      if (runForever) {
        await runContinuous(service, shouldStop, wait);
      } else if (!shouldStop()) {
        await runOnce(service);
      }
    },
  });
  logger.info("Money recovery worker stopped");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    // Never serialize raw provider/connection exceptions or environment values here.
    logger.error(
      {
        event: "MONEY_RECOVERY_WORKER_EXIT",
        reason:
          error instanceof MoneyRecoveryLaunchError
            ? error.message
            : "STARTUP_OR_EXECUTION_FAILURE",
      },
      "Money recovery worker could not continue",
    );
    process.exitCode = 1;
  }
}

export { buildService, runContinuous, runOnce };
