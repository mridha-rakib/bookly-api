import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { EmailService } from "../modules/email/email.service.js";
import { EmailOutboxRepository } from "../modules/email-outbox/email-outbox.repository.js";
import {
  EmailOutboxWorker,
  type EmailWorkerOptions,
} from "../modules/email-outbox/email-outbox-worker.js";
import { InvoiceAttachmentResolver } from "../modules/invoice/invoice-attachment.resolver.js";

/**
 * Runnable entry point for the transactional-email outbox worker (Phase S) — the same shape as
 * scripts/run-no-show-worker.ts. Not a queue framework: the atomic claim + unique dedupe index
 * in EmailOutboxRepository are the correctness guarantee, so running this from one host or
 * several, once or continuously, is all safe.
 *
 *   node dist/scripts/run-email-worker.js --once   # single pass (external scheduler)
 *   node dist/scripts/run-email-worker.js          # poll every EMAIL_WORKER_POLL_INTERVAL_MS
 */
const buildWorker = (): EmailOutboxWorker => {
  const options: EmailWorkerOptions = {
    workerId: `${process.pid}@${process.env["HOSTNAME"] ?? "local"}`,
    maxAttempts: env.EMAIL_WORKER_MAX_ATTEMPTS,
    claimTimeoutMs: env.EMAIL_OUTBOX_CLAIM_TIMEOUT_MS,
    retryBaseMs: env.EMAIL_WORKER_RETRY_BASE_MS,
    concurrency: env.EMAIL_WORKER_CONCURRENCY,
  };
  return new EmailOutboxWorker(
    new EmailOutboxRepository(),
    new EmailService(),
    options,
    () => new Date(),
    new InvoiceAttachmentResolver(),
  );
};

const runOnce = async (worker: EmailOutboxWorker): Promise<void> => {
  const counts = await worker.runOnce(env.EMAIL_WORKER_BATCH_SIZE);
  logger.info({ counts }, "Email worker pass complete");
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
      { intervalMs: env.EMAIL_WORKER_POLL_INTERVAL_MS },
      "Email worker starting continuous polling",
    );

    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      await databaseManager.disconnect();
      logger.info("Email worker stopped");
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    const interval = setInterval(() => {
      runOnce(worker).catch((error: unknown) => {
        logger.error({ err: error }, "Email worker pass failed");
      });
    }, env.EMAIL_WORKER_POLL_INTERVAL_MS);

    await runOnce(worker);
    return;
  } catch (error) {
    logger.error({ err: error }, "Email worker failed to start");
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
