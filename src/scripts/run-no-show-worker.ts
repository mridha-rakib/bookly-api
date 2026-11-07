import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingRepository } from "../modules/booking/booking.repository.js";
import { NoShowResolutionService } from "../modules/booking/no-show-resolution.service.js";
import { createPenaltyCollectionService } from "../modules/booking/penalty-collection.factory.js";
import { BookingFinancialTransactionRepository } from "../modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../modules/business/business.repository.js";
import { EmailOutboxService } from "../modules/email-outbox/email-outbox.service.js";
import { NoShowNotifier } from "../modules/notification/no-show.notifier.js";
import { PackageProgressRepository } from "../modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../modules/payment/payment.service.js";
import { PaymentAttemptRepository } from "../modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../modules/payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../modules/payment/stripe-payment-gateway.js";
import { UserRepository } from "../modules/user/user.repository.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

type NoShowWorker = Pick<NoShowResolutionService, "runOnce">;

/**
 * The no-show resolution worker's runnable entry point (Batch 4, Phase 8). This process is
 * intentionally NOT a queue framework — the brief itself asks for "a clean service/processor and
 * a safe runnable worker entry point without introducing a huge unrelated queue framework." The
 * actual correctness guarantee lives in `NoShowResolutionService.autoResolve` (CAS on Booking
 * status + the ledger's own unique idempotencyKey index — see that class's own doc comment), NOT
 * in this loop: running this script from multiple hosts/processes simultaneously is safe by
 * construction, and running it exactly once is equally correct. Continuous polling waits for
 * each pass to settle before starting another one; the poll interval is a delay between passes.
 *
 * Run once (e.g. from an external cron/scheduler):
 *   node dist/scripts/run-no-show-worker.js --once
 * Run continuously (polls every NO_SHOW_WORKER_POLL_INTERVAL_MS):
 *   node dist/scripts/run-no-show-worker.js
 */
const buildService = (): NoShowResolutionService => {
  const bookingRepository = new BookingRepository();
  const businessRepository = new BusinessRepository();
  const paymentService = new PaymentService(
    new StripePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    new UserRepository(),
    new PaymentAttemptRepository(),
    new RefundOperationRepository(),
  );
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );

  const packageProgressRepository = new PackageProgressRepository();
  return new NoShowResolutionService(
    bookingRepository,
    businessRepository,
    paymentService,
    financialTransactionService,
    new NoShowNotifier(new EmailOutboxService()),
    packageProgressRepository,
    createPenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      businessRepository,
      packageProgressRepository,
    }),
  );
};

const runOnce = async (
  service: NoShowWorker,
  batchSize = env.NO_SHOW_WORKER_BATCH_SIZE,
  shouldStop: () => boolean = () => false,
): Promise<void> => {
  const counts = await service.runOnce(batchSize, shouldStop);
  if (counts.error > 0) {
    logger.warn({ counts }, "No-show worker pass completed with unresolved item errors");
    return;
  }
  logger.info({ counts }, "No-show worker pass complete");
};

const runContinuous = async (
  service: NoShowWorker,
  shouldStop: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
  batchSize = env.NO_SHOW_WORKER_BATCH_SIZE,
  pollIntervalMs = env.NO_SHOW_WORKER_POLL_INTERVAL_MS,
): Promise<void> => {
  while (!shouldStop()) {
    try {
      await runOnce(service, batchSize, shouldStop);
    } catch {
      logger.error({ event: "NO_SHOW_WORKER_PASS_FAILED" }, "No-show worker pass failed");
    }
    if (!shouldStop()) await wait(pollIntervalMs);
  }
};

export const runNoShowWorkerLifecycle = async (options: {
  service: NoShowWorker;
  runForever: boolean;
  signals: NodeJS.Process;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  batchSize: number;
  pollIntervalMs: number;
  shutdownTimeoutMs: number;
  onShutdownTimeout: () => void;
}): Promise<void> => {
  await withWorkerLifecycle({
    signals: options.signals,
    connect: options.connect,
    disconnect: options.disconnect,
    onStopping: () =>
      logger.info("No-show worker stopping: no new candidate claims; draining the active item"),
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    onShutdownTimeout: options.onShutdownTimeout,
    execute: async (shouldStop, wait) => {
      logger.info({ mode: options.runForever ? "continuous" : "once" }, "No-show worker started");
      if (options.runForever) {
        await runContinuous(
          options.service,
          shouldStop,
          wait,
          options.batchSize,
          options.pollIntervalMs,
        );
      } else if (!shouldStop()) {
        await runOnce(options.service, options.batchSize, shouldStop);
      }
    },
  });
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const service = buildService();
  const runForever = !process.argv.includes("--once");

  try {
    await runNoShowWorkerLifecycle({
      service,
      runForever,
      signals: process,
      connect: () => databaseManager.connect(),
      disconnect: () => databaseManager.disconnect(),
      batchSize: env.NO_SHOW_WORKER_BATCH_SIZE,
      pollIntervalMs: env.NO_SHOW_WORKER_POLL_INTERVAL_MS,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      onShutdownTimeout: () => {
        logger.error(
          { timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
          "No-show worker drain exceeded the configured shutdown grace period",
        );
        process.exit(1);
      },
    });
    logger.info("No-show worker stopped");
  } catch (error) {
    logger.error({ err: error }, "No-show worker failed");
    throw error;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

export { buildService, runContinuous, runOnce };
