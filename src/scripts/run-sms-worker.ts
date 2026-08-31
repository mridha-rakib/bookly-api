import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { createSmsTransport } from "../modules/sms/sms-transport.factory.js";
import { SmsOutboxRepository } from "../modules/sms-outbox/sms-outbox.repository.js";
import { SmsOutboxWorker } from "../modules/sms-outbox/sms-outbox-worker.js";

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
  new SmsOutboxWorker(new SmsOutboxRepository(), createSmsTransport(), {
    workerId: `sms-worker-${process.pid}`,
    maxAttempts: env.SMS_WORKER_MAX_ATTEMPTS,
    claimTimeoutMs: env.SMS_OUTBOX_CLAIM_TIMEOUT_MS,
    retryBaseMs: env.SMS_WORKER_RETRY_BASE_MS,
    concurrency: env.SMS_WORKER_CONCURRENCY,
  });

const runOnce = async (worker: SmsOutboxWorker): Promise<void> => {
  const counts = await worker.runOnce(env.SMS_WORKER_BATCH_SIZE);
  logger.info({ counts }, "SMS worker pass complete");
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const worker = buildWorker();
  const runForever = !process.argv.includes("--once");

  try {
    await databaseManager.connect();

    if (!runForever) {
      await runOnce(worker);
      return;
    }

    logger.info(
      { intervalMs: env.SMS_WORKER_POLL_INTERVAL_MS },
      "SMS worker starting continuous polling",
    );

    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      await databaseManager.disconnect();
      logger.info("SMS worker stopped");
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    const interval = setInterval(() => {
      runOnce(worker).catch((error: unknown) => {
        logger.error({ err: error }, "SMS worker pass failed");
      });
    }, env.SMS_WORKER_POLL_INTERVAL_MS);

    await runOnce(worker);
    return;
  } catch (error) {
    logger.error({ err: error }, "SMS worker failed to start");
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

export { buildWorker, runOnce };
