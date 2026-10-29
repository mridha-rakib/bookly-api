import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingReminderSmsDeliveryEligibility } from "../modules/booking/booking-email-delivery-eligibility.js";
import { createSmsTransport } from "../modules/sms/sms-transport.factory.js";
import { SmsOutboxRepository } from "../modules/sms-outbox/sms-outbox.repository.js";
import { SmsOutboxWorker } from "../modules/sms-outbox/sms-outbox-worker.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

/**
 * The transactional-SMS outbox worker entry point. Same design as run-email-worker.ts /
 * run-appointment-reminder-worker.ts / run-no-show-worker.ts — NOT a queue framework:
 * correctness lives in SmsOutboxRepository's atomic claim + unique dedupe index, never in this
 * loop. Running it once or from many hosts at once is equally safe.
 *
 * Run once (external scheduler):
 *   node dist/scripts/run-sms-worker.js --once
 * Run continuously (polls every SMS_WORKER_POLL_INTERVAL_MS):
 *   node dist/scripts/run-sms-worker.js
 */
const buildWorker = (): SmsOutboxWorker =>
  new SmsOutboxWorker(
    new SmsOutboxRepository(),
    createSmsTransport(),
    {
      workerId: `sms-worker-${process.pid}`,
      maxAttempts: env.SMS_WORKER_MAX_ATTEMPTS,
      claimTimeoutMs: env.SMS_OUTBOX_CLAIM_TIMEOUT_MS,
      retryBaseMs: env.SMS_WORKER_RETRY_BASE_MS,
      concurrency: env.SMS_WORKER_CONCURRENCY,
    },
    () => new Date(),
    new BookingReminderSmsDeliveryEligibility(),
  );

const runOnce = async (
  worker: SmsOutboxWorker,
  shouldStop: () => boolean = () => false,
): Promise<void> => {
  const counts = await worker.runOnce(env.SMS_WORKER_BATCH_SIZE, shouldStop);
  logger.info({ counts }, "SMS worker pass complete");
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const worker = buildWorker();
  const runForever = !process.argv.includes("--once");

  await withWorkerLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () => logger.info("SMS worker stopping: no new claims; draining in-flight work"),
    execute: async (shouldStop, wait) => {
      do {
        if (shouldStop()) break;
        try {
          await runOnce(worker, shouldStop);
        } catch {
          logger.error({ event: "SMS_WORKER_PASS_FAILED" }, "SMS worker pass failed");
          if (!runForever) throw new Error("SMS worker pass failed");
        }
        if (!runForever || shouldStop()) break;
        await wait(env.SMS_WORKER_POLL_INTERVAL_MS);
      } while (!shouldStop());
    },
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch {
    logger.error({ event: "SMS_WORKER_FAILED" }, "SMS worker stopped with failure");
    process.exitCode = 1;
  }
}

export { buildWorker, runOnce };
