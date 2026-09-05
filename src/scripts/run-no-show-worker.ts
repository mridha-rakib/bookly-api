import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingRepository } from "../modules/booking/booking.repository.js";
import { NoShowResolutionService } from "../modules/booking/no-show-resolution.service.js";
import { BookingFinancialTransactionRepository } from "../modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../modules/business/business.repository.js";
import { EmailOutboxService } from "../modules/email-outbox/email-outbox.service.js";
import { NoShowNotifier } from "../modules/notification/no-show.notifier.js";
import { PackageProgressRepository } from "../modules/package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../modules/payment/payment.service.js";
import { StripePaymentGateway } from "../modules/payment/stripe-payment-gateway.js";
import { UserRepository } from "../modules/user/user.repository.js";

/**
 * The no-show resolution worker's runnable entry point (Batch 4, Phase 8). This process is
 * intentionally NOT a queue framework — the brief itself asks for "a clean service/processor and
 * a safe runnable worker entry point without introducing a huge unrelated queue framework." The
 * actual correctness guarantee lives in `NoShowResolutionService.autoResolve` (CAS on Booking
 * status + the ledger's own unique idempotencyKey index — see that class's own doc comment), NOT
 * in this loop: running this script from multiple hosts/processes simultaneously is safe by
 * construction, and running it exactly once is equally correct. `setInterval` here is only a
 * convenience for continuous operation in an environment with no external scheduler, never the
 * source of correctness.
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
  );
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );

  return new NoShowResolutionService(
    bookingRepository,
    businessRepository,
    paymentService,
    financialTransactionService,
    new NoShowNotifier(new EmailOutboxService()),
    new PackageProgressRepository(),
  );
};

const runOnce = async (service: NoShowResolutionService): Promise<void> => {
  const counts = await service.runOnce(env.NO_SHOW_WORKER_BATCH_SIZE);
  logger.info({ counts }, "No-show worker pass complete");
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

    logger.info(
      { intervalMs: env.NO_SHOW_WORKER_POLL_INTERVAL_MS },
      "No-show worker starting continuous polling",
    );

    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      await databaseManager.disconnect();
      logger.info("No-show worker stopped");
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    const interval = setInterval(() => {
      runOnce(service).catch((error: unknown) => {
        logger.error({ err: error }, "No-show worker pass failed");
      });
    }, env.NO_SHOW_WORKER_POLL_INTERVAL_MS);

    // Run an immediate first pass rather than waiting a full interval.
    await runOnce(service);
    return;
  } catch (error) {
    logger.error({ err: error }, "No-show worker failed to start");
    throw error;
  } finally {
    if (!runForever) {
      await databaseManager.disconnect();
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

export { buildService, runOnce };
